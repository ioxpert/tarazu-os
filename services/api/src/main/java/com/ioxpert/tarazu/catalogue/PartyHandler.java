package com.ioxpert.tarazu.catalogue;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

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
 * Party (customer / supplier): field-level merge like product. A phone or GSTIN that another party already
 * holds is NEVER auto-merged and never rejected: both stay, and a review flag is raised. Merging is an explicit,
 * recorded decision (party_merge).
 */
@Component
class PartyHandler implements EntityOperationHandler {

	static final String TYPE = "party";
	private static final Pattern GSTIN = Pattern.compile("[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]");

	private final JdbcClient jdbc;
	private final JsonMapper json;

	PartyHandler(JdbcClient jdbc, JsonMapper json) {
		this.jdbc = jdbc;
		this.json = json;
	}

	@Override
	public String entityType() {
		return TYPE;
	}

	@Override
	public Set<Permission> permissions(Operation op) {
		return Set.of(Permission.MANAGE_PARTY);
	}

	@Override
	public HandlerResult handle(Operation op, OperationContext ctx) {
		Map<String, Object> fields;
		if (op.isCreate()) {
			fields = fields(op.payload());
			if (!fields.containsKey("name")) {
				throw new InvalidPayloadException("Field 'name' is required");
			}
			FieldMerge.upsert(jdbc, json, "party", op, fields);
		}
		else {
			ctx.require(TYPE, op.entityId());
			fields = op.isVoid() ? Map.of("active", false) : fields(op.payload());
			FieldMerge.merge(jdbc, json, "party", op, fields);
		}
		checkIdentity(op, ctx, fields);
		return HandlerResult.applied();
	}

	private void checkIdentity(Operation op, OperationContext ctx, Map<String, Object> fields) {
		for (String field : List.of("phone", "gstin")) {
			if (fields.get(field) == null) {
				continue;
			}
			// compare against the stored value: the incoming write may have lost the field-level merge
			String stored = jdbc.sql("SELECT " + field + " FROM party WHERE id = :id").param("id", op.entityId())
					.query(String.class).optional().orElse(null);
			if (stored == null) {
				continue;
			}
			List<UUID> others = jdbc.sql("SELECT id FROM party WHERE " + field + " = :v AND id <> :id AND merged_into IS NULL")
					.param("v", stored).param("id", op.entityId()).query(UUID.class).list();
			for (UUID other : others) {
				UUID lo = op.entityId().compareTo(other) < 0 ? op.entityId() : other;
				UUID hi = lo.equals(op.entityId()) ? other : op.entityId();
				ctx.flag("party_identity_conflict", field + ":" + lo + ":" + hi, TYPE, op.entityId(),
						Map.of("field", field, "value", stored, "partyIds", List.of(lo.toString(), hi.toString())));
			}
			if ("gstin".equals(field) && !GSTIN.matcher(stored).matches()) {
				ctx.flag("invalid_gstin", op.entityId().toString(), TYPE, op.entityId(), Map.of("gstin", stored));
			}
		}
	}

	private static Map<String, Object> fields(Payload p) {
		Map<String, Object> f = new LinkedHashMap<>();
		if (p.present("name")) {
			f.put("name", p.text("name"));
		}
		if (p.present("partyType")) {
			String type = p.text("partyType");
			if (!Set.of("customer", "supplier", "both").contains(type)) {
				throw new InvalidPayloadException("Field 'partyType' must be customer, supplier or both");
			}
			f.put("party_type", type);
		}
		if (p.present("phone")) {
			f.put("phone", p.optText("phone").map(PartyHandler::normalisePhone).filter(s -> !s.isEmpty()).orElse(null));
		}
		if (p.present("gstin")) {
			f.put("gstin", p.optText("gstin").map(s -> s.toUpperCase().replaceAll("\\s", "")).orElse(null));
		}
		if (p.present("creditLimitPaise")) {
			Long limit = p.optInteger("creditLimitPaise").orElse(null);
			if (limit != null && limit < 0) {
				throw new InvalidPayloadException("Field 'creditLimitPaise' must not be negative");
			}
			f.put("credit_limit_paise", limit);
		}
		if (p.present("active")) {
			f.put("active", p.bool("active", true));
		}
		return f;
	}

	/** Digits only; drops a +91 / 91 / 0 prefix so the same mobile number compares equal however it was typed. */
	static String normalisePhone(String raw) {
		String digits = raw.replaceAll("\\D", "");
		if (digits.length() == 12 && digits.startsWith("91")) {
			return digits.substring(2);
		}
		if (digits.length() == 11 && digits.startsWith("0")) {
			return digits.substring(1);
		}
		return digits;
	}
}
