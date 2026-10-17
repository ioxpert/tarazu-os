package com.ioxpert.tarazu.billing;

import static com.ioxpert.tarazu.Ops.m;
import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.ioxpert.tarazu.ApiIT;
import com.ioxpert.tarazu.Ops;
import com.ioxpert.tarazu.Seed;
import org.junit.jupiter.api.Test;

/** Typed credit-note lines are cross-checked against the invoice, but a return is evidence: flag, never reject. */
class CreditNoteLinesIT extends ApiIT {

	private final UUID product = UUID.randomUUID();
	private final UUID invoice = UUID.randomUUID();

	private Map<String, Object> noteLine(int lineNo, long qty, long tax, long total) {
		return m("invoiceLineNo", lineNo, "productId", product, "qtyMilli", qty, "taxRateBp", 1800, "taxPaise", tax, "lineTotalPaise", total);
	}

	/** Invoice with two lines: 3 units at 118 (18% inclusive) and 2 units at 50. */
	private Seed seedInvoice(Ops[] opsOut) throws Exception {
		Seed seed = seedTenant();
		var d = new Ops(seed);
		opsOut[0] = d;
		Map<String, Object> l1 = m("productId", product, "qtyMilli", 3000, "unitPricePaise", 11800, "taxRateBp", 1800, "taxPaise", 5400, "lineTotalPaise", 35400);
		Map<String, Object> l2 = m("productId", product, "qtyMilli", 2000, "unitPricePaise", 5000, "taxRateBp", 0, "taxPaise", 0, "lineTotalPaise", 10000);
		var res = upload(seed, d.product(product, "Soap"), d.create("invoice", invoice, m("series", "S", "number", 1, "docType", "retail_invoice",
				"invoiceDate", "2026-10-17", "subtotalPaise", 40000, "taxPaise", 5400, "totalPaise", 45400,
				"lines", List.of(l1, l2))));
		assertThat(statusOf(res, 1)).isIn("applied", "flagged");
		return seed;
	}

	private List<String> openFlags(Seed seed) {
		return inTenant(seed.tenant(), () -> jdbc.queryForList("SELECT kind FROM conflict_flag WHERE status = 'open' AND kind NOT IN ('total_mismatch', 'tax_invoice_without_gst_registration') ORDER BY kind", String.class));
	}

	@Test
	void aConsistentPartialReturnIsAppliedWithoutFlagsExceptTheMissingApproval() throws Exception {
		Ops[] ops = new Ops[1];
		Seed seed = seedInvoice(ops);
		var res = upload(seed, ops[0].create("credit_note", UUID.randomUUID(), m("series", "CN", "number", 1, "invoiceId", invoice,
				"reason", "one damaged", "totalPaise", 11800, "lines", List.of(noteLine(1, 1000, 1800, 11800)))));
		assertThat(res.get("results").get(0).get("code").asString()).isEqualTo("approval_required");
		assertThat(openFlags(seed)).containsExactly("approval_required");
	}

	@Test
	void aTotalThatIsNotTheSumOfTheLinesIsFlaggedNotRejected() throws Exception {
		Ops[] ops = new Ops[1];
		Seed seed = seedInvoice(ops);
		var res = upload(seed, ops[0].create("credit_note", UUID.randomUUID(), m("series", "CN", "number", 1, "invoiceId", invoice,
				"reason", "r", "totalPaise", 12000, "lines", List.of(noteLine(1, 1000, 1800, 11800)))));
		assertThat(res.get("results").get(0).get("code").asString()).contains("credit_note_total_mismatch");
		assertThat(count(seed, "SELECT count(*) FROM credit_note")).isEqualTo(1);
		assertThat(openFlags(seed)).contains("credit_note_total_mismatch").doesNotContain("return_exceeds_sold");
	}

	@Test
	void anUnknownInvoiceLineOrZeroQuantityIsFlaggedNotRejected() throws Exception {
		Ops[] ops = new Ops[1];
		Seed seed = seedInvoice(ops);
		var res = upload(seed, ops[0].create("credit_note", UUID.randomUUID(), m("series", "CN", "number", 1, "invoiceId", invoice,
				"reason", "r", "totalPaise", 200, "lines", List.of(noteLine(9, 1000, 0, 100), noteLine(2, 0, 0, 100)))));
		assertThat(res.get("results").get(0).get("code").asString()).contains("credit_note_invalid_line");
		assertThat(count(seed, "SELECT count(*) FROM credit_note")).isEqualTo(1);
	}

	@Test
	void cumulativeReturnsAboveTheInvoicedQuantityAreFlaggedAcrossCreditNotes() throws Exception {
		Ops[] ops = new Ops[1];
		Seed seed = seedInvoice(ops);
		var d = ops[0];
		var res = upload(seed,
				d.create("credit_note", UUID.randomUUID(), m("series", "CN", "number", 1, "invoiceId", invoice, "reason", "r1",
						"totalPaise", 23600, "lines", List.of(noteLine(1, 2000, 3600, 23600)))),
				d.create("credit_note", UUID.randomUUID(), m("series", "CN", "number", 2, "invoiceId", invoice, "reason", "r2",
						"totalPaise", 11800, "lines", List.of(noteLine(1, 1000, 1800, 11800)))),
				d.create("credit_note", UUID.randomUUID(), m("series", "CN", "number", 3, "invoiceId", invoice, "reason", "r3 again",
						"totalPaise", 11800, "lines", List.of(noteLine(1, 1000, 1800, 11800)))));
		assertThat(res.get("results").get(0).get("code").asString()).doesNotContain("return_exceeds_sold");
		assertThat(res.get("results").get(1).get("code").asString()).doesNotContain("return_exceeds_sold");
		assertThat(res.get("results").get(2).get("code").asString()).contains("return_exceeds_sold");
		assertThat(count(seed, "SELECT count(*) FROM credit_note")).as("the third return is kept as evidence").isEqualTo(3);
		var detail = inTenant(seed.tenant(), () -> jdbc.queryForObject("SELECT detail::text FROM conflict_flag WHERE kind = 'return_exceeds_sold'", String.class));
		var node = json.readTree(detail);
		assertThat(node.get("soldQtyMilli").asLong()).isEqualTo(3000);
		assertThat(node.get("returnedQtyMilli").asLong()).isEqualTo(4000);
	}

	@Test
	void notesWithoutTypedLinesKeepWorkingAsBefore() throws Exception {
		Ops[] ops = new Ops[1];
		Seed seed = seedInvoice(ops);
		var res = upload(seed, ops[0].create("credit_note", UUID.randomUUID(), m("series", "CN", "number", 1, "invoiceId", invoice,
				"reason", "goodwill", "totalPaise", 500)));
		assertThat(res.get("results").get(0).get("code").asString()).isEqualTo("approval_required");
	}
}
