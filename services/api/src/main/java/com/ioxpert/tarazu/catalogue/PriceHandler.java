package com.ioxpert.tarazu.catalogue;

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
 * Prices are effective-dated and append-only: a price change is a new row with its own effective_from, never an
 * edit. Concurrent changes both persist; the one in force at a time is resolved by price_as_of().
 */
@Component
class PriceHandler implements EntityOperationHandler {

	private static final Set<String> TYPES = Set.of("mrp", "retail", "wholesale", "purchase");

	private final JdbcClient jdbc;

	PriceHandler(JdbcClient jdbc) {
		this.jdbc = jdbc;
	}

	@Override
	public String entityType() {
		return "price_version";
	}

	@Override
	public Set<Permission> permissions(Operation op) {
		return Set.of(Permission.MANAGE_CATALOGUE);
	}

	@Override
	public HandlerResult handle(Operation op, OperationContext ctx) {
		if (!op.isCreate()) {
			return HandlerResult.rejected("append_only", "Prices are never edited; add a new effective-dated price");
		}
		var p = op.payload();
		var productId = p.uuid("productId");
		String type = p.text("priceType");
		if (!TYPES.contains(type)) {
			throw new InvalidPayloadException("Field 'priceType' must be one of " + TYPES);
		}
		long amount = p.integer("amountPaise");
		if (amount < 0) {
			throw new InvalidPayloadException("Field 'amountPaise' must not be negative");
		}
		ctx.require("product", productId);
		jdbc.sql("""
				INSERT INTO price_version (id, tenant_id, product_id, price_type, amount_paise, effective_from, hlc, operation_id)
				VALUES (:id, :tenant, :product, :type, :amount, :from, :hlc, :op) ON CONFLICT (id) DO NOTHING
				""").param("id", op.entityId()).param("tenant", op.tenantId()).param("product", productId)
				.param("type", type).param("amount", amount)
				.param("from", java.sql.Timestamp.from(p.instant("effectiveFrom"))).param("hlc", op.hlc().raw())
				.param("op", op.operationId()).update();
		return HandlerResult.applied();
	}
}
