package com.ioxpert.tarazu;

import static com.ioxpert.tarazu.Ops.m;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import com.ioxpert.tarazu.tenancy.UuidV7;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessException;
import org.springframework.http.MediaType;

/**
 * Structural guardrails (CLAUDE.md locked rules 2-4) that fail the build when a future migration forgets them,
 * plus proof against real data that one tenant can never see or write another's rows.
 */
class SchemaGuardIT extends ApiIT {

	/** Platform-owned reference data (docs/adr/0003): the only tables without tenant_id. */
	private static final Set<String> GLOBAL_TABLES = Set.of("tax_rule", "tax_threshold");
	private static final Set<String> NOT_OURS = Set.of("flyway_schema_history");

	/** Evidence tables: rows are never updated or deleted, by anyone. */
	private static final Set<String> APPEND_ONLY = Set.of("operation_log", "audit_log", "entity_registry", "price_version",
			"party_merge", "stock_movement", "invoice", "invoice_line", "credit_note", "purchase_receipt", "order_transition",
			"payment", "khata_entry", "consent_event", "third_party_sharing_log", "tax_rule");

	/** The tenant table is its own tenant: keyed by id. */
	private static String tenantColumn(String table) {
		return "tenant".equals(table) ? "id" : "tenant_id";
	}

	private List<String> tenantTables() {
		return jdbc.queryForList("""
				SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
				WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1
				""", String.class).stream().filter(t -> !NOT_OURS.contains(t) && !GLOBAL_TABLES.contains(t)).toList();
	}

	@Test
	void theApiRoleIsNotASuperuserNorTheOwnerNorBypassesRls() {
		var role = jdbc.queryForMap("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
		assertThat(role.get("rolsuper")).isEqualTo(false);
		assertThat(role.get("rolbypassrls")).isEqualTo(false);
		assertThat(jdbc.queryForList("""
				SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
				WHERE n.nspname = 'public' AND c.relkind = 'r' AND pg_get_userbyid(c.relowner) = current_user
				""", String.class)).as("the API owns no tables").isEmpty();
	}

	@Test
	void everyTenantTableHasTenantIdAndForcedRowLevelSecurityWithAPolicy() {
		for (String table : tenantTables()) {
			var rls = jdbc.queryForMap("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = ('public.' || ?)::regclass", table);
			assertThat(rls.get("relrowsecurity")).as("%s: ROW LEVEL SECURITY enabled", table).isEqualTo(true);
			assertThat(rls.get("relforcerowsecurity")).as("%s: FORCE ROW LEVEL SECURITY", table).isEqualTo(true);
			assertThat(jdbc.queryForObject("SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = ?", Long.class, table))
					.as("%s has a policy", table).isGreaterThan(0);
			assertThat(jdbc.queryForObject("""
					SELECT count(*) FROM information_schema.columns
					WHERE table_schema = 'public' AND table_name = ? AND column_name = ? AND is_nullable = 'NO'
					""", Long.class, table, tenantColumn(table))).as("%s has NOT NULL tenant_id", table).isEqualTo(1);
		}
		for (String table : GLOBAL_TABLES) {
			assertThat(jdbc.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = ('public.' || ?)::regclass", Boolean.class, table))
					.as("%s: global tables still have FORCE RLS (read-only policy)", table).isTrue();
		}
	}

	@Test
	void viewsRunWithTheCallersRowLevelSecurity() {
		var views = jdbc.queryForList("""
				SELECT c.relname, coalesce(c.reloptions::text, '') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
				WHERE n.nspname = 'public' AND c.relkind = 'v'
				""");
		assertThat(views).isNotEmpty();
		for (var view : views) {
			assertThat(view.get("coalesce")).as("view %s", view.get("relname")).asString().contains("security_invoker=true");
		}
	}

	@Test
	void everyForeignKeyBetweenTenantTablesIsCompositeSoARowCannotPointAtAnotherTenantsParent() {
		var tenantTables = Set.copyOf(tenantTables());
		var fks = jdbc.queryForList("""
				SELECT con.conname, src.relname AS src, dst.relname AS dst,
				       (SELECT array_agg(a.attname::text) FROM unnest(con.conkey) k JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k) AS cols
				FROM pg_constraint con
				JOIN pg_class src ON src.oid = con.conrelid JOIN pg_class dst ON dst.oid = con.confrelid
				JOIN pg_namespace n ON n.oid = src.relnamespace
				WHERE con.contype = 'f' AND n.nspname = 'public'
				""");
		int checked = 0;
		for (var fk : fks) {
			String src = (String) fk.get("src");
			String dst = (String) fk.get("dst");
			if (!tenantTables.contains(src) || !tenantTables.contains(dst) || dst.equals("tenant")) {
				continue;
			}
			String cols = fk.get("cols").toString();
			assertThat(cols).as("FK %s (%s -> %s) must include tenant_id", fk.get("conname"), src, dst).contains("tenant_id");
			checked++;
		}
		assertThat(checked).as("sanity: the check actually saw composite FKs").isGreaterThan(30);
	}

	@Test
	void evidenceTablesAreProtectedByTriggerAndTheApiRoleHasNoDeleteAnywhereButUserRole() {
		for (String table : APPEND_ONLY) {
			assertThat(jdbc.queryForObject("""
					SELECT count(*) FROM pg_trigger WHERE tgrelid = ('public.' || ?)::regclass AND tgname = 'append_only' AND NOT tgisinternal
					""", Long.class, table)).as("%s has the append_only trigger", table).isEqualTo(1);
		}
		assertThat(jdbc.queryForList("""
				SELECT DISTINCT table_name FROM information_schema.role_table_grants
				WHERE grantee = current_user AND privilege_type = 'DELETE' AND table_schema = 'public'
				""", String.class)).containsExactly("user_role");
		assertThat(jdbc.queryForList("""
				SELECT DISTINCT table_name FROM information_schema.role_table_grants
				WHERE grantee = current_user AND privilege_type IN ('UPDATE', 'INSERT', 'DELETE', 'TRUNCATE')
				  AND table_schema = 'public' AND table_name IN ('stock_balance', 'khata_balance', 'tax_rule', 'tax_threshold')
				""", String.class)).as("projections and rule tables are read-only for the API").isEmpty();
	}

	// ---------- real data, two tenants ----------

	private void populateEverything(Seed s) throws Exception {
		var d = new Ops(s);
		UUID product = UUID.randomUUID();
		UUID party = UUID.randomUUID();
		UUID party2 = UUID.randomUUID();
		UUID invoice = UUID.randomUUID();
		UUID order = UUID.randomUUID();
		Map<String, Object> line = m("productId", product, "qtyMilli", 1000, "unitPricePaise", 100, "taxRateBp", 0, "taxPaise", 0, "lineTotalPaise", 100);
		var res = upload(s, d.product(product, "P"), d.party(party, "A"), d.party(party2, "B"),
				d.create("price_version", UUID.randomUUID(), m("productId", product, "priceType", "mrp", "amountPaise", 100, "effectiveFrom", "2026-01-01T00:00:00Z")),
				d.create("party_merge", UUID.randomUUID(), m("sourcePartyId", party2, "targetPartyId", party)),
				d.stock(UUID.randomUUID(), product, -1000, "sale"),
				d.khata(UUID.randomUUID(), party, "debit", 100),
				d.create("payment", UUID.randomUUID(), m("partyId", party, "direction", "in", "mode", "cash", "amountPaise", 50)),
				d.create("invoice", invoice, m("series", "S", "number", 1, "docType", "retail_invoice", "invoiceDate", "2026-10-17",
						"subtotalPaise", 100, "totalPaise", 100, "lines", List.of(line))),
				d.create("credit_note", UUID.randomUUID(), m("series", "CN", "number", 1, "invoiceId", invoice, "reason", "r", "totalPaise", 10)),
				d.create("purchase_receipt", UUID.randomUUID(), m("series", "P", "number", 1, "receiptDate", "2026-10-17", "totalPaise", 10)),
				d.create("order", order, m()), d.create("order_transition", UUID.randomUUID(), m("orderId", order, "toState", "confirmed")),
				d.create("order_transition", UUID.randomUUID(), m("orderId", order, "toState", "delivered")),
				d.create("product", UUID.randomUUID(), m("unit", "pcs")),
				d.stock(UUID.randomUUID(), UUID.randomUUID(), 1, "opening"));
		assertThat(res.get("rejected").asInt()).isEqualTo(1);
		assertThat(res.get("deferred").asInt()).isEqualTo(1);

		var consent = new LinkedHashMap<String, Object>();
		consent.put("operationId", UuidV7.next());
		consent.put("idempotencyKey", "c-" + s.tenant());
		consent.put("subjectType", "party");
		consent.put("subjectId", party);
		consent.put("purpose", "credit_assessment");
		consent.put("action", "grant");
		consent.put("policyVersion", "v1");
		consent.put("channel", "paper");
		consent.put("occurredAt", Instant.now().toString());
		mvc.perform(post("/v1/consent/events").header("X-Tenant-Id", s.tenant()).header("X-Staff-Id", s.owner())
				.contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(consent))).andExpect(status().isOk());
		var share = new LinkedHashMap<String, Object>(consent);
		share.put("operationId", UuidV7.next());
		share.put("idempotencyKey", "s-" + s.tenant());
		share.put("recipient", "Lender");
		share.put("dataCategories", List.of("summary"));
		share.put("sharedAt", Instant.now().toString());
		mvc.perform(post("/v1/consent/sharing-log").header("X-Tenant-Id", s.tenant()).header("X-Staff-Id", s.owner())
				.contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(share))).andExpect(status().isOk());
		mvc.perform(put("/v1/consent/mode").header("X-Tenant-Id", s.tenant()).header("X-Staff-Id", s.owner())
				.contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("localOnly", false, "reason", "confirm"))))
				.andExpect(status().isOk());
	}

	@Test
	void oneTenantNeverSeesOrWritesAnotherTenantsRowsInAnyTable() throws Exception {
		Seed a = seedTenant();
		Seed b = seedTenant();
		populateEverything(a);
		populateEverything(b);

		for (String table : tenantTables()) {
			String col = tenantColumn(table);
			long ownRows = count(a, "SELECT count(*) FROM " + table + " WHERE " + col + " = ?", a.tenant());
			if (!table.equals("tenant_setting") || ownRows > 0) {
				assertThat(ownRows).as("scenario populates %s (extend populateEverything when adding a table)", table).isGreaterThan(0);
			}
			assertThat(count(a, "SELECT count(*) FROM " + table + " WHERE " + col + " <> ?", a.tenant()))
					.as("%s: tenant A sees only its own rows", table).isZero();
			assertThat(count(b, "SELECT count(*) FROM " + table + " WHERE " + col + " <> ?", b.tenant()))
					.as("%s: tenant B sees only its own rows", table).isZero();
		}
		assertThat(count(a, "SELECT count(*) FROM tenant")).isEqualTo(1);
		tx.executeWithoutResult(s -> {
			for (String table : tenantTables()) {
				assertThat(jdbc.queryForObject("SELECT count(*) FROM " + table, Long.class)).as("%s: no tenant bound sees nothing", table).isZero();
			}
		});

		// writes: a row for another tenant is refused by the RLS WITH CHECK, even with a perfectly valid parent
		assertThatThrownBy(() -> inTenant(b.tenant(), () -> jdbc.update("INSERT INTO product (id, tenant_id, name) VALUES (?, ?, 'sneaky')", UUID.randomUUID(), a.tenant())))
				.isInstanceOf(DataAccessException.class);
		assertThatThrownBy(() -> inTenant(b.tenant(), () -> jdbc.update("INSERT INTO audit_log (id, tenant_id, action) VALUES (?, ?, 'forged')", UuidV7.next(), a.tenant())))
				.isInstanceOf(DataAccessException.class);
		// updates reach nothing across tenants
		assertThat(inTenant(b.tenant(), () -> jdbc.update("UPDATE product SET name = 'hijacked' WHERE tenant_id = ?", a.tenant()))).isZero();
		assertThat(inTenant(b.tenant(), () -> jdbc.update("UPDATE business SET gst_mode = 'composition' WHERE id = ?", a.business()))).isZero();
		// and a composite foreign key stops B's row from pointing at A's parent
		UUID aProduct = inTenant(a.tenant(), () -> jdbc.queryForObject("SELECT id FROM product LIMIT 1", UUID.class));
		assertThatThrownBy(() -> inTenant(b.tenant(), () -> jdbc.update(
				"INSERT INTO stock_movement (id, tenant_id, store_id, product_id, qty_milli, reason, device_id, hlc, operation_id, occurred_at) VALUES (?, ?, ?, ?, 1, 'opening', ?, 'x', ?, now())",
				UUID.randomUUID(), b.tenant(), b.store(), aProduct, b.device(), UUID.randomUUID()))).isInstanceOf(DataAccessException.class);
	}

	@Test
	void projectionsMatchTheirEventsForEveryTenant() throws Exception {
		Seed a = seedTenant();
		populateEverything(a);
		assertThat(inTenant(a.tenant(), () -> jdbc.queryForList("SELECT projection FROM verify_projections()", String.class))).isEmpty();
	}
}
