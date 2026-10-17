package com.ioxpert.tarazu.syncgateway;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

import com.ioxpert.tarazu.identity.AccessPolicy;
import com.ioxpert.tarazu.identity.AuditLog;
import com.ioxpert.tarazu.syncgateway.UploadResponse.OperationResult;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.json.JsonMapper;

/**
 * Applies operations one at a time, each in its own savepoint, so one bad operation never poisons a
 * batch and a permanently invalid one cannot block a device's queue forever.
 *
 * <p>Every received operation is stored in the immutable operation_log first (idempotent), then applied.
 * Its fate (applied / flagged / deferred / rejected) is kept in operation_result. A deferred operation
 * waits for a missing parent entity and is re-applied the moment that parent registers.
 */
@Component
class OperationProcessor {

	private static final Logger log = LoggerFactory.getLogger(OperationProcessor.class);
	private static final int MAX_DRAIN_ROUNDS = 50;

	/** Per-batch scratch: entities registered (to wake deferred ops) and role lookups. */
	static final class Batch {
		final Set<EntityKey> registered = new HashSet<>();
		final Map<String, Set<String>> rolesCache = new HashMap<>();
	}

	record EntityKey(String type, UUID id) {
	}

	private final JdbcClient jdbc;
	private final JsonMapper json;
	private final AuditLog audit;
	private final AccessPolicy access;
	private final Map<String, EntityOperationHandler> handlers = new HashMap<>();
	private final TransactionTemplate savepoint;

	OperationProcessor(JdbcClient jdbc, JsonMapper json, AuditLog audit, AccessPolicy access,
			List<EntityOperationHandler> handlerBeans, PlatformTransactionManager tm) {
		this.jdbc = jdbc;
		this.json = json;
		this.audit = audit;
		this.access = access;
		for (EntityOperationHandler handler : handlerBeans) {
			if (handlers.put(handler.entityType(), handler) != null) {
				throw new IllegalStateException("Two handlers for entity type " + handler.entityType());
			}
		}
		this.savepoint = new TransactionTemplate(tm);
		this.savepoint.setPropagationBehavior(TransactionDefinition.PROPAGATION_NESTED);
	}

	/** Store then apply. Returns the acknowledgement for the operation. */
	OperationResult process(Operation op, String payloadJson, Batch batch) {
		int inserted = jdbc.sql("""
				INSERT INTO operation_log (operation_id, tenant_id, store_id, device_id, actor_user_id, local_seq, hlc,
				                           idempotency_key, entity_type, entity_id, op_type, schema_version, payload)
				VALUES (:operationId, :tenantId, :storeId, :deviceId, :actor, :localSeq, :hlc,
				        :idempotencyKey, :entityType, :entityId, :opType, :schemaVersion, CAST(:payload AS jsonb))
				ON CONFLICT DO NOTHING
				""")
				.param("operationId", op.operationId()).param("tenantId", op.tenantId()).param("storeId", op.storeId())
				.param("deviceId", op.deviceId()).param("actor", op.actorUserId()).param("localSeq", op.localSeq())
				.param("hlc", op.hlc().raw()).param("idempotencyKey", op.idempotencyKey())
				.param("entityType", op.entityType()).param("entityId", op.entityId()).param("opType", op.opType())
				.param("schemaVersion", op.schemaVersion()).param("payload", payloadJson).update();
		if (inserted == 0) {
			return duplicate(op);
		}
		return apply(op, batch, true);
	}

	/** Re-applies deferred operations whose awaited entity has registered, until nothing more wakes up. */
	void drainDeferred(Batch batch) {
		for (int round = 0; round < MAX_DRAIN_ROUNDS && !batch.registered.isEmpty(); round++) {
			List<EntityKey> keys = new ArrayList<>(batch.registered);
			batch.registered.clear();
			List<UUID> ids = keys.stream().map(EntityKey::id).toList();
			List<String> types = keys.stream().map(EntityKey::type).toList();
			List<Operation> woken = jdbc.sql("""
					SELECT o.* FROM operation_result r
					JOIN operation_log o ON o.tenant_id = r.tenant_id AND o.operation_id = r.operation_id
					JOIN unnest(CAST(:types AS text[]), CAST(:ids AS uuid[])) AS k(t, i)
					  ON r.waiting_entity_type = k.t AND r.waiting_entity_id = k.i
					WHERE r.status = 'deferred'
					ORDER BY o.hlc, o.local_seq
					""").param("types", types.toArray(String[]::new)).param("ids", ids.toArray(UUID[]::new))
					.query((rs, n) -> new Operation(rs.getObject("operation_id", UUID.class),
							rs.getObject("tenant_id", UUID.class), rs.getObject("store_id", UUID.class),
							rs.getObject("device_id", UUID.class), rs.getObject("actor_user_id", UUID.class),
							rs.getLong("local_seq"), Hlc.parse(rs.getString("hlc")), rs.getString("idempotency_key"),
							rs.getString("entity_type"), rs.getObject("entity_id", UUID.class), rs.getString("op_type"),
							rs.getInt("schema_version"), new Payload(json.readTree(rs.getString("payload")))))
					.list();
			for (Operation op : woken) {
				apply(op, batch, false);
			}
		}
	}

	private OperationResult duplicate(Operation op) {
		String existing = jdbc.sql("""
				SELECT r.status FROM operation_log o
				JOIN operation_result r ON r.tenant_id = o.tenant_id AND r.operation_id = o.operation_id
				WHERE o.operation_id = :id OR o.idempotency_key = :key
				ORDER BY (o.operation_id = :id) DESC LIMIT 1
				""").param("id", op.operationId()).param("key", op.idempotencyKey())
				.query(String.class).optional().orElse("applied");
		return new OperationResult(op.operationId(), "duplicate", existing, null, null);
	}

	private OperationResult apply(Operation op, Batch batch, boolean fresh) {
		EntityOperationHandler handler = handlers.get(op.entityType());
		if (handler == null) {
			return record(op, "rejected", "unknown_entity_type", "No handler for entity type '" + op.entityType() + "'", null);
		}
		if (op.schemaVersion() > handler.maxSchemaVersion()) {
			return record(op, "rejected", "unsupported_schema_version",
					"Server understands %s up to schema version %d".formatted(op.entityType(), handler.maxSchemaVersion()), null);
		}
		OperationContext ctx = new OperationContext(op, jdbc, json, audit, access);
		try {
			HandlerResult result = savepoint.execute(status -> {
				checkActor(op, handler, ctx, batch);
				HandlerResult r = handler.handle(op, ctx);
				if (r instanceof HandlerResult.Rejected) {
					status.setRollbackOnly();
				}
				else if (op.isCreate()) {
					registerEntity(op, batch);
				}
				return r;
			});
			if (result instanceof HandlerResult.Rejected rejected) {
				return record(op, "rejected", rejected.code(), rejected.detail(), null);
			}
			return record(op, ctx.raisedFlags().isEmpty() ? "applied" : "flagged",
					ctx.raisedFlags().isEmpty() ? null : String.join(",", ctx.raisedFlags()), null, null);
		}
		catch (MissingDependencyException ex) {
			return record(op, "deferred", "missing_dependency", ex.getMessage(), ex);
		}
		catch (InvalidPayloadException ex) {
			return record(op, "rejected", "invalid_payload", ex.getMessage(), null);
		}
		catch (DataIntegrityViolationException ex) {
			// e.g. a duplicate invoice number, a CHECK violation: a property of this op, so retrying cannot help
			log.warn("Operation {} violates an integrity rule: {}", op.operationId(), ex.getMostSpecificCause().getMessage());
			return record(op, "rejected", "integrity_violation", ex.getMostSpecificCause().getMessage(), null);
		}
	}

	private void checkActor(Operation op, EntityOperationHandler handler, OperationContext ctx, Batch batch) {
		if (op.actorUserId() == null) {
			return;
		}
		Set<String> roles = batch.rolesCache.computeIfAbsent(op.actorUserId() + "/" + op.storeId(),
				k -> access.rolesOf(op.actorUserId(), op.storeId()));
		if (roles.isEmpty()) {
			ctx.flag("unknown_actor", op.operationId().toString(), op.entityType(), op.entityId(),
					Map.of("actorUserId", op.actorUserId().toString()));
			return;
		}
		Set<com.ioxpert.tarazu.identity.Permission> needed = handler.permissions(op);
		if (!needed.isEmpty() && !AccessPolicy.permitsAny(roles, needed)) {
			ctx.flag("permission_violation", op.operationId().toString(), op.entityType(), op.entityId(),
					Map.of("actorUserId", op.actorUserId().toString(), "roles", roles.stream().sorted().toList(),
							"needsAnyOf", needed.stream().map(Enum::name).sorted().toList()));
		}
	}

	private void registerEntity(Operation op, Batch batch) {
		int added = jdbc.sql("""
				INSERT INTO entity_registry (tenant_id, entity_type, entity_id, operation_id)
				VALUES (:tenant, :type, :id, :op) ON CONFLICT DO NOTHING
				""").param("tenant", op.tenantId()).param("type", op.entityType()).param("id", op.entityId())
				.param("op", op.operationId()).update();
		if (added == 1) {
			batch.registered.add(new EntityKey(op.entityType(), op.entityId()));
		}
	}

	private OperationResult record(Operation op, String status, String code, String detail, MissingDependencyException waiting) {
		String storedCode = "flagged".equals(status) || "deferred".equals(status) || "rejected".equals(status) ? code : null;
		jdbc.sql("""
				INSERT INTO operation_result (tenant_id, operation_id, status, code, detail, waiting_entity_type, waiting_entity_id)
				VALUES (:tenant, :op, :status, :code, :detail, :wType, :wId)
				ON CONFLICT (tenant_id, operation_id) DO UPDATE
				    SET status = EXCLUDED.status, code = EXCLUDED.code, detail = EXCLUDED.detail,
				        waiting_entity_type = EXCLUDED.waiting_entity_type, waiting_entity_id = EXCLUDED.waiting_entity_id,
				        updated_at = now()
				""")
				.param("tenant", op.tenantId()).param("op", op.operationId()).param("status", status)
				.param("code", storedCode).param("detail", detail)
				.param("wType", waiting == null ? null : waiting.entityType())
				.param("wId", waiting == null ? null : waiting.entityId()).update();
		return new OperationResult(op.operationId(), status, null, storedCode, detail);
	}

	/** Current stored fate of an operation (it may have changed since process() if a deferred op woke up). */
	Optional<OperationResult> currentResult(UUID operationId) {
		return jdbc.sql("SELECT status, code, detail FROM operation_result WHERE operation_id = :id")
				.param("id", operationId)
				.query((rs, n) -> new OperationResult(operationId, rs.getString("status"), null, rs.getString("code"),
						rs.getString("detail")))
				.optional();
	}
}
