package com.ioxpert.tarazu.inventory;

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
 * Stock is a projection of append-only movements (see stock_balance); it is never last-writer-wins, so two
 * counters that each sell the last 3 units both persist and stock reads -3 with the oversold flag. The sum
 * is order-independent, so the balance converges whatever order batches arrive in.
 */
@Component
class StockMovementHandler implements EntityOperationHandler {

	static final Set<String> REASONS = Set.of("opening", "sale", "purchase", "sale_return", "purchase_return",
			"adjustment", "transfer_in", "transfer_out", "damage");

	private final JdbcClient jdbc;

	StockMovementHandler(JdbcClient jdbc) {
		this.jdbc = jdbc;
	}

	@Override
	public boolean registersEntity() {
		return false;
	}

	@Override
	public String entityType() {
		return "stock_movement";
	}

	@Override
	public Set<Permission> permissions(Operation op) {
		String reason = op.payload().node().path("reason").asString("");
		return switch (reason) {
			case "sale", "sale_return" -> Set.of(Permission.RECORD_SALE, Permission.ISSUE_CREDIT_NOTE);
			case "purchase", "purchase_return" -> Set.of(Permission.RECORD_PURCHASE);
			default -> Set.of(Permission.ADJUST_STOCK);
		};
	}

	@Override
	public int lockTier() {
		return 70;
	}

	/** Movements of one product in one store contend for the same stock_balance row. */
	@Override
	public String lockKey(Operation op) {
		return op.storeId() + ":" + op.payload().node().path("productId").asString("");
	}

	@Override
	public HandlerResult handle(Operation op, OperationContext ctx) {
		if (!op.isCreate()) {
			return HandlerResult.rejected("append_only", "Stock movements are never edited; add a correcting movement");
		}
		var p = op.payload();
		UUID productId = p.uuid("productId");
		long qty = p.integer("qtyMilli");
		if (qty == 0) {
			throw new InvalidPayloadException("Field 'qtyMilli' must not be zero");
		}
		String reason = p.text("reason");
		if (!REASONS.contains(reason)) {
			throw new InvalidPayloadException("Field 'reason' must be one of " + REASONS);
		}
		ctx.require("product", productId);

		int inserted = jdbc.sql("""
				INSERT INTO stock_movement (id, tenant_id, store_id, product_id, qty_milli, reason, ref_type, ref_id,
				                            device_id, hlc, operation_id, occurred_at)
				VALUES (:id, :tenant, :store, :product, :qty, :reason, :refType, :refId, :device, :hlc, :op, :at)
				ON CONFLICT (tenant_id, id) DO NOTHING
				""").param("id", op.entityId()).param("tenant", op.tenantId()).param("store", op.storeId())
				.param("product", productId).param("qty", qty).param("reason", reason)
				.param("refType", p.optText("refType").orElse(null)).param("refId", p.optUuid("refId").orElse(null))
				.param("device", op.deviceId()).param("hlc", op.hlc().raw()).param("op", op.operationId())
				.param("at", java.sql.Timestamp.from(p.has("occurredAt") ? p.instant("occurredAt") : op.hlc().instant()))
				.update();
		if (inserted == 1) {
			evaluateOversold(op, ctx, productId);
		}
		return HandlerResult.applied();
	}

	/**
	 * Keeps exactly one open "oversold" flag per (store, product) while the balance is negative and closes it
	 * when stock recovers. State-based, so the end state does not depend on the order movements arrived in.
	 */
	private void evaluateOversold(Operation op, OperationContext ctx, UUID productId) {
		long balance = jdbc.sql("SELECT qty_milli FROM stock_balance WHERE store_id = :s AND product_id = :p")
				.param("s", op.storeId()).param("p", productId).query(Long.class).single();
		String scope = op.storeId() + ":" + productId;
		if (balance < 0) {
			ctx.flag("oversold", scope, "product", productId,
					Map.of("storeId", op.storeId().toString(), "productId", productId.toString(), "qtyMilli", balance));
		}
		else {
			ctx.resolveFlag("oversold", scope, "Stock is back at or above zero");
		}
	}
}
