package com.ioxpert.tarazu.billing;

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

/** Order header. After creation its state only ever changes through order_transition operations. */
@Component
class OrderHandler implements EntityOperationHandler {

	private final JdbcClient jdbc;

	OrderHandler(JdbcClient jdbc) {
		this.jdbc = jdbc;
	}

	@Override
	public String entityType() {
		return "order";
	}

	@Override
	public Set<Permission> permissions(Operation op) {
		return Set.of(Permission.MANAGE_ORDERS);
	}

	@Override
	public HandlerResult handle(Operation op, OperationContext ctx) {
		if (!op.isCreate()) {
			return HandlerResult.rejected("use_transitions", "An order changes state only through order_transition operations");
		}
		String state = op.payload().optText("state").orElse("draft");
		if (!Set.of("draft", "confirmed").contains(state)) {
			throw new InvalidPayloadException("An order starts as 'draft' or 'confirmed'");
		}
		UUID party = op.payload().optUuid("partyId").orElse(null);
		if (party != null) {
			ctx.require("party", party);
		}
		jdbc.sql("""
				INSERT INTO sales_order (id, tenant_id, store_id, party_id, state) VALUES (:id, :tenant, :store, :party, :state)
				ON CONFLICT (tenant_id, id) DO NOTHING
				""").param("id", op.entityId()).param("tenant", op.tenantId()).param("store", op.storeId())
				.param("party", party).param("state", state).update();
		return HandlerResult.applied();
	}
}
