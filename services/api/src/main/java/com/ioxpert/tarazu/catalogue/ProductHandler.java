package com.ioxpert.tarazu.catalogue;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

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

/**
 * Product: mutable, merged field by field by HLC ("product name field-level latest"). Void deactivates
 * (rows are never deleted: invoices and stock movements point at them).
 */
@Component
class ProductHandler implements EntityOperationHandler {

	static final String TYPE = "product";

	private final JdbcClient jdbc;
	private final JsonMapper json;

	ProductHandler(JdbcClient jdbc, JsonMapper json) {
		this.jdbc = jdbc;
		this.json = json;
	}

	@Override
	public String entityType() {
		return TYPE;
	}

	@Override
	public Set<Permission> permissions(Operation op) {
		return Set.of(Permission.MANAGE_CATALOGUE);
	}

	@Override
	public HandlerResult handle(Operation op, OperationContext ctx) {
		if (op.isCreate()) {
			Map<String, Object> fields = fields(op.payload());
			if (!fields.containsKey("name")) {
				throw new InvalidPayloadException("Field 'name' is required");
			}
			FieldMerge.upsert(jdbc, json, "product", op, fields);
		}
		else {
			ctx.require(TYPE, op.entityId());
			Map<String, Object> fields = op.isVoid() ? Map.of("active", false) : fields(op.payload());
			FieldMerge.merge(jdbc, json, "product", op, fields);
		}
		return HandlerResult.applied();
	}

	private static Map<String, Object> fields(Payload p) {
		Map<String, Object> f = new LinkedHashMap<>();
		if (p.present("name")) {
			f.put("name", p.text("name"));
		}
		for (String nullable : new String[] { "barcode", "sku", "hsn" }) {
			if (p.present(nullable)) {
				f.put(nullable, p.optText(nullable).orElse(null));
			}
		}
		if (p.present("unit")) {
			f.put("unit", p.text("unit"));
		}
		if (p.present("active")) {
			f.put("active", p.bool("active", true));
		}
		return f;
	}
}
