package com.ioxpert.tarazu.syncgateway;

import static com.ioxpert.tarazu.Ops.m;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.ioxpert.tarazu.ApiIT;
import com.ioxpert.tarazu.Ops;
import com.ioxpert.tarazu.Seed;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import tools.jackson.databind.JsonNode;

/** ADR 0013: an owner or manager can recover a rejected operation; the original stays in the immutable log. */
class RejectionsIT extends ApiIT {

	private MockHttpServletRequestBuilder as(MockHttpServletRequestBuilder req, Seed seed, UUID user) {
		return req.header("X-Tenant-Id", seed.tenant()).header("X-Staff-Id", user).contentType(MediaType.APPLICATION_JSON);
	}

	private ResultActions reapply(Seed seed, UUID user, UUID operationId, Map<String, Object> body) throws Exception {
		return mvc.perform(as(post("/v1/sync/rejections/" + operationId + "/reapply"), seed, user).content(json.writeValueAsString(body)));
	}

	private static Map<String, Object> invoicePayload(UUID product, long number) {
		Map<String, Object> line = m("productId", product, "qtyMilli", 2000, "unitPricePaise", 5000, "hsn", "10061010",
				"taxRateBp", 0, "taxPaise", 0, "lineTotalPaise", 10_000);
		return m("series", "C1-2026-27", "number", number, "docType", "retail_invoice", "invoiceDate", "2026-10-17",
				"subtotalPaise", 10_000, "taxPaise", 0, "totalPaise", 10_000, "lines", List.of(line));
	}

	/** Two invoices on the same series and number: the second is rejected, as after a reinstall that reset the counter. */
	private record Collision(Seed seed, Ops device, UUID rejectedOp, UUID rejectedInvoice, UUID product) {
	}

	private Collision collide() throws Exception {
		Seed seed = seedTenant();
		var d = new Ops(seed);
		UUID product = UUID.randomUUID();
		UUID first = UUID.randomUUID();
		UUID second = UUID.randomUUID();
		var dup = d.create("invoice", second, invoicePayload(product, 7));
		var res = upload(seed, d.product(product, "Bread"), d.create("invoice", first, invoicePayload(product, 7)), dup);
		assertThat(res.get("results").get(2).get("code").asString()).isEqualTo("duplicate_invoice_number");
		return new Collision(seed, d, (UUID) dup.get("operationId"), second, product);
	}

	@Test
	void ownerReappliesWithACorrectedInvoiceNumberAndTheOriginalStaysInTheLog() throws Exception {
		var c = collide();
		Seed seed = c.seed();

		JsonNode listed = json.readTree(mvc.perform(as(get("/v1/sync/rejections"), seed, seed.owner())).andExpect(status().isOk())
				.andReturn().getResponse().getContentAsString());
		assertThat(listed).hasSize(1);
		assertThat(listed.get(0).get("code").asString()).isEqualTo("duplicate_invoice_number");
		assertThat(listed.get(0).get("payload").get("number").asLong()).isEqualTo(7);

		// as-is the same problem remains, so it stays rejected and nothing is written
		reapply(seed, seed.owner(), c.rejectedOp(), m("reason", "retry")).andExpect(status().isOk())
				.andExpect(result -> assertThat(json.readTree(result.getResponse().getContentAsString()).get("status").asString()).isEqualTo("rejected"));
		assertThat(count(seed, "SELECT count(*) FROM invoice")).isEqualTo(1);
		assertThat(count(seed, "SELECT count(*) FROM audit_log WHERE action = 'operation.reapplied'")).isZero();

		reapply(seed, seed.owner(), c.rejectedOp(), m("payloadPatch", m("number", 8), "reason", "counter reset after reinstall"))
				.andExpect(status().isOk())
				.andExpect(result -> assertThat(json.readTree(result.getResponse().getContentAsString()).get("status").asString()).isEqualTo("applied"));
		assertThat(count(seed, "SELECT count(*) FROM invoice")).isEqualTo(2);
		assertThat(count(seed, "SELECT number FROM invoice WHERE id = ?", c.rejectedInvoice())).isEqualTo(8);
		assertThat(count(seed, "SELECT count(*) FROM audit_log WHERE action = 'operation.reapplied' AND reason = 'counter reset after reinstall'"))
				.isEqualTo(1);
		assertThat(count(seed, "SELECT (payload->>'number')::bigint FROM operation_log WHERE operation_id = ?", c.rejectedOp()))
				.as("the log keeps what the device sent").isEqualTo(7);

		mvc.perform(as(get("/v1/sync/rejections"), seed, seed.owner())).andExpect(status().isOk())
				.andExpect(result -> assertThat(json.readTree(result.getResponse().getContentAsString())).isEmpty());
		// the device re-uploading its original is recognised as a duplicate of an operation that is now applied
		var again = upload(seed, originalOf(c));
		assertThat(statusOf(again, 0)).isEqualTo("duplicate");
		assertThat(again.get("results").get(0).get("originalStatus").asString()).isEqualTo("applied");
	}

	private Map<String, Object> originalOf(Collision c) {
		var row = inTenant(c.seed().tenant(), () -> jdbc.queryForMap("SELECT * FROM operation_log WHERE operation_id = ?", c.rejectedOp()));
		Map<String, Object> op = new Ops(c.seed(), (UUID) row.get("device_id"), null)
				.create("invoice", c.rejectedInvoice(), invoicePayload(c.product(), 7));
		op.put("operationId", c.rejectedOp());
		op.put("idempotencyKey", row.get("idempotency_key"));
		return op;
	}

	@Test
	void aDeferredChildOfTheRejectedSaleIsWokenWhenItIsRecovered() throws Exception {
		var c = collide();
		Seed seed = c.seed();
		var note = c.device().create("credit_note", UUID.randomUUID(), m("series", "CN", "number", 1, "invoiceId", c.rejectedInvoice(),
				"reason", "returned", "totalPaise", 10_000, "approval", m("approverUserId", seed.owner(), "reason", "ok")));
		assertThat(statusOf(upload(seed, note), 0)).isEqualTo("deferred");

		reapply(seed, seed.owner(), c.rejectedOp(), m("payloadPatch", m("number", 9), "reason", "fix")).andExpect(status().isOk());
		assertThat(count(seed, "SELECT count(*) FROM credit_note")).isEqualTo(1);
	}

	@Test
	void managerCanReapplyAsIsButNotEditAndACashierCannotDoEither() throws Exception {
		var c = collide();
		Seed seed = c.seed();
		UUID manager = addUser(seed, "manager");
		UUID cashier = addUser(seed, "cashier");
		reapply(seed, manager, c.rejectedOp(), m("payloadPatch", m("number", 8), "reason", "x")).andExpect(status().isForbidden());
		reapply(seed, manager, c.rejectedOp(), m("reason", "x")).andExpect(status().isOk());
		reapply(seed, cashier, c.rejectedOp(), m("reason", "x")).andExpect(status().isForbidden());
		mvc.perform(as(get("/v1/sync/rejections"), seed, cashier)).andExpect(status().isForbidden());
		assertThat(count(seed, "SELECT count(*) FROM invoice")).isEqualTo(1);
	}

	@Test
	void aReasonIsRequiredAndOnlyRejectedOperationsOfThisTenantCanBeReapplied() throws Exception {
		var c = collide();
		Seed seed = c.seed();
		reapply(seed, seed.owner(), c.rejectedOp(), m("payloadPatch", m("number", 8))).andExpect(status().isBadRequest());
		reapply(seed, seed.owner(), c.rejectedOp(), m("payloadPatch", "not-an-object", "reason", "x")).andExpect(status().isBadRequest());

		var applied = c.device().create("product", UUID.randomUUID(), m("name", "Ok", "unit", "piece"));
		upload(seed, applied);
		reapply(seed, seed.owner(), (UUID) applied.get("operationId"), m("reason", "x")).andExpect(status().isConflict());

		Seed other = seedTenant();
		reapply(other, other.owner(), c.rejectedOp(), m("reason", "x")).andExpect(status().isNotFound());
	}

	@Test
	void anInvalidPayloadIsFixedByAPatch() throws Exception {
		Seed seed = seedTenant();
		var d = new Ops(seed);
		UUID id = UUID.randomUUID();
		var bad = d.create("product", id, m("name", " ", "unit", "piece"));
		assertThat(statusOf(upload(seed, bad), 0)).isEqualTo("rejected");
		reapply(seed, seed.owner(), (UUID) bad.get("operationId"), m("payloadPatch", m("name", "Salt"), "reason", "name was blank"))
				.andExpect(status().isOk());
		assertThat(inTenant(seed.tenant(), () -> jdbc.queryForObject("SELECT name FROM product WHERE id = ?", String.class, id))).isEqualTo("Salt");
	}
}
