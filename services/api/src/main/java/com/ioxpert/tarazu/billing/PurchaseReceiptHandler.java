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
import tools.jackson.databind.json.JsonMapper;

/** Purchase receipt (goods received): immutable after finalisation; a return to the supplier is a new document. */
@Component
class PurchaseReceiptHandler implements EntityOperationHandler {

	private final JdbcClient jdbc;
	private final JsonMapper json;

	PurchaseReceiptHandler(JdbcClient jdbc, JsonMapper json) {
		this.jdbc = jdbc;
		this.json = json;
	}

	@Override
	public boolean registersEntity() {
		return false;
	}

	@Override
	public String entityType() {
		return "purchase_receipt";
	}

	@Override
	public Set<Permission> permissions(Operation op) {
		return Set.of(Permission.RECORD_PURCHASE);
	}

	@Override
	public HandlerResult handle(Operation op, OperationContext ctx) {
		if (!op.isCreate()) {
			return HandlerResult.rejected("immutable_document", "A finalised purchase receipt cannot be changed");
		}
		var p = op.payload();
		String series = p.text("series");
		long number = p.integer("number");
		long total = p.integer("totalPaise");
		if (number <= 0 || total < 0) {
			throw new InvalidPayloadException("Fields 'number' must be positive and 'totalPaise' must not be negative");
		}
		UUID supplier = p.optUuid("supplierId").orElse(null);
		if (supplier != null) {
			ctx.require("party", supplier);
		}
		UUID existing = jdbc.sql("SELECT id FROM purchase_receipt WHERE series = :s AND number = :n")
				.param("s", series).param("n", number).query(UUID.class).optional().orElse(null);
		if (existing != null) {
			return existing.equals(op.entityId()) ? HandlerResult.applied() : HandlerResult.rejected(
					"duplicate_receipt_number", "Receipt number %s/%d already belongs to another receipt".formatted(series, number));
		}
		jdbc.sql("""
				INSERT INTO purchase_receipt (id, tenant_id, store_id, device_id, series, number, supplier_id, supplier_ref,
				                              receipt_date, total_paise, lines, hlc, operation_id)
				VALUES (:id, :tenant, :store, :device, :series, :number, :supplier, :ref, :date, :total, CAST(:lines AS jsonb),
				        :hlc, :op)
				""").param("id", op.entityId()).param("tenant", op.tenantId()).param("store", op.storeId())
				.param("device", op.deviceId()).param("series", series).param("number", number)
				.param("supplier", supplier).param("ref", p.optText("supplierRef").orElse(null))
				.param("date", p.date("receiptDate")).param("total", total)
				.param("lines", p.has("lines") ? json.writeValueAsString(p.array("lines")) : "[]")
				.param("hlc", op.hlc().raw()).param("op", op.operationId()).update();
		return HandlerResult.applied();
	}
}
