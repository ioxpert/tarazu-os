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
		evaluateCreditLimit(ctx, party);
		return HandlerResult.applied();
	}

	/**
	 * A credit limit is advice, never a refusal: the sale already happened. While the party's balance is above its
	 * limit one open `credit_limit_exceeded` flag exists; it closes when the balance is back at or below it (or the
	 * limit is removed). State-based, so the end state does not depend on the order entries arrived in.
	 */
	private void evaluateCreditLimit(OperationContext ctx, java.util.UUID party) {
		var row = jdbc.sql("""
				SELECT p.credit_limit_paise AS lim, coalesce(b.balance_paise, 0) AS bal
				FROM party p LEFT JOIN khata_balance b ON b.party_id = p.id WHERE p.id = :id
				""").param("id", party).query((rs, n) -> new long[] { rs.getLong("lim"), rs.wasNull() ? 1 : 0, rs.getLong("bal") })
				.optional().orElse(null);
		if (row == null) {
			return;
		}
		boolean hasLimit = row[1] == 0;
		if (hasLimit && row[2] > row[0]) {
			ctx.flag("credit_limit_exceeded", party.toString(), "party", party,
					java.util.Map.of("creditLimitPaise", row[0], "balancePaise", row[2]));
		}
		else {
			ctx.resolveFlag("credit_limit_exceeded", party.toString(), "Balance is within the credit limit");
		}
	}
}
