package com.ioxpert.tarazu.billing;

import java.util.Map;
import java.util.Set;
import java.util.UUID;

import com.ioxpert.tarazu.identity.Permission;
import com.ioxpert.tarazu.syncgateway.EntityOperationHandler;
import com.ioxpert.tarazu.syncgateway.HandlerResult;
import com.ioxpert.tarazu.syncgateway.InvalidPayloadException;
import com.ioxpert.tarazu.syncgateway.Operation;
import com.ioxpert.tarazu.syncgateway.OperationContext;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import tools.jackson.databind.json.JsonMapper;

/**
 * Returns and corrections: a credit note refers to the invoice it corrects; nothing is edited or deleted.
 * A reason is mandatory and the owner's approval is expected (voids need the owner PIN).
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
}
