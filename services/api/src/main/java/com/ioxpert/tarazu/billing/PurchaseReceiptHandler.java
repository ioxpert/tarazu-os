package com.ioxpert.tarazu.billing;

import java.util.Set;
import java.util.UUID;

import com.ioxpert.tarazu.identity.Permission;
import com.ioxpert.tarazu.syncgateway.EntityOperationHandler;
import com.ioxpert.tarazu.syncgateway.HandlerResult;
import com.ioxpert.tarazu.syncgateway.InvalidPayloadException;
import com.ioxpert.tarazu.syncgateway.Operation;
import com.ioxpert.tarazu.syncgateway.OperationContext;
import com.ioxpert.tarazu.syncgateway.Payload;
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
		var lines = p.has("lines") ? p.array("lines") : null;
		long lineSum = 0;
		boolean badLine = false;
		if (lines != null) {
			var products = new java.util.LinkedHashSet<UUID>();
			for (var n : lines) {
				Payload l = new Payload(n);
				products.add(l.uuid("productId"));
				long qty = l.integer("qtyMilli");
				long unit = l.integer("unitCostPaise");
				long lt = l.integer("lineTotalPaise");
				if (qty <= 0 || unit < 0 || lt < 0) {
					badLine = true;
				}
				lineSum += lt;
			}
			ctx.requireAll("product", products);
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
		// The goods are already on the shelf: a bill that does not add up is flagged for the owner, never refused.
		if (lines != null && lineSum != total) {
			ctx.flag("purchase_total_mismatch", op.entityId().toString(), "purchase_receipt", op.entityId(),
					java.util.Map.of("lineSumPaise", lineSum, "totalPaise", total));
		}
		if (badLine) {
			ctx.flag("purchase_line_invalid", op.entityId().toString(), "purchase_receipt", op.entityId(), java.util.Map.of());
		}
		return HandlerResult.applied();
	}
}
