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

/**
 * Orders are state machines with append-only transitions. Every transition that arrives is recorded. One that is
 * legal from the order's current state is applied; one that is not (e.g. "dispatched" arriving for a cancelled
 * order) is recorded with applied=false and flagged for a human, never auto-applied.
 */
@Component
class OrderTransitionHandler implements EntityOperationHandler {

	static final Map<String, Set<String>> LEGAL = Map.of(
			"draft", Set.of("confirmed", "cancelled"),
			"confirmed", Set.of("packed", "cancelled"),
			"packed", Set.of("dispatched", "cancelled"),
			"dispatched", Set.of("delivered"),
			"delivered", Set.of("returned"),
			"cancelled", Set.of(),
			"returned", Set.of());

	private final JdbcClient jdbc;

	OrderTransitionHandler(JdbcClient jdbc) {
		this.jdbc = jdbc;
	}

	@Override
	public boolean registersEntity() {
		return false;
	}

	@Override
	public String entityType() {
		return "order_transition";
	}

	@Override
	public Set<Permission> permissions(Operation op) {
		return Set.of(Permission.MANAGE_ORDERS);
	}

	@Override
	public HandlerResult handle(Operation op, OperationContext ctx) {
		if (!op.isCreate()) {
			return HandlerResult.rejected("append_only", "Order transitions are never edited");
		}
		UUID order = op.payload().uuid("orderId");
		String to = op.payload().text("toState");
		if (!LEGAL.containsKey(to)) {
			throw new InvalidPayloadException("Field 'toState' is not an order state");
		}
		ctx.require("order", order);
		String from = jdbc.sql("SELECT state FROM sales_order WHERE id = :id FOR UPDATE").param("id", order)
				.query(String.class).single();

		boolean noop = from.equals(to);
		boolean legal = noop || LEGAL.get(from).contains(to);
		int inserted = jdbc.sql("""
				INSERT INTO order_transition (id, tenant_id, order_id, from_state, to_state, applied, reason, device_id, hlc, operation_id)
				VALUES (:id, :tenant, :order, :from, :to, :applied, :reason, :device, :hlc, :op) ON CONFLICT (tenant_id, id) DO NOTHING
				""").param("id", op.entityId()).param("tenant", op.tenantId()).param("order", order).param("from", from)
				.param("to", to).param("applied", legal).param("reason", op.payload().optText("reason").orElse(null))
				.param("device", op.deviceId()).param("hlc", op.hlc().raw()).param("op", op.operationId()).update();
		if (inserted == 0) {
			return HandlerResult.applied();
		}
		if (legal && !noop) {
			jdbc.sql("UPDATE sales_order SET state = :to, updated_at = now() WHERE id = :id").param("to", to)
					.param("id", order).update();
		}
		else if (!legal) {
			ctx.flag("order_transition_conflict", op.entityId().toString(), "order", order,
					Map.of("orderId", order.toString(), "currentState", from, "attemptedState", to));
		}
		return HandlerResult.applied();
	}
}
