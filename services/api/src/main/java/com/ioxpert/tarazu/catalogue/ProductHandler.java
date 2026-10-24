package com.ioxpert.tarazu.catalogue;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
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
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Product: mutable, merged field by field by HLC ("product name field-level latest"). Void deactivates
 * (rows are never deleted: invoices and stock movements point at them). Barcodes are NOT unique: when another
 * active product of the tenant carries the same barcode, the operation is applied and flagged
 * (duplicate_barcode); the flag closes itself once the barcode is changed or a product is deactivated.
 */
@Component
class ProductHandler implements EntityOperationHandler {

	static final String TYPE = "product";

	/** The UomUnit enum of the contract. */
	static final Set<String> UNITS = Set.of("piece", "packet", "strip", "bottle", "dozen", "kg", "g", "litre", "ml",
			"bag", "box", "case", "carton", "bundle", "quintal");
	private static final int MAX_UOM_UNITS = 8;

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
		String barcodeBefore = null;
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
			barcodeBefore = barcodeOf(op.entityId());
			FieldMerge.merge(jdbc, json, "product", op, fields);
		}
		String barcodeNow = barcodeOf(op.entityId());
		reviewBarcode(ctx, barcodeNow);
		if (barcodeBefore != null && !barcodeBefore.equals(barcodeNow)) {
			reviewBarcode(ctx, barcodeBefore);
		}
		return HandlerResult.applied();
	}

	private String barcodeOf(UUID id) {
		return jdbc.sql("SELECT barcode FROM product WHERE id = :id").param("id", id).query(String.class).optional()
				.orElse(null);
	}

	/** Raises duplicate_barcode while two or more ACTIVE products share the barcode; resolves it when they no longer do. */
	private void reviewBarcode(OperationContext ctx, String barcode) {
		if (barcode == null || barcode.isBlank()) {
			return;
		}
		List<UUID> holders = jdbc.sql("SELECT id FROM product WHERE barcode = :b AND active ORDER BY id")
				.param("b", barcode).query(UUID.class).list();
		if (holders.size() > 1) {
			ctx.flag("duplicate_barcode", barcode, "product", holders.get(0),
					Map.of("barcode", barcode, "productIds", holders.stream().map(UUID::toString).toList()));
		}
		else {
			ctx.resolveFlag("duplicate_barcode", barcode, "Barcode is no longer shared by several active products");
		}
	}

	private Map<String, Object> fields(Payload p) {
		Map<String, Object> f = new LinkedHashMap<>();
		if (p.present("name")) {
			f.put("name", p.text("name"));
		}
		for (String nullable : new String[] { "barcode", "sku", "hsn", "brand", "category" }) {
			if (p.present(nullable)) {
				f.put(nullable, p.optText(nullable).orElse(null));
			}
		}
		for (String[] pair : new String[][] { { "localName", "local_name" }, { "packSku", "pack_sku" } }) {
			if (p.present(pair[0])) {
				f.put(pair[1], p.optText(pair[0]).orElse(null));
			}
		}
		if (p.present("unit")) {
			String unit = p.text("unit");
			if (!UNITS.contains(unit)) {
				throw new InvalidPayloadException("Field 'unit' must be one of " + new java.util.TreeSet<>(UNITS));
			}
			f.put("unit", unit);
		}
		if (p.present("uom")) {
			f.put("uom", new FieldMerge.Jsonb(uomJson(p)));
		}
		if (p.present("taxRateBp")) {
			Long rate = p.optInteger("taxRateBp").orElse(null);
			if (rate != null && (rate < 0 || rate > 10000)) {
				throw new InvalidPayloadException("Field 'taxRateBp' must be between 0 and 10000");
			}
			f.put("tax_rate_bp", rate);
		}
		for (String[] pair : new String[][] { { "taxInclusive", "tax_inclusive", "true" }, { "loose", "loose", "false" },
				{ "pinned", "pinned", "false" }, { "active", "active", "true" } }) {
			if (p.present(pair[0])) {
				f.put(pair[1], p.bool(pair[0], Boolean.parseBoolean(pair[2])));
			}
		}
		return f;
	}

	/** Validates a UomSpec and returns it normalised as JSON text; null clears the field. */
	private String uomJson(Payload p) {
		JsonNode uom = p.node().get("uom");
		if (uom == null || uom.isNull()) {
			return null;
		}
		if (!uom.isObject()) {
			throw new InvalidPayloadException("Field 'uom' must be an object {base, units}");
		}
		Payload spec = new Payload(uom);
		String base = spec.text("base");
		if (!UNITS.contains(base)) {
			throw new InvalidPayloadException("Field 'uom.base' must be one of " + new java.util.TreeSet<>(UNITS));
		}
		JsonNode units = spec.array("units");
		if (units.size() > MAX_UOM_UNITS) {
			throw new InvalidPayloadException("Field 'uom.units' has at most " + MAX_UOM_UNITS + " entries");
		}
		Set<String> seen = new java.util.HashSet<>();
		List<Map<String, Object>> clean = new ArrayList<>();
		for (JsonNode n : units) {
			if (!n.isObject()) {
				throw new InvalidPayloadException("Each 'uom.units' entry must be an object {unit, qtyMilli}");
			}
			Payload u = new Payload(n);
			String unit = u.text("unit");
			long qty = u.integer("qtyMilli");
			if (!UNITS.contains(unit)) {
				throw new InvalidPayloadException("Unit '" + unit + "' in 'uom.units' is not a known unit");
			}
			if (qty <= 0) {
				throw new InvalidPayloadException("'qtyMilli' of unit '" + unit + "' must be positive");
			}
			if (!seen.add(unit)) {
				throw new InvalidPayloadException("Unit '" + unit + "' appears twice in 'uom.units'");
			}
			if (unit.equals(base) && qty != 1000) {
				throw new InvalidPayloadException("The base unit is implicitly 1000; do not redefine it");
			}
			Map<String, Object> entry = new LinkedHashMap<>();
			entry.put("unit", unit);
			entry.put("qtyMilli", qty);
			clean.add(entry);
		}
		Map<String, Object> out = new LinkedHashMap<>();
		out.put("base", base);
		out.put("units", clean);
		return json.writeValueAsString(out);
	}
}
