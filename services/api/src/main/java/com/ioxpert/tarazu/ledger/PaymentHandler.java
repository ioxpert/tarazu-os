package com.ioxpert.tarazu.ledger;

import java.util.Set;

import com.ioxpert.tarazu.identity.Permission;
import com.ioxpert.tarazu.syncgateway.EntityOperationHandler;
import com.ioxpert.tarazu.syncgateway.HandlerResult;
import com.ioxpert.tarazu.syncgateway.InvalidPayloadException;
import com.ioxpert.tarazu.syncgateway.Operation;
import com.ioxpert.tarazu.syncgateway.OperationContext;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/** Payments are append-only events. A mistaken payment is reversed by a new payment in the other direction. */
@Component
class PaymentHandler implements EntityOperationHandler {

	private static final Set<String> MODES = Set.of("cash", "upi", "card", "bank_transfer", "cheque", "other");

	private final JdbcClient jdbc;

	PaymentHandler(JdbcClient jdbc) {
		this.jdbc = jdbc;
	}

	@Override
	public boolean registersEntity() {
		return false;
	}

	@Override
	public String entityType() {
		return "payment";
	}

	@Override
	public Set<Permission> permissions(Operation op) {
		return Set.of(Permission.RECORD_PAYMENT, Permission.RECORD_SALE);
	}

	@Override
	public HandlerResult handle(Operation op, OperationContext ctx) {
		if (!op.isCreate()) {
			return HandlerResult.rejected("append_only", "Payments are never edited; record a reversing payment");
		}
		var p = op.payload();
		String direction = p.text("direction");
		if (!Set.of("in", "out").contains(direction)) {
			throw new InvalidPayloadException("Field 'direction' must be 'in' or 'out'");
		}
		String mode = p.text("mode");
		if (!MODES.contains(mode)) {
			throw new InvalidPayloadException("Field 'mode' must be one of " + MODES);
		}
		long amount = p.integer("amountPaise");
		if (amount <= 0) {
			throw new InvalidPayloadException("Field 'amountPaise' must be positive");
		}
		var party = p.optUuid("partyId").orElse(null);
		var invoice = p.optUuid("invoiceId").orElse(null);
		if (party != null) {
			ctx.require("party", party);
		}
		if (invoice != null) {
			ctx.require("invoice", invoice);
		}
		jdbc.sql("""
				INSERT INTO payment (id, tenant_id, store_id, party_id, invoice_id, direction, mode, amount_paise, reference,
				                     device_id, hlc, operation_id, occurred_at)
				VALUES (:id, :tenant, :store, :party, :invoice, :direction, :mode, :amount, :ref, :device, :hlc, :op, :at)
				ON CONFLICT (tenant_id, id) DO NOTHING
				""").param("id", op.entityId()).param("tenant", op.tenantId()).param("store", op.storeId())
				.param("party", party).param("invoice", invoice).param("direction", direction).param("mode", mode)
				.param("amount", amount).param("ref", p.optText("reference").orElse(null))
				.param("device", op.deviceId()).param("hlc", op.hlc().raw()).param("op", op.operationId())
				.param("at", java.sql.Timestamp.from(p.has("occurredAt") ? p.instant("occurredAt") : op.hlc().instant()))
				.update();
		return HandlerResult.applied();
	}
}
