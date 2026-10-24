package com.ioxpert.tarazu.catalogue;

import static com.ioxpert.tarazu.Ops.m;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.ioxpert.tarazu.AdminSql;
import com.ioxpert.tarazu.ApiIT;
import com.ioxpert.tarazu.Ops;
import com.ioxpert.tarazu.Seed;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.env.Environment;
import org.springframework.dao.DataAccessException;
import tools.jackson.databind.JsonNode;

/** Product fields, units of measure, duplicate barcodes, customer prices and the platform product master. */
class CatalogueIT extends ApiIT {

	@Autowired Environment env;

	private static Map<String, Object> at(Map<String, Object> op, long millis, int counter, String node) {
		Map<String, Object> copy = new LinkedHashMap<>(op);
		copy.put("hlc", Ops.hlc(millis, counter, node));
		return copy;
	}

	private static Map<String, Object> uom(String base, Object... unitQty) {
		List<Map<String, Object>> units = new java.util.ArrayList<>();
		for (int i = 0; i < unitQty.length; i += 2) {
			units.add(m("unit", unitQty[i], "qtyMilli", unitQty[i + 1]));
		}
		return m("base", base, "units", units);
	}

	private List<String> openFlags(Seed seed) {
		return inTenant(seed.tenant(), () -> jdbc.queryForList("SELECT kind FROM conflict_flag WHERE status = 'open' ORDER BY kind", String.class));
	}

	private Map<String, Object> product(Seed seed, UUID id) {
		return inTenant(seed.tenant(), () -> jdbc.queryForMap("SELECT *, uom::text AS uom_text FROM product WHERE id = ?", id));
	}

	// ---------- product fields ----------

	@Test
	void allNewProductFieldsAreStoredWithTheirDefaults() throws Exception {
		Seed seed = seedTenant();
		var d = new Ops(seed);
		UUID full = UUID.randomUUID();
		UUID bare = UUID.randomUUID();
		var res = upload(seed,
				d.create("product", full, m("name", "Parle-G", "localName", "पारले-जी", "brand", "Parle", "category", "Biscuits",
						"packSku", "PARLEG-100", "unit", "packet", "uom", uom("piece", "packet", 12000, "case", 288000),
						"taxInclusive", false, "taxRateBp", 1800, "loose", true, "pinned", true, "hsn", "1905")),
				d.create("product", bare, m("name", "Plain")));
		assertThat(statusOf(res, 0)).isEqualTo("applied");
		var row = product(seed, full);
		assertThat(row.get("local_name")).isEqualTo("पारले-जी");
		assertThat(row.get("brand")).isEqualTo("Parle");
		assertThat(row.get("category")).isEqualTo("Biscuits");
		assertThat(row.get("pack_sku")).isEqualTo("PARLEG-100");
		assertThat(row.get("unit")).isEqualTo("packet");
		assertThat(row.get("tax_inclusive")).isEqualTo(false);
		assertThat(row.get("tax_rate_bp")).isEqualTo(1800);
		assertThat(row.get("loose")).isEqualTo(true);
		assertThat(row.get("pinned")).isEqualTo(true);
		JsonNode uom = json.readTree((String) row.get("uom_text"));
		assertThat(uom.get("base").asString()).isEqualTo("piece");
		assertThat(uom.get("units").get(1).get("qtyMilli").asLong()).isEqualTo(288000);

		var defaults = product(seed, bare);
		assertThat(defaults.get("unit")).as("column default is now 'piece'").isEqualTo("piece");
		assertThat(defaults.get("tax_inclusive")).isEqualTo(true);
		assertThat(defaults.get("loose")).isEqualTo(false);
		assertThat(defaults.get("pinned")).isEqualTo(false);
		assertThat(defaults.get("tax_rate_bp")).isNull();
		assertThat(defaults.get("uom")).isNull();
	}

	@Test
	void newFieldsMergeByHlcPerFieldIncludingTheJsonbUom() throws Exception {
		Seed seed = seedTenant();
		var a = new Ops(seed);
		var b = new Ops(seed, addDevice(seed), null);
		UUID id = UUID.randomUUID();
		upload(seed, at(a.create("product", id, m("name", "Atta", "brand", "Aashirvaad", "pinned", false, "uom", uom("kg", "g", 1))), 1000, 0, "devA"));
		upload(seed, at(b.op("product", id, "update", m("brand", "Pillsbury", "pinned", true, "uom", uom("kg", "g", 1, "bag", 10000), "taxRateBp", 500)), 3000, 0, "devB"));
		// device A's older edits arrive late: they lose per field, the untouched field (category) still lands
		upload(seed,
				at(a.op("product", id, "update", m("brand", "Stale", "pinned", false, "uom", uom("kg"), "category", "Flour", "taxRateBp", 0)), 2000, 0, "devA"));
		var row = product(seed, id);
		assertThat(row.get("brand")).isEqualTo("Pillsbury");
		assertThat(row.get("pinned")).isEqualTo(true);
		assertThat(row.get("tax_rate_bp")).isEqualTo(500);
		assertThat(row.get("category")).isEqualTo("Flour");
		assertThat(json.readTree((String) row.get("uom_text")).get("units").size()).isEqualTo(2);

		// a newer write may clear nullable fields, uom included
		upload(seed, at(b.op("product", id, "update", m("uom", null, "taxRateBp", null, "brand", null)), 4000, 0, "devB"));
		var cleared = product(seed, id);
		assertThat(cleared.get("uom")).isNull();
		assertThat(cleared.get("tax_rate_bp")).isNull();
		assertThat(cleared.get("brand")).isNull();
	}

	@Test
	void invalidUnitsAndUomSpecsAreRejectedAsInvalidPayload() throws Exception {
		Seed seed = seedTenant();
		var d = new Ops(seed);
		List<Map<String, Object>> bad = List.of(
				m("name", "x", "unit", "pcs"),
				m("name", "x", "uom", uom("furlong")),
				m("name", "x", "uom", uom("piece", "packet", 0)),
				m("name", "x", "uom", uom("piece", "packet", -12)),
				m("name", "x", "uom", uom("piece", "packet", 12000, "packet", 6000)),
				m("name", "x", "uom", uom("piece", "carton", 1, "box", 2, "bag", 3, "case", 4, "dozen", 5, "strip", 6, "bottle", 7, "packet", 8, "g", 9)),
				m("name", "x", "uom", uom("piece", "crate", 5)),
				m("name", "x", "uom", uom("piece", "piece", 5)),
				m("name", "x", "uom", "kg"),
				m("name", "x", "taxRateBp", 10001),
				m("name", "x", "taxRateBp", -1));
		Map<String, Object>[] ops = bad.stream().map(p -> d.create("product", UUID.randomUUID(), p)).toArray(Map[]::new);
		var res = upload(seed, ops);
		for (int i = 0; i < ops.length; i++) {
			assertThat(statusOf(res, i)).as("payload %d", i).isEqualTo("rejected");
			assertThat(res.get("results").get(i).get("code").asString()).isEqualTo("invalid_payload");
		}
		var edge = upload(seed, d.create("product", UUID.randomUUID(), m("name", "ok", "unit", "kg",
				"uom", uom("kg", "g", 1, "ml", 1, "bag", 25000, "box", 1, "case", 1, "carton", 1, "bundle", 1, "dozen", 1), "taxRateBp", 10000)));
		assertThat(statusOf(edge, 0)).as("exactly 8 units and rate 10000 are fine").isEqualTo("applied");
		assertThat(count(seed, "SELECT count(*) FROM product")).isEqualTo(1);
	}

	@Test
	void aQuintalIsAnAcceptedUnitAndKeepsItsSizeInKilos() throws Exception {
		Seed seed = seedTenant();
		var d = new Ops(seed);
		UUID id = UUID.randomUUID();
		var res = upload(seed, d.create("product", id, m("name", "Bajra", "unit", "kg", "uom", uom("kg", "quintal", 100_000))));
		assertThat(statusOf(res, 0)).isEqualTo("applied");
		assertThat(json.readTree((String) product(seed, id).get("uom_text")).get("units").get(0).get("unit").asString()).isEqualTo("quintal");
	}

	@Test
	void existingRowsKeepTheirLegacyUnitText() throws Exception {
		Seed seed = seedTenant();
		UUID id = UUID.randomUUID();
		inTenant(seed.tenant(), () -> jdbc.update("INSERT INTO product (id, tenant_id, name, unit) VALUES (?, ?, 'Legacy', 'pcs')", id, seed.tenant()));
		upload(seed, new Ops(seed).op("product", id, "update", m("brand", "B")));
		assertThat(product(seed, id).get("unit")).isEqualTo("pcs");
	}

	// ---------- duplicate barcodes ----------

	@Test
	void aSharedBarcodeIsFlaggedNotRejectedAndTheFlagClosesWhenTheDuplicateGoes() throws Exception {
		Seed seed = seedTenant();
		var d = new Ops(seed);
		UUID p1 = UUID.randomUUID();
		UUID p2 = UUID.randomUUID();
		UUID p3 = UUID.randomUUID();
		var res = upload(seed,
				d.create("product", p1, m("name", "Soap A", "barcode", "8901234567890")),
				d.create("product", p2, m("name", "Soap B", "barcode", "8901234567890")),
				d.create("product", p3, m("name", "Other", "barcode", "8909999999999")));
		assertThat(statusOf(res, 0)).isEqualTo("applied");
		assertThat(statusOf(res, 1)).isEqualTo("flagged");
		assertThat(res.get("results").get(1).get("code").asString()).isEqualTo("duplicate_barcode");
		assertThat(statusOf(res, 2)).isEqualTo("applied");
		assertThat(count(seed, "SELECT count(*) FROM product WHERE barcode = '8901234567890'")).as("never rejected").isEqualTo(2);
		assertThat(openFlags(seed)).containsExactly("duplicate_barcode");

		// an unrelated edit of a duplicate keeps the flag (one open flag per barcode, no pile-up)
		upload(seed, d.op("product", p2, "update", m("brand", "B")));
		assertThat(count(seed, "SELECT count(*) FROM conflict_flag WHERE kind = 'duplicate_barcode'")).isEqualTo(1);

		// deactivating one holder resolves it
		upload(seed, d.op("product", p2, "void", m()));
		assertThat(openFlags(seed)).isEmpty();
		assertThat(count(seed, "SELECT count(*) FROM conflict_flag WHERE kind = 'duplicate_barcode' AND status = 'resolved'")).isEqualTo(1);
	}

	@Test
	void changingTheBarcodeOfADuplicateResolvesTheOldFlagAndCanRaiseANewOne() throws Exception {
		Seed seed = seedTenant();
		var d = new Ops(seed);
		UUID p1 = UUID.randomUUID();
		UUID p2 = UUID.randomUUID();
		UUID p3 = UUID.randomUUID();
		upload(seed, d.create("product", p1, m("name", "A", "barcode", "111111")), d.create("product", p2, m("name", "B", "barcode", "111111")),
				d.create("product", p3, m("name", "C", "barcode", "222222")));
		assertThat(openFlags(seed)).containsExactly("duplicate_barcode");
		var res = upload(seed, d.op("product", p2, "update", m("barcode", "222222")));
		assertThat(res.get("results").get(0).get("code").asString()).isEqualTo("duplicate_barcode");
		assertThat(count(seed, "SELECT count(*) FROM conflict_flag WHERE kind = 'duplicate_barcode' AND scope_key = '111111' AND status = 'resolved'")).isEqualTo(1);
		assertThat(count(seed, "SELECT count(*) FROM conflict_flag WHERE kind = 'duplicate_barcode' AND scope_key = '222222' AND status = 'open'")).isEqualTo(1);
	}

	@Test
	void theSameBarcodeInAnotherTenantIsNotADuplicate() throws Exception {
		Seed a = seedTenant();
		Seed b = seedTenant();
		upload(a, new Ops(a).create("product", UUID.randomUUID(), m("name", "A", "barcode", "5551212")));
		var res = upload(b, new Ops(b).create("product", UUID.randomUUID(), m("name", "A", "barcode", "5551212")));
		assertThat(statusOf(res, 0)).isEqualTo("applied");
		assertThat(openFlags(b)).isEmpty();
	}

	// ---------- customer prices ----------

	@Test
	void customerPricesNeedAPartyAndResolveByPartyAndDate() throws Exception {
		Seed seed = seedTenant();
		var d = new Ops(seed);
		UUID product = UUID.randomUUID();
		UUID ramesh = UUID.randomUUID();
		UUID suresh = UUID.randomUUID();
		var res = upload(seed, d.product(product, "Oil"), d.party(ramesh, "Ramesh"), d.party(suresh, "Suresh"),
				d.create("price_version", UUID.randomUUID(), m("productId", product, "priceType", "retail", "amountPaise", 15000, "effectiveFrom", "2026-01-01T00:00:00Z")),
				d.create("price_version", UUID.randomUUID(), m("productId", product, "priceType", "customer", "partyId", ramesh, "amountPaise", 14000, "effectiveFrom", "2026-01-01T00:00:00Z")),
				d.create("price_version", UUID.randomUUID(), m("productId", product, "priceType", "customer", "partyId", ramesh, "amountPaise", 13000, "effectiveFrom", "2026-10-01T00:00:00Z")),
				d.create("price_version", UUID.randomUUID(), m("productId", product, "priceType", "customer", "partyId", suresh, "amountPaise", 14500, "effectiveFrom", "2026-01-01T00:00:00Z")),
				d.create("price_version", UUID.randomUUID(), m("productId", product, "priceType", "customer", "amountPaise", 1, "effectiveFrom", "2026-01-01T00:00:00Z")),
				d.create("price_version", UUID.randomUUID(), m("productId", product, "priceType", "retail", "partyId", ramesh, "amountPaise", 1, "effectiveFrom", "2026-01-01T00:00:00Z")));
		for (int i = 0; i < 7; i++) {
			assertThat(statusOf(res, i)).as("op %d", i).isEqualTo("applied");
		}
		assertThat(res.get("results").get(7).get("code").asString()).isEqualTo("invalid_payload");
		assertThat(res.get("results").get(8).get("code").asString()).isEqualTo("invalid_payload");

		assertThat(inTenant(seed.tenant(), () -> jdbc.queryForObject("SELECT price_as_of_party(?, ?, '2026-06-01T00:00:00Z')", Long.class, product, ramesh))).isEqualTo(14000);
		assertThat(inTenant(seed.tenant(), () -> jdbc.queryForObject("SELECT price_as_of_party(?, ?, '2026-10-17T00:00:00Z')", Long.class, product, ramesh))).isEqualTo(13000);
		assertThat(inTenant(seed.tenant(), () -> jdbc.queryForObject("SELECT price_as_of_party(?, ?, '2026-10-17T00:00:00Z')", Long.class, product, suresh))).isEqualTo(14500);
		assertThat(inTenant(seed.tenant(), () -> jdbc.queryForObject("SELECT price_as_of(?, 'retail', '2026-10-17T00:00:00Z')", Long.class, product))).as("customer rows never leak into store-wide prices").isEqualTo(15000);
		assertThat(inTenant(seed.tenant(), () -> jdbc.queryForObject("SELECT price_as_of(?, 'customer', '2026-10-17T00:00:00Z')", Long.class, product))).isNull();
	}

	@Test
	void aCustomerPriceWaitsForItsPartyAndTheDatabaseEnforcesTheCustomerPartyRule() throws Exception {
		Seed seed = seedTenant();
		var d = new Ops(seed);
		UUID product = UUID.randomUUID();
		UUID party = UUID.randomUUID();
		var res = upload(seed, d.product(product, "Oil"),
				d.create("price_version", UUID.randomUUID(), m("productId", product, "priceType", "customer", "partyId", party, "amountPaise", 1, "effectiveFrom", "2026-01-01T00:00:00Z")));
		assertThat(statusOf(res, 1)).isEqualTo("deferred");
		upload(seed, d.party(party, "Late"));
		assertThat(count(seed, "SELECT count(*) FROM price_version WHERE party_id = ?", party)).isEqualTo(1);

		assertThatThrownBy(() -> inTenant(seed.tenant(), () -> jdbc.update(
				"INSERT INTO price_version (id, tenant_id, product_id, price_type, amount_paise, effective_from, hlc, operation_id) VALUES (?, ?, ?, 'customer', 1, now(), 'x', ?)",
				UUID.randomUUID(), seed.tenant(), product, UUID.randomUUID()))).isInstanceOf(DataAccessException.class);
		assertThatThrownBy(() -> inTenant(seed.tenant(), () -> jdbc.update(
				"INSERT INTO price_version (id, tenant_id, product_id, party_id, price_type, amount_paise, effective_from, hlc, operation_id) VALUES (?, ?, ?, ?, 'retail', 1, now(), 'x', ?)",
				UUID.randomUUID(), seed.tenant(), product, party, UUID.randomUUID()))).isInstanceOf(DataAccessException.class);
	}

	// ---------- platform product master ----------

	private String freshBarcode() {
		return "9" + String.format("%012d", (long) (Math.random() * 1_000_000_000_000L));
	}

	@Test
	void masterLookupReturnsTheGlobalRowForAnyTenantAnd404ForAnUnknownOrMalformedBarcode() throws Exception {
		var admin = AdminSql.of(env);
		String barcode = freshBarcode();
		admin.update("""
				INSERT INTO master_product (barcode, name, local_name, brand, category, hsn, mrp_paise, unit, uom)
				VALUES (?, 'Parle-G 100g', 'Parle-G', 'Parle', 'Biscuits', '1905', 1000, 'packet', '{"base":"piece","units":[{"unit":"packet","qtyMilli":12000}]}'::jsonb)
				""", barcode);
		Seed a = seedTenant();
		Seed b = seedTenant();
		for (Seed s : List.of(a, b)) {
			mvc.perform(get("/v1/catalogue/master/" + barcode).header("X-Tenant-Id", s.tenant()))
					.andExpect(status().isOk()).andExpect(jsonPath("$.barcode").value(barcode)).andExpect(jsonPath("$.name").value("Parle-G 100g"))
					.andExpect(jsonPath("$.localName").value("Parle-G")).andExpect(jsonPath("$.brand").value("Parle"))
					.andExpect(jsonPath("$.hsn").value("1905")).andExpect(jsonPath("$.mrpPaise").value(1000)).andExpect(jsonPath("$.unit").value("packet"))
					.andExpect(jsonPath("$.uom.base").value("piece")).andExpect(jsonPath("$.uom.units[0].qtyMilli").value(12000));
		}
		mvc.perform(get("/v1/catalogue/master/" + barcode.substring(0, 13) + "x").header("X-Tenant-Id", a.tenant()))
				.andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("no_master_product"));
		mvc.perform(get("/v1/catalogue/master/00000000").header("X-Tenant-Id", a.tenant()))
				.andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("no_master_product"));
		mvc.perform(get("/v1/catalogue/master/" + barcode)).andExpect(status().isUnauthorized());
	}

	@Test
	void masterProductWithOnlyANameHasNullOptionalFieldsAndTheApiRoleCannotWriteIt() throws Exception {
		var admin = AdminSql.of(env);
		String barcode = freshBarcode();
		admin.update("INSERT INTO master_product (barcode, name) VALUES (?, 'Bare')", barcode);
		Seed seed = seedTenant();
		mvc.perform(get("/v1/catalogue/master/" + barcode).header("X-Tenant-Id", seed.tenant()))
				.andExpect(status().isOk()).andExpect(jsonPath("$.name").value("Bare")).andExpect(jsonPath("$.uom").doesNotExist())
				.andExpect(jsonPath("$.mrpPaise").doesNotExist()).andExpect(jsonPath("$.unit").value("piece"));
		assertThatThrownBy(() -> jdbc.update("INSERT INTO master_product (barcode, name) VALUES ('123456789012', 'sneaky')")).isInstanceOf(DataAccessException.class);
		assertThatThrownBy(() -> jdbc.update("UPDATE master_product SET name = 'x'")).isInstanceOf(DataAccessException.class);
		assertThatThrownBy(() -> jdbc.update("DELETE FROM master_product")).isInstanceOf(DataAccessException.class);
	}
}
