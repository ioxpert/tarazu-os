package com.ioxpert.tarazu.shift;

import java.time.Instant;
import java.util.LinkedHashMap;
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

/**
 * Closes a shift once. The device says what it declared and what it expected; the server recomputes the expected
 * cash from the payments that reached it (opening float + cash in - cash out of the shift's device between
 * opened_at and closed_at) and stores ITS figure, plus variance = declared - expected. Money differences never
 * reject a close: they are flagged (cash_variance for the owner, shift_expected_mismatch when device and server
 * disagree) because the counted cash is evidence of what happened at the counter.
 */
@Component
class ShiftCloseHandler implements EntityOperationHandler {

	private final JdbcClient jdbc;

	ShiftCloseHandler(JdbcClient jdbc) {
		this.jdbc = jdbc;
	}

	@Override
	public String entityType() {
		return "shift_close";
	}

	@Override
	public Set<Permission> permissions(Operation op) {
		return Set.of(Permission.RECORD_SALE);
	}

	private record ShiftRow(UUID deviceId, long openingCashPaise, Instant openedAt) {
	}

	@Override
	public HandlerResult handle(Operation op, OperationContext ctx) {
		if (!op.isCreate()) {
			return HandlerResult.rejected("append_only", "A shift close is never edited");
		}
		var p = op.payload();
		UUID shiftId = p.uuid("shiftId");
		long declared = p.integer("declaredCashPaise");
		long clientExpected = p.integer("expectedCashPaise");
		if (declared < 0) {
			throw new InvalidPayloadException("Field 'declaredCashPaise' must not be negative");
		}
		Instant closedAt = p.has("closedAt") ? p.instant("closedAt") : op.hlc().instant();
		ctx.require("shift", shiftId);

		UUID existing = jdbc.sql("SELECT id FROM shift_close WHERE shift_id = :shift").param("shift", shiftId)
				.query(UUID.class).optional().orElse(null);
		if (existing != null) {
			return existing.equals(op.entityId()) ? HandlerResult.applied()
					: HandlerResult.rejected("shift_already_closed", "Shift %s was already closed".formatted(shiftId));
		}
		ShiftRow shift = jdbc.sql("SELECT device_id, opening_cash_paise, opened_at FROM shift WHERE id = :id")
				.param("id", shiftId).query((rs, n) -> new ShiftRow(rs.getObject("device_id", UUID.class),
						rs.getLong("opening_cash_paise"), rs.getTimestamp("opened_at").toInstant()))
				.single();

		long net = jdbc.sql("""
				SELECT coalesce(sum(CASE direction WHEN 'in' THEN amount_paise ELSE -amount_paise END), 0) FROM payment
				WHERE mode = 'cash' AND device_id = :device AND occurred_at >= :from AND occurred_at <= :to
				""").param("device", shift.deviceId()).param("from", java.sql.Timestamp.from(shift.openedAt()))
				.param("to", java.sql.Timestamp.from(closedAt)).query(Long.class).single();
		long expected = shift.openingCashPaise() + net;
		long variance = declared - expected;

		jdbc.sql("""
				INSERT INTO shift_close (id, tenant_id, store_id, device_id, shift_id, declared_cash_paise, expected_cash_paise,
				                         client_expected_cash_paise, variance_paise, closed_at, note, hlc, operation_id)
				VALUES (:id, :tenant, :store, :device, :shift, :declared, :expected, :clientExpected, :variance, :closedAt,
				        :note, :hlc, :op)
				""").param("id", op.entityId()).param("tenant", op.tenantId()).param("store", op.storeId())
				.param("device", op.deviceId()).param("shift", shiftId).param("declared", declared)
				.param("expected", expected).param("clientExpected", clientExpected).param("variance", variance)
				.param("closedAt", java.sql.Timestamp.from(closedAt)).param("note", p.optText("note").orElse(null))
				.param("hlc", op.hlc().raw()).param("op", op.operationId()).update();

		if (clientExpected != expected) {
			ctx.flag("shift_expected_mismatch", shiftId.toString(), "shift_close", op.entityId(),
					Map.of("shiftId", shiftId.toString(), "clientExpectedPaise", clientExpected, "serverExpectedPaise", expected));
		}
		Map<String, Object> detail = new LinkedHashMap<>();
		detail.put("shiftId", shiftId.toString());
		detail.put("declaredPaise", declared);
		detail.put("expectedPaise", expected);
		detail.put("variancePaise", variance);
		if (variance != 0) {
			ctx.flag("cash_variance", shiftId.toString(), "shift_close", op.entityId(), detail);
		}
		ctx.audit("shift.closed", "shift", shiftId, p.optText("note").orElse(null), detail);
		return HandlerResult.applied();
	}
}
