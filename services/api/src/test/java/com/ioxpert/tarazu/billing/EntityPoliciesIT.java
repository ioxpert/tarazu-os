package com.ioxpert.tarazu.billing;

import static com.ioxpert.tarazu.Ops.m;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

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
import org.springframework.jdbc.core.JdbcTemplate;
import tools.jackson.databind.JsonNode;

/** One test per conflict policy in docs/adr/0002: what each entity does when devices disagree or misbehave. */
class EntityPoliciesIT extends ApiIT {

	@Autowired Environment env;

	private List<String> openFlags(Seed seed) {
		return inTenant(seed.tenant(), () -> jdbc.queryForList("SELECT kind FROM conflict_flag WHERE status = 'open' ORDER BY kind", String.class));
	}

	private static Map<String, Object> at(Map<String, Object> op, long millis, int counter, String node) {
		Map<String, Object> copy = new LinkedHashMap<>(op);
		copy.put("hlc", Ops.hlc(millis, counter, node));
		return copy;
	}

	private void assertProjectionsConsistent(Seed seed) {
		assertThat(inTenant(seed.tenant(), () -> jdbc.queryForList("SELECT projection || ' ' || key FROM verify_projections()", String.class)))
				.as("projections equal the sum of their events").isEmpty();
	}

	// ---------- catalogue ----------

	@Test
	void productFieldsMergeByHlcSoNewestWritePerFieldWinsRegardlessOfArrivalOrder() throws Exception {
		Seed seed = seedTenant();
		var a = new Ops(seed);
		var b = new Ops(seed, addDevice(seed), null);
		UUID id = UUID.randomUUID();

		upload(seed, at(a.create("product", id, m("name", "Salt", "barcode", "111")), 1000, 0, "devA"));
		// device B renames at t=3000, device A (offline) fixes the barcode at t=2000 and also renames at t=1500
		upload(seed, at(b.op("product", id, "update", m("name", "Tata Salt")), 3000, 0, "devB"));
		var late = upload(seed,
				at(a.op("product", id, "update", m("barcode", "222")), 2000, 0, "devA"),
				at(a.op("product", id, "update", m("name", "Stale Salt")), 1500, 0, "devA"));
		assertThat(statusOf(late, 0)).isEqualTo("applied");
		assertThat(statusOf(late, 1)).isEqualTo("applied");

		var row = inTenant(seed.tenant(), () -> jdbc.queryForMap("SELECT name, barcode FROM product WHERE id = ?", id));
		assertThat(row.get("name")).as("newest name write wins, the stale one is ignored").isEqualTo("Tata Salt");
		assertThat(row.get("barcode")).as("different field from a different device also survives").isEqualTo("222");
	}

	@Test
	void productVoidDeactivatesAndNeverDeletes() throws Exception {
		Seed seed = seedTenant();
		var d = new Ops(seed);
		UUID id = UUID.randomUUID();
		upload(seed, d.product(id, "Old"), d.op("product", id, "void", m()));
		assertThat(inTenant(seed.tenant(), () -> jdbc.queryForObject("SELECT active FROM product WHERE id = ?", Boolean.class, id))).isFalse();
	}

	@Test
	void pricesAreEffectiveDatedAndAppendOnly() throws Exception {
		Seed seed = seedTenant();
		var d = new Ops(seed);
		UUID product = UUID.randomUUID();
		UUID p1 = UUID.randomUUID();
		UUID p2 = UUID.randomUUID();
		var res = upload(seed, d.product(product, "Oil"),
				d.create("price_version", p1, m("productId", product, "priceType", "retail", "amountPaise", 12000, "effectiveFrom", "2026-01-01T00:00:00Z")),
				d.create("price_version", p2, m("productId", product, "priceType", "retail", "amountPaise", 13500, "effectiveFrom", "2026-10-01T00:00:00Z")),
				d.op("price_version", p1, "update", m("amountPaise", 1)));
		assertThat(statusOf(res, 3)).isEqualTo("rejected");
		assertThat(res.get("results").get(3).get("code").asString()).isEqualTo("append_only");

		assertThat(inTenant(seed.tenant(), () -> jdbc.queryForObject("SELECT price_as_of(?, 'retail', '2026-06-01T00:00:00Z')", Long.class, product))).isEqualTo(12000);
		assertThat(inTenant(seed.tenant(), () -> jdbc.queryForObject("SELECT price_as_of(?, 'retail', '2026-10-17T00:00:00Z')", Long.class, product))).isEqualTo(13500);
		assertThat(inTenant(seed.tenant(), () -> jdbc.queryForObject("SELECT price_as_of(?, 'retail', '2025-01-01T00:00:00Z')", Long.class, product))).isNull();
	}

	@Test
	void aPhoneOrGstinHeldByAnotherPartyIsFlaggedNotRejectedAndNotMerged() throws Exception {
		Seed seed = seedTenant();
		var d = new Ops(seed);
		UUID a = UUID.randomUUID();
		UUID b = UUID.randomUUID();
		// separate requests: within one batch the gateway applies in lock order, so "the second one" is not defined
		var first = upload(seed, d.create("party", a, m("name", "Ramesh", "phone", "+91 98765 43210")));
		var res = upload(seed,
				d.create("party", b, m("name", "Ramesh K", "phone", "09876543210", "gstin", "27AAPFU0939F1ZV")),
				d.create("party", UUID.randomUUID(), m("name", "Bad GSTIN", "gstin", "NOTAGSTIN")));
		assertThat(statusOf(first, 0)).isEqualTo("applied");
		assertThat(statusOf(res, 0)).isEqualTo("flagged");
		assertThat(res.get("results").get(0).get("code").asString()).contains("party_identity_conflict");

		assertThat(count(seed, "SELECT count(*) FROM party")).as("never auto-merged").isEqualTo(3);
		assertThat(count(seed, "SELECT count(*) FROM party WHERE phone = '9876543210'")).isEqualTo(2);
		assertThat(openFlags(seed)).containsExactly("invalid_gstin", "party_identity_conflict");
	}

	@Test
	void partyMergeKeepsProvenanceAndAConflictingMergeIsFlaggedNotApplied() throws Exception {
		Seed seed = seedTenant();
		var d = new Ops(seed);
		UUID a = UUID.randomUUID();
		UUID b = UUID.randomUUID();
		UUID m1 = UUID.randomUUID();
		UUID m2 = UUID.randomUUID();
		var res = upload(seed, d.party(a, "A"), d.party(b, "B"),
				d.create("party_merge", m1, m("sourcePartyId", a, "targetPartyId", b, "reason", "same shop")),
				d.create("party_merge", m2, m("sourcePartyId", b, "targetPartyId", a)));
		assertThat(statusOf(res, 2)).isEqualTo("applied");
		assertThat(statusOf(res, 3)).isEqualTo("flagged");

		assertThat(inTenant(seed.tenant(), () -> jdbc.queryForObject("SELECT merged_into FROM party WHERE id = ?", UUID.class, a))).isEqualTo(b);
		assertThat(inTenant(seed.tenant(), () -> jdbc.queryForObject("SELECT merged_into FROM party WHERE id = ?", UUID.class, b))).isNull();
		assertThat(inTenant(seed.tenant(), () -> jdbc.queryForList("SELECT applied FROM party_merge", Boolean.class)))
				.containsExactlyInAnyOrder(true, false);
		var provenance = inTenant(seed.tenant(), () -> jdbc.queryForObject("SELECT provenance::text FROM party_merge WHERE id = ?", String.class, m1));
		assertThat(provenance).contains("\"name\": \"A\"").contains("deviceId").contains("hlc");
		assertThat(openFlags(seed)).containsExactly("party_merge_conflict");
		assertThat(count(seed, "SELECT count(*) FROM audit_log WHERE action = 'party.merged'")).isEqualTo(1);
	}

	// ---------- inventory ----------

	@Test
	void twoOfflineCountersSellingTheLastThreeUnitsBothPersistAndStockShowsMinusThreeOversold() throws Exception {
		Seed seed = seedTenant();
		var counter1 = new Ops(seed);
		var counter2 = new Ops(seed, addDevice(seed), null);
		UUID product = UUID.randomUUID();
		upload(seed, counter1.product(product, "Last stock item"), counter1.stock(UUID.randomUUID(), product, 3000, "opening"));

		// both counters were offline and each saw 3 in stock
		var r1 = upload(seed, counter1.stock(UUID.randomUUID(), product, -3000, "sale"));
		var r2 = upload(seed, counter2.stock(UUID.randomUUID(), product, -3000, "sale"));
		assertThat(statusOf(r1, 0)).isEqualTo("applied");
		assertThat(statusOf(r2, 0)).as("the second sale is not rejected: it happened").isEqualTo("flagged");

		var balance = inTenant(seed.tenant(), () -> jdbc.queryForMap("SELECT qty_milli, oversold FROM stock_balance WHERE product_id = ?", product));
		assertThat(balance.get("qty_milli")).isEqualTo(-3000L);
		assertThat(balance.get("oversold")).isEqualTo(true);
		assertThat(count(seed, "SELECT count(*) FROM stock_movement WHERE product_id = ?", product)).isEqualTo(3);
		assertThat(openFlags(seed)).containsExactly("oversold");

		// a purchase brings it back; the flag closes itself
		upload(seed, counter1.stock(UUID.randomUUID(), product, 10_000, "purchase"));
		assertThat(count(seed, "SELECT qty_milli FROM stock_balance WHERE product_id = ?", product)).isEqualTo(7000);
		assertThat(openFlags(seed)).isEmpty();
		assertProjectionsConsistent(seed);
	}

	@Test
	void stockMovementsAreAppendOnlyAndTheProjectionCannotBeWrittenByTheApp() throws Exception {
		Seed seed = seedTenant();
		var d = new Ops(seed);
		UUID product = UUID.randomUUID();
		UUID movement = UUID.randomUUID();
		var res = upload(seed, d.product(product, "X"), d.stock(movement, product, 1000, "opening"),
				d.op("stock_movement", movement, "update", m("qtyMilli", 99)),
				d.stock(UUID.randomUUID(), product, 0, "adjustment"),
				d.stock(UUID.randomUUID(), product, 5, "teleport"));
		assertThat(res.get("results").get(2).get("code").asString()).isEqualTo("append_only");
		assertThat(res.get("results").get(3).get("code").asString()).isEqualTo("invalid_payload");
		assertThat(res.get("results").get(4).get("code").asString()).isEqualTo("invalid_payload");

		assertThatThrownBy(() -> inTenant(seed.tenant(), () -> jdbc.update("UPDATE stock_movement SET qty_milli = 1"))).isInstanceOf(DataAccessException.class);
		assertThatThrownBy(() -> inTenant(seed.tenant(), () -> jdbc.update("DELETE FROM stock_movement"))).isInstanceOf(DataAccessException.class);
		assertThatThrownBy(() -> inTenant(seed.tenant(), () -> jdbc.update("UPDATE stock_balance SET qty_milli = 999999")))
				.as("projection is trigger-maintained, the app role has no write grant").isInstanceOf(DataAccessException.class);
		assertThatThrownBy(() -> inTenant(seed.tenant(), () -> jdbc.update(
				"INSERT INTO stock_balance (tenant_id, store_id, product_id, qty_milli, movement_count) VALUES (?, ?, ?, 1, 1)",
				seed.tenant(), seed.store(), UUID.randomUUID()))).isInstanceOf(DataAccessException.class);
	}

	// ---------- ledger ----------

	@Test
	void aCreditLimitIsAdviceNotARefusal() throws Exception {
		Seed seed = seedTenant();
		var d = new Ops(seed);
		UUID party = UUID.randomUUID();
		upload(seed, d.party(party, "Verma"), d.op("party", party, "update", m("creditLimitPaise", 100_000)));
		var over = upload(seed, d.khata(UUID.randomUUID(), party, "debit", 120_000));
		assertThat(statusOf(over, 0)).as("recorded and flagged for review, never rejected").isEqualTo("flagged");
		assertThat(openFlags(seed)).contains("credit_limit_exceeded");
		assertThat(count(seed, "SELECT balance_paise FROM khata_balance WHERE party_id = ?", party)).isEqualTo(120_000);

		upload(seed, d.khata(UUID.randomUUID(), party, "credit", 30_000));
		assertThat(openFlags(seed)).as("back under the limit closes the flag").doesNotContain("credit_limit_exceeded");

		UUID noLimit = UUID.randomUUID();
		upload(seed, d.party(noLimit, "Walk-in regular"), d.khata(UUID.randomUUID(), noLimit, "debit", 9_000_000));
		assertThat(openFlags(seed)).doesNotContain("credit_limit_exceeded");
	}

	@Test
	void khataBalanceIsTheSumOfAppendOnlyEntriesAndPaymentsAreImmutable() throws Exception {
		Seed seed = seedTenant();
		var d = new Ops(seed);
		UUID party = UUID.randomUUID();
		UUID pay = UUID.randomUUID();
		upload(seed, d.party(party, "Sharma ji"),
				d.khata(UUID.randomUUID(), party, "debit", 50_000),
				d.khata(UUID.randomUUID(), party, "debit", 12_500),
				d.khata(UUID.randomUUID(), party, "credit", 20_000),
				d.create("payment", pay, m("partyId", party, "direction", "in", "mode", "upi", "amountPaise", 20_000)));
		assertThat(count(seed, "SELECT balance_paise FROM khata_balance WHERE party_id = ?", party)).isEqualTo(42_500);
		assertThat(count(seed, "SELECT entry_count FROM khata_balance WHERE party_id = ?", party)).isEqualTo(3);
		assertProjectionsConsistent(seed);

		var res = upload(seed, d.op("payment", pay, "update", m("amountPaise", 1)), d.op("khata_entry", UUID.randomUUID(), "void", m()));
		assertThat(res.get("results").get(0).get("code").asString()).isEqualTo("append_only");
		assertThatThrownBy(() -> inTenant(seed.tenant(), () -> jdbc.update("UPDATE payment SET amount_paise = 1"))).isInstanceOf(DataAccessException.class);
		assertThatThrownBy(() -> inTenant(seed.tenant(), () -> jdbc.update("DELETE FROM khata_entry"))).isInstanceOf(DataAccessException.class);
	}

	// ---------- billing ----------

	private Map<String, Object> invoicePayload(UUID product, String series, long number, Map<String, Object> overrides) {
		Map<String, Object> line = m("productId", product, "qtyMilli", 2000, "unitPricePaise", 5000, "hsn", "10061010",
				"taxRateBp", 0, "taxPaise", 0, "lineTotalPaise", 10_000);
		Map<String, Object> p = m("series", series, "number", number, "docType", "retail_invoice", "invoiceDate", "2026-10-17",
				"subtotalPaise", 10_000, "taxPaise", 0, "totalPaise", 10_000, "lines", List.of(line));
		p.putAll(overrides);
		return p;
	}

	@Test
	void aFinalisedInvoiceIsImmutableAndCorrectedOnlyByCreditNote() throws Exception {
		Seed seed = seedTenant();
		var d = new Ops(seed);
		UUID product = UUID.randomUUID();
		UUID invoice = UUID.randomUUID();
		UUID note = UUID.randomUUID();
		var res = upload(seed, d.product(product, "Rice"),
				d.create("invoice", invoice, invoicePayload(product, "C1-2026-27", 1, Map.of())),
				d.op("invoice", invoice, "update", m("totalPaise", 1)),
				d.op("invoice", invoice, "void", m()),
				d.create("credit_note", note, m("series", "CN-C1", "number", 1, "invoiceId", invoice, "reason", "customer returned",
						"totalPaise", 10_000, "approval", m("approverUserId", seed.owner(), "reason", "owner checked")))
		);
		assertThat(statusOf(res, 1)).isEqualTo("applied");
		assertThat(res.get("results").get(2).get("code").asString()).isEqualTo("immutable_document");
		assertThat(res.get("results").get(3).get("code").asString()).isEqualTo("immutable_document");
		assertThat(statusOf(res, 4)).isEqualTo("applied");

		assertThat(count(seed, "SELECT total_paise FROM invoice WHERE id = ?", invoice)).isEqualTo(10_000);
		assertThat(count(seed, "SELECT count(*) FROM invoice_line WHERE invoice_id = ?", invoice)).isEqualTo(1);
		assertThat(count(seed, "SELECT count(*) FROM audit_log WHERE action = 'credit_note.issued' AND reason = 'customer returned'")).isEqualTo(1);
		assertThatThrownBy(() -> inTenant(seed.tenant(), () -> jdbc.update("UPDATE invoice SET total_paise = 1"))).isInstanceOf(DataAccessException.class);
		assertThatThrownBy(() -> inTenant(seed.tenant(), () -> jdbc.update("DELETE FROM invoice_line"))).isInstanceOf(DataAccessException.class);
		assertThatThrownBy(() -> inTenant(seed.tenant(), () -> jdbc.update("DELETE FROM credit_note"))).isInstanceOf(DataAccessException.class);
		assertThat(openFlags(seed)).isEmpty();
	}

	@Test
	void creditNoteNeedsAReasonAndAnOwnerApprovalIsFlaggedNotRequiredForPersistence() throws Exception {
		Seed seed = seedTenant();
		var d = new Ops(seed);
		UUID product = UUID.randomUUID();
		UUID invoice = UUID.randomUUID();
		var res = upload(seed, d.product(product, "Dal"), d.create("invoice", invoice, invoicePayload(product, "C1-2026-27", 1, Map.of())),
				d.create("credit_note", UUID.randomUUID(), m("series", "CN", "number", 1, "invoiceId", invoice, "reason", "  ", "totalPaise", 100)),
				d.create("credit_note", UUID.randomUUID(), m("series", "CN", "number", 2, "invoiceId", invoice, "reason", "wrong item", "totalPaise", 10_000)),
				d.create("credit_note", UUID.randomUUID(), m("series", "CN", "number", 3, "invoiceId", invoice, "reason", "again", "totalPaise", 500,
						"approval", m("approverUserId", UUID.randomUUID(), "reason", "not an owner"))));
		assertThat(res.get("results").get(2).get("code").asString()).isEqualTo("invalid_payload");
		assertThat(statusOf(res, 3)).isEqualTo("flagged");
		assertThat(statusOf(res, 4)).isEqualTo("flagged");
		assertThat(count(seed, "SELECT count(*) FROM credit_note")).isEqualTo(2);
		assertThat(openFlags(seed)).contains("approval_required", "credit_exceeds_invoice");
	}

	@Test
	void discountsAndBackdatingNeedAnOwnerPinApprovalButAnUnapprovedSaleIsStillRecordedAndFlagged() throws Exception {
		Seed seed = seedTenant();
		var d = new Ops(seed);
		UUID product = UUID.randomUUID();
		Map<String, Object> discounted = Map.of("discountPaise", 1000, "totalPaise", 9000);
		Map<String, Object> approved = new LinkedHashMap<>(discounted);
		approved.put("approval", m("approverUserId", seed.owner(), "reason", "regular customer"));
		var res = upload(seed, d.product(product, "Tea"),
				d.create("invoice", UUID.randomUUID(), invoicePayload(product, "C1", 1, discounted)),
				d.create("invoice", UUID.randomUUID(), invoicePayload(product, "C1", 2, approved)),
				d.create("invoice", UUID.randomUUID(), invoicePayload(product, "C1", 3, Map.of("invoiceDate", "2026-10-10"))),
				d.create("invoice", UUID.randomUUID(), invoicePayload(product, "C1", 4, Map.of("discountPaise", 500, "totalPaise", 9500))));
		assertThat(statusOf(res, 4)).as("5% is inside the unapproved band").isEqualTo("applied");
		assertThat(statusOf(res, 1)).isEqualTo("flagged");
		assertThat(statusOf(res, 2)).isEqualTo("applied");
		assertThat(statusOf(res, 3)).as("backdated without approval").isEqualTo("flagged");
		assertThat(count(seed, "SELECT count(*) FROM invoice")).as("all four sales persisted").isEqualTo(4);
		assertThat(count(seed, "SELECT count(*) FROM audit_log WHERE action = 'invoice.owner_approved' AND reason = 'regular customer'")).isEqualTo(1);
	}

	@Test
	void invoiceNumbersAreNeverReusedAndATotalThatDoesNotAddUpIsFlagged() throws Exception {
		Seed seed = seedTenant();
		var d = new Ops(seed);
		UUID product = UUID.randomUUID();
		UUID first = UUID.randomUUID();
		var res = upload(seed, d.product(product, "Bread"),
				d.create("invoice", first, invoicePayload(product, "C1", 7, Map.of())),
				d.create("invoice", first, invoicePayload(product, "C1", 7, Map.of())),
				d.create("invoice", UUID.randomUUID(), invoicePayload(product, "C1", 7, Map.of())),
				d.create("invoice", UUID.randomUUID(), invoicePayload(product, "C1", 8, Map.of("totalPaise", 9_999))));
		assertThat(statusOf(res, 2)).as("same invoice id again from a new op id is idempotent").isEqualTo("applied");
		assertThat(res.get("results").get(3).get("code").asString()).isEqualTo("duplicate_invoice_number");
		assertThat(statusOf(res, 4)).isEqualTo("flagged");
		assertThat(count(seed, "SELECT count(*) FROM invoice")).as("zero duplicate invoices").isEqualTo(2);
		assertThat(openFlags(seed)).containsExactly("total_mismatch");
	}

	@Test
	void compositionMerchantsGetABillOfSupplyAndAnUnregisteredOneCannotIssueATaxInvoice() throws Exception {
		Seed seed = seedTenant();
		var d = new Ops(seed);
		UUID product = UUID.randomUUID();
		inTenant(seed.tenant(), () -> jdbc.update("UPDATE business SET gst_mode = 'composition' WHERE id = ?", seed.business()));
		var res = upload(seed, d.product(product, "Biscuit"),
				d.create("invoice", UUID.randomUUID(), invoicePayload(product, "C1", 1, Map.of("docType", "bill_of_supply"))),
				d.create("invoice", UUID.randomUUID(), invoicePayload(product, "C1", 2, Map.of("docType", "tax_invoice"))));
		assertThat(statusOf(res, 1)).isEqualTo("applied");
		assertThat(statusOf(res, 2)).isEqualTo("flagged");
		assertThat(openFlags(seed)).containsExactly("composition_requires_bill_of_supply");

		inTenant(seed.tenant(), () -> jdbc.update("UPDATE business SET gst_mode = 'non_gst' WHERE id = ?", seed.business()));
		var res2 = upload(seed, d.create("invoice", UUID.randomUUID(), invoicePayload(product, "C1", 3, Map.of("docType", "tax_invoice"))));
		assertThat(statusOf(res2, 0)).isEqualTo("flagged");
		assertThat(openFlags(seed)).contains("tax_invoice_without_gst_registration");
	}

	@Test
	void taxRateChangesComeFromServerRulesByEffectiveDateWithoutAnAppRelease() throws Exception {
		JdbcTemplate admin = AdminSql.of(env);
		String prefix = "9" + String.format("%03d", (int) (Math.random() * 1000)); // unique per run, tables are shared
		admin.update("INSERT INTO tax_rule (hsn_prefix, description, rate_bp, effective_from) VALUES (?, 'Test goods', 500, '2026-01-01') ON CONFLICT DO NOTHING", prefix);
		admin.update("INSERT INTO tax_rule (hsn_prefix, description, rate_bp, effective_from) VALUES (?, 'Test goods (revised)', 1800, '2026-10-01') ON CONFLICT DO NOTHING", prefix);

		Seed seed = seedTenant();
		var d = new Ops(seed);
		inTenant(seed.tenant(), () -> jdbc.update("UPDATE business SET gst_mode = 'regular' WHERE id = ?", seed.business()));
		UUID product = UUID.randomUUID();
		String hsn = prefix + "1010";
		Map<String, Object> at5 = taxedInvoice(product, hsn, 500, "2026-09-30", 1);
		at5.put("approval", m("approverUserId", seed.owner(), "reason", "backdated bill"));
		Map<String, Object> at18 = taxedInvoice(product, hsn, 1800, "2026-10-17", 2);
		Map<String, Object> stale = taxedInvoice(product, hsn, 500, "2026-10-17", 3);
		var res = upload(seed, d.product(product, "Taxed"), d.create("invoice", UUID.randomUUID(), at5),
				d.create("invoice", UUID.randomUUID(), at18), d.create("invoice", UUID.randomUUID(), stale));
		assertThat(statusOf(res, 1)).as("5% was right on 30 Sep").isEqualTo("applied");
		assertThat(statusOf(res, 2)).as("18% is right from 1 Oct").isEqualTo("applied");
		assertThat(statusOf(res, 3)).as("a device with the old 5% table is flagged").isEqualTo("flagged");
		assertThat(openFlags(seed)).containsExactly("tax_rate_mismatch");
	}

	private Map<String, Object> taxedInvoice(UUID product, String hsn, int rateBp, String date, long number) {
		long tax = 10_000L * rateBp / (10_000 + rateBp);
		Map<String, Object> line = m("productId", product, "qtyMilli", 1000, "unitPricePaise", 10_000, "hsn", hsn,
				"taxRateBp", rateBp, "taxPaise", tax, "lineTotalPaise", 10_000);
		return m("series", "T1", "number", number, "docType", "tax_invoice", "invoiceDate", date,
				"subtotalPaise", 10_000 - tax, "taxPaise", tax, "totalPaise", 10_000, "lines", List.of(line));
	}

	@Test
	void purchaseReceiptsAreImmutableAndNumberedPerDeviceSeries() throws Exception {
		Seed seed = seedTenant();
		var d = new Ops(seed);
		UUID supplier = UUID.randomUUID();
		UUID receipt = UUID.randomUUID();
		var res = upload(seed, d.create("party", supplier, m("name", "Wholesaler", "partyType", "supplier")),
				d.create("purchase_receipt", receipt, m("series", "P1", "number", 1, "supplierId", supplier, "receiptDate", "2026-10-17", "totalPaise", 90_000)),
				d.op("purchase_receipt", receipt, "update", m("totalPaise", 1)));
		assertThat(statusOf(res, 1)).isEqualTo("applied");
		assertThat(res.get("results").get(2).get("code").asString()).isEqualTo("immutable_document");
		assertThatThrownBy(() -> inTenant(seed.tenant(), () -> jdbc.update("DELETE FROM purchase_receipt"))).isInstanceOf(DataAccessException.class);
	}

	// ---------- orders ----------

	@Test
	void orderTransitionsAreAppendOnlyAndAnIllegalLaterTransitionIsFlaggedNotApplied() throws Exception {
		Seed seed = seedTenant();
		var d = new Ops(seed);
		UUID order = UUID.randomUUID();
		JsonNode res = upload(seed, d.create("order", order, m("state", "draft")),
				d.create("order_transition", UUID.randomUUID(), m("orderId", order, "toState", "confirmed")),
				d.create("order_transition", UUID.randomUUID(), m("orderId", order, "toState", "cancelled", "reason", "customer called")),
				// another device, offline, dispatches the order that has meanwhile been cancelled
				d.create("order_transition", UUID.randomUUID(), m("orderId", order, "toState", "dispatched")));
		assertThat(statusOf(res, 1)).isEqualTo("applied");
		assertThat(statusOf(res, 2)).isEqualTo("applied");
		assertThat(statusOf(res, 3)).isEqualTo("flagged");

		assertThat(inTenant(seed.tenant(), () -> jdbc.queryForObject("SELECT state FROM sales_order WHERE id = ?", String.class, order))).isEqualTo("cancelled");
		assertThat(inTenant(seed.tenant(), () -> jdbc.queryForList("SELECT applied FROM order_transition WHERE order_id = ?", Boolean.class, order)))
				.containsExactlyInAnyOrder(true, true, false);
		assertThat(openFlags(seed)).containsExactly("order_transition_conflict");
		var direct = upload(seed, d.op("order", order, "update", m("state", "delivered")));
		assertThat(direct.get("results").get(0).get("code").asString()).isEqualTo("use_transitions");
		assertThatThrownBy(() -> inTenant(seed.tenant(), () -> jdbc.update("DELETE FROM order_transition"))).isInstanceOf(DataAccessException.class);
	}

	// ---------- who did it ----------

	@Test
	void anActorWithoutTheRoleIsFlaggedAndAnUnknownActorToo() throws Exception {
		Seed seed = seedTenant();
		UUID cashier = addUser(seed, "cashier");
		var d = new Ops(seed);
		UUID supplier = UUID.randomUUID();
		var res = upload(seed, Ops.by(d.create("party", supplier, m("name", "S", "partyType", "supplier")), seed.owner()),
				Ops.by(d.create("purchase_receipt", UUID.randomUUID(), m("series", "P", "number", 1, "receiptDate", "2026-10-17", "totalPaise", 100)), cashier),
				Ops.by(d.create("purchase_receipt", UUID.randomUUID(), m("series", "P", "number", 2, "receiptDate", "2026-10-17", "totalPaise", 100)), UUID.randomUUID()),
				Ops.by(d.create("purchase_receipt", UUID.randomUUID(), m("series", "P", "number", 3, "receiptDate", "2026-10-17", "totalPaise", 100)), seed.owner()));
		assertThat(statusOf(res, 0)).isEqualTo("applied");
		assertThat(statusOf(res, 1)).isEqualTo("flagged");
		assertThat(statusOf(res, 2)).isEqualTo("flagged");
		assertThat(statusOf(res, 3)).isEqualTo("applied");
		assertThat(count(seed, "SELECT count(*) FROM purchase_receipt")).as("flagged, never lost").isEqualTo(3);
		assertThat(openFlags(seed)).containsExactly("permission_violation", "unknown_actor");
	}

	@Test
	void aDeviceClockRunningFarAheadCannotPinFieldsForever() throws Exception {
		Seed seed = seedTenant();
		var d = new Ops(seed);
		UUID id = UUID.randomUUID();
		upload(seed, d.create("product", id, m("name", "Original")));
		// a phone with a dead RTC battery thinks it is 2099
		var skewed = new LinkedHashMap<>(d.op("product", id, "update", m("name", "From 2099")));
		skewed.put("hlc", "2099-01-01T00:00:00.000Z-0000-badclock");
		var res = upload(seed, List.of(skewed));
		assertThat(statusOf(res, 0)).isEqualTo("flagged");
		assertThat(openFlags(seed)).containsExactly("clock_skew");
		assertThat(count(seed, "SELECT count(*) FROM operation_log WHERE hlc LIKE '2099%'")).as("the log keeps what the device sent").isEqualTo(1);

		// a correct device writing five seconds from now still wins; with the 2099 clock honoured it never could
		var later = new LinkedHashMap<>(d.op("product", id, "update", m("name", "Corrected")));
		later.put("hlc", java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(java.time.ZoneOffset.UTC)
				.format(java.time.Instant.now().plusSeconds(5)) + "-0000-gooddev1");
		upload(seed, List.of(later));
		assertThat(inTenant(seed.tenant(), () -> jdbc.queryForObject("SELECT name FROM product WHERE id = ?", String.class, id))).isEqualTo("Corrected");
	}

	@Test
	void newerClientsAreRejectedNotMisread() throws Exception {
		Seed seed = seedTenant();
		var d = new Ops(seed);
		var op = new LinkedHashMap<>(d.product(UUID.randomUUID(), "Future"));
		op.put("schemaVersion", 2);
		var res = upload(seed, List.of(op));
		assertThat(res.get("results").get(0).get("code").asString()).isEqualTo("unsupported_schema_version");
		assertThat(count(seed, "SELECT count(*) FROM operation_log")).as("raw op kept for replay after a server upgrade").isEqualTo(1);
	}
}
