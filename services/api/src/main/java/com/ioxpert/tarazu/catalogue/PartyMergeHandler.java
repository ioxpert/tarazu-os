package com.ioxpert.tarazu.catalogue;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import com.ioxpert.tarazu.identity.Permission;
import com.ioxpert.tarazu.syncgateway.EntityOperationHandler;
import com.ioxpert.tarazu.syncgateway.HandlerResult;
import com.ioxpert.tarazu.syncgateway.Operation;
import com.ioxpert.tarazu.syncgateway.OperationContext;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import tools.jackson.databind.json.JsonMapper;

/**
 * Party merge with provenance: who merged what into what, from which device and clock, with snapshots of both
 * parties as they were. First merge wins; a merge that conflicts with an earlier one (source or target already
 * merged away) is recorded as not applied and flagged for review rather than silently re-pointing history.
 */
@Component
class PartyMergeHandler implements EntityOperationHandler {

	private final JdbcClient jdbc;
	private final JsonMapper json;

	PartyMergeHandler(JdbcClient jdbc, JsonMapper json) {
		this.jdbc = jdbc;
		this.json = json;
	}

	@Override
	public String entityType() {
		return "party_merge";
	}

	@Override
	public Set<Permission> permissions(Operation op) {
		return Set.of(Permission.MANAGE_PARTY);
	}

	@Override
	public HandlerResult handle(Operation op, OperationContext ctx) {
		if (!op.isCreate()) {
			return HandlerResult.rejected("append_only", "A merge decision is never edited");
		}
		UUID source = op.payload().uuid("sourcePartyId");
		UUID target = op.payload().uuid("targetPartyId");
		if (source.equals(target)) {
			return HandlerResult.rejected("invalid_merge", "A party cannot be merged into itself");
		}
		ctx.require("party", source);
		ctx.require("party", target);

		record Row(UUID id, String name, String phone, String gstin, UUID mergedInto) {
		}
		// lock in id order so two concurrent merges over the same pair cannot deadlock
		List<Row> rows = jdbc.sql("""
				SELECT id, name, phone, gstin, merged_into FROM party WHERE id IN (:a, :b) ORDER BY id FOR UPDATE
				""").param("a", source).param("b", target)
				.query((rs, n) -> new Row(rs.getObject("id", UUID.class), rs.getString("name"), rs.getString("phone"),
						rs.getString("gstin"), rs.getObject("merged_into", UUID.class)))
				.list();
		Row src = rows.stream().filter(r -> r.id().equals(source)).findFirst().orElseThrow();
		Row tgt = rows.stream().filter(r -> r.id().equals(target)).findFirst().orElseThrow();

		boolean applied = src.mergedInto() == null && tgt.mergedInto() == null;
		Map<String, Object> provenance = new LinkedHashMap<>();
		provenance.put("source", snapshot(src.id(), src.name(), src.phone(), src.gstin()));
		provenance.put("target", snapshot(tgt.id(), tgt.name(), tgt.phone(), tgt.gstin()));
		provenance.put("deviceId", op.deviceId().toString());
		provenance.put("hlc", op.hlc().raw());
		provenance.put("actorUserId", op.actorUserId() == null ? null : op.actorUserId().toString());

		int inserted = jdbc.sql("""
				INSERT INTO party_merge (id, tenant_id, source_party_id, target_party_id, applied, reason, provenance, operation_id)
				VALUES (:id, :tenant, :source, :target, :applied, :reason, CAST(:prov AS jsonb), :op)
				ON CONFLICT (id) DO NOTHING
				""").param("id", op.entityId()).param("tenant", op.tenantId()).param("source", source)
				.param("target", target).param("applied", applied).param("reason", op.payload().optText("reason").orElse(null))
				.param("prov", json.writeValueAsString(provenance)).param("op", op.operationId()).update();
		if (inserted == 0) {
			return HandlerResult.applied();
		}
		if (applied) {
			jdbc.sql("UPDATE party SET merged_into = :target, updated_at = now() WHERE id = :source")
					.param("target", target).param("source", source).update();
			ctx.audit("party.merged", "party", source, op.payload().optText("reason").orElse(null),
					Map.of("into", target.toString()));
		}
		else {
			ctx.flag("party_merge_conflict", op.entityId().toString(), "party_merge", op.entityId(),
					Map.of("sourcePartyId", source.toString(), "targetPartyId", target.toString(),
							"sourceMergedInto", String.valueOf(src.mergedInto()),
							"targetMergedInto", String.valueOf(tgt.mergedInto())));
		}
		return HandlerResult.applied();
	}

	private static Map<String, Object> snapshot(UUID id, String name, String phone, String gstin) {
		Map<String, Object> m = new LinkedHashMap<>();
		m.put("id", id.toString());
		m.put("name", name);
		m.put("phone", phone);
		m.put("gstin", gstin);
		return m;
	}
}
