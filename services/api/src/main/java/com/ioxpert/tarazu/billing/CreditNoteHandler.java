package com.ioxpert.tarazu.billing;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import com.ioxpert.tarazu.identity.Permission;
import com.ioxpert.tarazu.syncgateway.EntityOperationHandler;
import com.ioxpert.tarazu.syncgateway.HandlerResult;
import com.ioxpert.tarazu.syncgateway.InvalidPayloadException;
import com.ioxpert.tarazu.syncgateway.Operation;
import com.ioxpert.tarazu.syncgateway.OperationContext;
import com.ioxpert.tarazu.syncgateway.Payload;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Returns and corrections: a credit note refers to the invoice it corrects; nothing is edited or deleted.
 * A reason is mandatory and the owner's approval is expected (voids need the owner PIN).
 *
 * <p>Typed lines ({invoiceLineNo, qtyMilli, taxPaise, lineTotalPaise}) are cross-checked against the invoice, but
 * a return that already happened at the counter is evidence and is never rejected for them: a line that does not
 * exist or has no quantity (credit_note_invalid_line), a total that is not the sum of the lines
 * (credit_note_total_mismatch) and a cumulative returned quantity above the invoiced quantity
 * (return_exceeds_sold) are applied and flagged.
 */
@Component
class CreditNoteHandler implements EntityOperationHandler {

	private final JdbcClient jdbc;
	private final JsonMapper json;

	CreditNoteHandler(JdbcClient jdbc, JsonMapper json) {
		this.jdbc = jdbc;
		this.json = json;
	}

	@Override
	public String entityType() {
		return "credit_note";
	}

	@Override
	public Set<Permission> permissions(Operation op) {
		return Set.of(Permission.ISSUE_CREDIT_NOTE);
	}

	@Override
	public HandlerResult handle(Operation op, OperationContext ctx) {
		if (!op.isCreate()) {
			return HandlerResult.rejected("immutable_document", "A credit note cannot be changed; issue another one");
		}
		var p = op.payload();
		String series = p.text("series");
		long number = p.integer("number");
		long total = p.integer("totalPaise");
		String reason = p.text("reason");
		if (number <= 0 || total <= 0) {
			throw new InvalidPayloadException("Fields 'number' and 'totalPaise' must be positive");
		}
		UUID invoice = p.uuid("invoiceId");
		UUID party = p.optUuid("partyId").orElse(null);
		ctx.require("invoice", invoice);
		if (party != null) {
			ctx.require("party", party);
		}

		UUID existing = jdbc.sql("SELECT id FROM credit_note WHERE series = :s AND number = :n").param("s", series)
				.param("n", number).query(UUID.class).optional().orElse(null);
		if (existing != null) {
			return existing.equals(op.entityId()) ? HandlerResult.applied() : HandlerResult.rejected(
					"duplicate_credit_note_number", "Credit note number %s/%d already belongs to another note".formatted(series, number));
		}
		String lines = p.has("lines") ? json.writeValueAsString(p.array("lines")) : "[]";
		jdbc.sql("""
				INSERT INTO credit_note (id, tenant_id, store_id, device_id, series, number, invoice_id, party_id, reason,
				                         total_paise, lines, approval, hlc, operation_id)
				VALUES (:id, :tenant, :store, :device, :series, :number, :invoice, :party, :reason, :total,
				        CAST(:lines AS jsonb), CAST(:approval AS jsonb), :hlc, :op)
				""").param("id", op.entityId()).param("tenant", op.tenantId()).param("store", op.storeId())
				.param("device", op.deviceId()).param("series", series).param("number", number).param("invoice", invoice)
				.param("party", party).param("reason", reason).param("total", total).param("lines", lines)
				.param("approval", Approvals.json(p, json)).param("hlc", op.hlc().raw()).param("op", op.operationId())
				.update();

		ctx.audit("credit_note.issued", "invoice", invoice, reason, Map.of("creditNoteId", op.entityId().toString(),
				"totalPaise", total));
		if (Approvals.valid(ctx, p)) {
			ctx.audit("credit_note.owner_approved", "credit_note", op.entityId(), Approvals.reason(p), Map.of());
		}
		else {
			ctx.flag("approval_required", op.entityId().toString(), "credit_note", op.entityId(), Map.of("voidOrReturn", true));
		}
		reviewLines(op, ctx, p, invoice, total);
		long invoiceTotal = jdbc.sql("SELECT total_paise FROM invoice WHERE id = :id").param("id", invoice)
				.query(Long.class).single();
		long credited = jdbc.sql("SELECT coalesce(sum(total_paise), 0) FROM credit_note WHERE invoice_id = :id")
				.param("id", invoice).query(Long.class).single();
		if (credited > invoiceTotal) {
			ctx.flag("credit_exceeds_invoice", invoice.toString(), "invoice", invoice,
					Map.of("invoiceTotalPaise", invoiceTotal, "creditedPaise", credited));
		}
		return HandlerResult.applied();
	}

	private void reviewLines(Operation op, OperationContext ctx, Payload p, UUID invoice, long total) {
		if (!p.has("lines")) {
			return;
		}
		JsonNode array = p.array("lines");
		if (array.isEmpty()) {
			return;
		}
		Map<Integer, Long> sold = new java.util.HashMap<>();
		jdbc.sql("SELECT line_no, qty_milli FROM invoice_line WHERE invoice_id = :id").param("id", invoice)
				.query((rs, n) -> sold.put(rs.getInt("line_no"), rs.getLong("qty_milli"))).list();

		long lineSum = 0;
		List<Map<String, Object>> invalid = new ArrayList<>();
		int index = 0;
		for (JsonNode n : array) {
			index++;
			Payload l = new Payload(n);
			long lineNo = l.optInteger("invoiceLineNo").orElse(0L);
			long qty = l.optInteger("qtyMilli").orElse(0L);
			lineSum += l.optInteger("lineTotalPaise").orElse(0L);
			if (!sold.containsKey((int) lineNo) || lineNo != (int) lineNo || qty <= 0) {
				Map<String, Object> bad = new LinkedHashMap<>();
				bad.put("index", index);
				bad.put("invoiceLineNo", lineNo);
				bad.put("qtyMilli", qty);
				invalid.add(bad);
			}
		}
		if (!invalid.isEmpty()) {
			ctx.flag("credit_note_invalid_line", op.entityId().toString(), "credit_note", op.entityId(),
					Map.of("lines", invalid.size() > 20 ? invalid.subList(0, 20) : invalid));
		}
		if (lineSum != total) {
			ctx.flag("credit_note_total_mismatch", op.entityId().toString(), "credit_note", op.entityId(),
					Map.of("totalPaise", total, "lineSumPaise", lineSum));
		}

		// cumulative returned quantity per invoice line over every credit note of the invoice (this one included)
		Map<Integer, Long> returned = new java.util.HashMap<>();
		for (String raw : jdbc.sql("SELECT lines::text FROM credit_note WHERE invoice_id = :id").param("id", invoice)
				.query(String.class).list()) {
			for (JsonNode n : json.readTree(raw)) {
				if (n.isObject() && n.path("invoiceLineNo").isIntegralNumber() && n.path("qtyMilli").isIntegralNumber()
						&& n.path("qtyMilli").longValue() > 0) {
					returned.merge(n.path("invoiceLineNo").intValue(), n.path("qtyMilli").longValue(), Long::sum);
				}
			}
		}
		Set<Integer> thisNote = new java.util.TreeSet<>();
		for (JsonNode n : array) {
			if (n.path("invoiceLineNo").isIntegralNumber()) {
				thisNote.add(n.path("invoiceLineNo").intValue());
			}
		}
		for (int lineNo : thisNote) {
			Long soldQty = sold.get(lineNo);
			long back = returned.getOrDefault(lineNo, 0L);
			if (soldQty != null && back > soldQty) {
				ctx.flag("return_exceeds_sold", invoice + ":" + lineNo, "invoice", invoice,
						Map.of("invoiceLineNo", lineNo, "soldQtyMilli", soldQty, "returnedQtyMilli", back));
			}
		}
	}
}
