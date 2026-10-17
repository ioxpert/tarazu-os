package com.ioxpert.tarazu.shift;

import java.util.Set;

import com.ioxpert.tarazu.identity.Permission;
import com.ioxpert.tarazu.syncgateway.EntityOperationHandler;
import com.ioxpert.tarazu.syncgateway.HandlerResult;
import com.ioxpert.tarazu.syncgateway.InvalidPayloadException;
import com.ioxpert.tarazu.syncgateway.Operation;
import com.ioxpert.tarazu.syncgateway.OperationContext;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/** Opens a cash shift on a device with the counted float. Append-only: a shift is closed by a shift_close, never edited. */
@Component
class ShiftHandler implements EntityOperationHandler {

	private final JdbcClient jdbc;

	ShiftHandler(JdbcClient jdbc) {
		this.jdbc = jdbc;
	}

	@Override
	public String entityType() {
		return "shift";
	}

	@Override
	public Set<Permission> permissions(Operation op) {
		return Set.of(Permission.RECORD_SALE);
	}

	@Override
	public HandlerResult handle(Operation op, OperationContext ctx) {
		if (!op.isCreate()) {
			return HandlerResult.rejected("append_only", "A shift is never edited; close it with a shift_close");
		}
		var p = op.payload();
		long opening = p.integer("openingCashPaise");
		if (opening < 0) {
			throw new InvalidPayloadException("Field 'openingCashPaise' must not be negative");
		}
		var openedAt = p.has("openedAt") ? p.instant("openedAt") : op.hlc().instant();
		jdbc.sql("""
				INSERT INTO shift (id, tenant_id, store_id, device_id, opening_cash_paise, opened_at, note, hlc, operation_id)
				VALUES (:id, :tenant, :store, :device, :opening, :openedAt, :note, :hlc, :op)
				ON CONFLICT (tenant_id, id) DO NOTHING
				""").param("id", op.entityId()).param("tenant", op.tenantId()).param("store", op.storeId())
				.param("device", op.deviceId()).param("opening", opening).param("openedAt", java.sql.Timestamp.from(openedAt))
				.param("note", p.optText("note").orElse(null)).param("hlc", op.hlc().raw())
				.param("op", op.operationId()).update();
		return HandlerResult.applied();
	}
}
