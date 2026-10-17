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

/**
 * Khata (credit book) entries are append-only events; the party's balance is a projection (khata_balance),
 * never an overwritten number. debit = the party owes more, credit = the party paid or was credited.
 */
@Component
class KhataEntryHandler implements EntityOperationHandler {

	private final JdbcClient jdbc;

	KhataEntryHandler(JdbcClient jdbc) {
		this.jdbc = jdbc;
	}

	@Override
	public boolean registersEntity() {
		return false;
	}

	@Override
	public String entityType() {
		return "khata_entry";
	}

	@Override
	public Set<Permission> permissions(Operation op) {
		return Set.of(Permission.RECORD_PAYMENT, Permission.RECORD_SALE, Permission.ISSUE_CREDIT_NOTE);
	}

	@Override
	public int lockTier() {
		return 80;
	}

	/** Entries for one party contend for the same khata_balance row. */
	@Override
	public String lockKey(Operation op) {
		return op.payload().node().path("partyId").asString("");
	}

	@Override
	public HandlerResult handle(Operation op, OperationContext ctx) {
		if (!op.isCreate()) {
			return HandlerResult.rejected("append_only", "Khata entries are never edited; add a correcting entry");
		}
		var p = op.payload();
		var party = p.uuid("partyId");
		String direction = p.text("direction");
		if (!Set.of("debit", "credit").contains(direction)) {
			throw new InvalidPayloadException("Field 'direction' must be 'debit' or 'credit'");
		}
		long amount = p.integer("amountPaise");
		if (amount <= 0) {
			throw new InvalidPayloadException("Field 'amountPaise' must be positive");
		}
		ctx.require("party", party);
		jdbc.sql("""
				INSERT INTO khata_entry (id, tenant_id, store_id, party_id, direction, amount_paise, ref_type, ref_id, note,
				                         device_id, hlc, operation_id, occurred_at)
				VALUES (:id, :tenant, :store, :party, :direction, :amount, :refType, :refId, :note, :device, :hlc, :op, :at)
				ON CONFLICT (tenant_id, id) DO NOTHING
				""").param("id", op.entityId()).param("tenant", op.tenantId()).param("store", op.storeId())
				.param("party", party).param("direction", direction).param("amount", amount)
				.param("refType", p.optText("refType").orElse(null)).param("refId", p.optUuid("refId").orElse(null))
				.param("note", p.optText("note").orElse(null)).param("device", op.deviceId())
				.param("hlc", op.hlc().raw()).param("op", op.operationId())
				.param("at", java.sql.Timestamp.from(p.has("occurredAt") ? p.instant("occurredAt") : op.hlc().instant()))
				.update();
		return HandlerResult.applied();
	}
}
