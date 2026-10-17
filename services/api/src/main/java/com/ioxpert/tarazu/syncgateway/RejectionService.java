package com.ioxpert.tarazu.syncgateway;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.ioxpert.tarazu.identity.AccessPolicy;
import com.ioxpert.tarazu.identity.AuditLog;
import com.ioxpert.tarazu.identity.Permission;
import com.ioxpert.tarazu.syncgateway.UploadResponse.OperationResult;
import com.ioxpert.tarazu.tenancy.ApiException;
import com.ioxpert.tarazu.tenancy.TenantContext;
import com.ioxpert.tarazu.tenancy.TenantSession;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

/**
 * Recovery path for operations the server rejected. A rejected sale is not lost (the raw operation stays in the
 * immutable log), but it is not in the books either, so an owner or manager can re-apply it: as is (after a server fix)
 * or with a corrected payload (an owner-only RFC 7386 merge patch, e.g. a new invoice number after a reinstall reused
 * one). The log keeps what the device sent; the patch, the reason and the actor go to the audit trail.
 */
@Service
class RejectionService {

	record RejectionView(UUID operationId, UUID deviceId, String entityType, UUID entityId, String opType, String code,
			String detail, Instant receivedAt, JsonNode payload) {
	}

	private final JdbcClient jdbc;
	private final JsonMapper json;
	private final TenantSession tenantSession;
	private final AccessPolicy access;
	private final AuditLog audit;
	private final OperationProcessor processor;

	RejectionService(JdbcClient jdbc, JsonMapper json, TenantSession tenantSession, AccessPolicy access, AuditLog audit,
			OperationProcessor processor) {
		this.jdbc = jdbc;
		this.json = json;
		this.tenantSession = tenantSession;
		this.access = access;
		this.audit = audit;
		this.processor = processor;
	}

	@Transactional(readOnly = true)
	List<RejectionView> list(int limit) {
		tenantSession.bindCurrentTenant();
		access.require(Permission.RESOLVE_FLAGS);
		return jdbc.sql("""
				SELECT o.operation_id, o.device_id, o.entity_type, o.entity_id, o.op_type, r.code, r.detail, o.received_at, o.payload::text AS payload
				FROM operation_result r JOIN operation_log o ON o.tenant_id = r.tenant_id AND o.operation_id = r.operation_id
				WHERE r.status = 'rejected' ORDER BY o.received_at DESC LIMIT :limit
				""").param("limit", Math.max(1, Math.min(limit, 200)))
				.query((rs, n) -> new RejectionView(rs.getObject("operation_id", UUID.class), rs.getObject("device_id", UUID.class),
						rs.getString("entity_type"), rs.getObject("entity_id", UUID.class), rs.getString("op_type"), rs.getString("code"),
						rs.getString("detail"), rs.getTimestamp("received_at").toInstant(), json.readTree(rs.getString("payload"))))
				.list();
	}

	@Transactional
	OperationResult reapply(UUID operationId, JsonNode patch, String reason) {
		tenantSession.bindCurrentTenant();
		access.require(Permission.RESOLVE_FLAGS);
		var principal = TenantContext.principal();
		boolean patching = patch != null && !patch.isNull() && !(patch.isObject() && patch.isEmpty());
		if (patching && !principal.hasRole("owner")) {
			throw ApiException.forbidden("owner_only", "Only an owner can change the contents of a rejected operation");
		}
		if (patching && !patch.isObject()) {
			throw ApiException.badRequest("invalid_patch", "payloadPatch must be a JSON object");
		}
		String status = jdbc.sql("SELECT status FROM operation_result WHERE operation_id = :id FOR UPDATE").param("id", operationId)
				.query(String.class).optional().orElseThrow(() -> ApiException.notFound("operation_not_found", "No such operation"));
		if (!"rejected".equals(status)) {
			throw ApiException.conflict("not_rejected", "Only a rejected operation can be re-applied (it is " + status + ")");
		}
		Operation original = jdbc.sql("SELECT * FROM operation_log WHERE operation_id = :id").param("id", operationId)
				.query((rs, n) -> processor.toOperation(rs)).single();
		Payload payload = original.payload();
		if (patching) {
			payload = new Payload(mergePatch(original.payload().node().deepCopy(), patch));
		}
		Operation op = new Operation(original.operationId(), original.tenantId(), original.storeId(), original.deviceId(),
				original.actorUserId(), original.localSeq(), original.hlc(), original.idempotencyKey(), original.entityType(),
				original.entityId(), original.opType(), original.schemaVersion(), payload, original.clockSkewed());

		OperationProcessor.Batch batch = new OperationProcessor.Batch();
		OperationResult result = processor.apply(op, batch);
		if ("rejected".equals(result.status())) {
			return result; // still invalid: nothing changed except the stored reason, and the caller sees why
		}
		audit.record(AuditLog.Entry.of("operation.reapplied", op.entityType(), op.entityId(), reason)
				.withDetails(Map.of("operationId", operationId.toString(), "previousStatus", status,
						"payloadPatch", patching ? json.writeValueAsString(patch) : "none", "resultStatus", result.status())));
		processor.drainDeferred(batch);
		return result;
	}

	/** RFC 7386: objects merge recursively, null removes a member, anything else replaces. */
	private static JsonNode mergePatch(JsonNode target, JsonNode patch) {
		if (!patch.isObject()) {
			return patch;
		}
		ObjectNode out = target.isObject() ? (ObjectNode) target : new ObjectNode(tools.jackson.databind.node.JsonNodeFactory.instance);
		for (var e : patch.properties()) {
			if (e.getValue().isNull()) {
				out.remove(e.getKey());
			}
			else {
				out.set(e.getKey(), mergePatch(out.has(e.getKey()) ? out.get(e.getKey()) : new ObjectNode(tools.jackson.databind.node.JsonNodeFactory.instance), e.getValue()));
			}
		}
		return out;
	}
}
