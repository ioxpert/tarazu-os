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
 * edit. Concurrent changes both persist; the one in force at a time is resolved by price_as_of() (store-wide types) or
 * price_as_of_party() (a negotiated 'customer' price, which carries the party).
 */
@Component
class PriceHandler implements EntityOperationHandler {

	private static final Set<String> TYPES = Set.of("mrp", "retail", "wholesale", "purchase", "customer");

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
		var party = p.optUuid("partyId").orElse(null);
		if ("customer".equals(type) && party == null) {
			throw new InvalidPayloadException("Field 'partyId' is required for priceType 'customer'");
		}
		if (!"customer".equals(type) && party != null) {
			throw new InvalidPayloadException("Field 'partyId' is only allowed for priceType 'customer'");
		}
		ctx.require("product", productId);
		if (party != null) {
			ctx.require("party", party);
		}
		jdbc.sql("""
				INSERT INTO price_version (id, tenant_id, product_id, party_id, price_type, amount_paise, effective_from, hlc, operation_id)
				VALUES (:id, :tenant, :product, :party, :type, :amount, :from, :hlc, :op) ON CONFLICT (tenant_id, id) DO NOTHING
				""").param("id", op.entityId()).param("tenant", op.tenantId()).param("product", productId)
				.param("party", party)
				.param("type", type).param("amount", amount)
				.param("from", java.sql.Timestamp.from(p.instant("effectiveFrom"))).param("hlc", op.hlc().raw())
				.param("op", op.operationId()).update();
		return HandlerResult.applied();
	}
}
