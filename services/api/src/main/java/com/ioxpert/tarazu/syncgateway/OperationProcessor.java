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
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.dao.TransientDataAccessException;
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
	private static final int STUCK_DAYS = 3;

	/** Per-batch scratch: entities registered (to wake deferred ops) and role lookups. */
	static final class Batch {
		final Set<EntityKey> registered = new HashSet<>();
		boolean parked;
		/** Every entity this batch registered; unlike {@code registered} it is not drained, it drives the post-commit sweep. */
		final Set<EntityKey> everRegistered = new HashSet<>();
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

	/**
	 * Stores the whole batch in the immutable operation log with one statement and returns the ids that were new.
	 * Everything else was received before (same operation id or idempotency key) and is a duplicate.
	 */
	Set<UUID> storeAll(List<Operation> ops, List<String> declaredHlcs, List<String> payloadJson) {
		int n = ops.size();
		UUID[] ids = new UUID[n];
		UUID[] stores = new UUID[n];
		UUID[] devices = new UUID[n];
		UUID[] actors = new UUID[n];
		Long[] seqs = new Long[n];
		String[] hlcs = new String[n];
		String[] keys = new String[n];
		String[] types = new String[n];
		UUID[] entities = new UUID[n];
		String[] opTypes = new String[n];
		Integer[] versions = new Integer[n];
		String[] payloads = payloadJson.toArray(String[]::new);
		for (int i = 0; i < n; i++) {
			Operation op = ops.get(i);
			ids[i] = op.operationId();
			stores[i] = op.storeId();
			devices[i] = op.deviceId();
			actors[i] = op.actorUserId();
			seqs[i] = op.localSeq();
			hlcs[i] = declaredHlcs.get(i); // the log keeps what the device sent, not the clamped merge clock
			keys[i] = op.idempotencyKey();
			types[i] = op.entityType();
			entities[i] = op.entityId();
			opTypes[i] = op.opType();
			versions[i] = op.schemaVersion();
		}
		return new HashSet<>(jdbc.sql("""
				INSERT INTO operation_log (tenant_id, operation_id, store_id, device_id, actor_user_id, local_seq, hlc,
				                           idempotency_key, entity_type, entity_id, op_type, schema_version, payload)
				SELECT :tenant, t.operation_id, t.store_id, t.device_id, t.actor_user_id, t.local_seq, t.hlc,
				       t.idempotency_key, t.entity_type, t.entity_id, t.op_type, t.schema_version, CAST(t.payload AS jsonb)
				FROM unnest(CAST(:ids AS uuid[]), CAST(:stores AS uuid[]), CAST(:devices AS uuid[]), CAST(:actors AS uuid[]),
				            CAST(:seqs AS bigint[]), CAST(:hlcs AS text[]), CAST(:keys AS text[]), CAST(:types AS text[]),
				            CAST(:entities AS uuid[]), CAST(:opTypes AS text[]), CAST(:versions AS integer[]),
				            CAST(:payloads AS text[]))
				     AS t(operation_id, store_id, device_id, actor_user_id, local_seq, hlc, idempotency_key, entity_type,
				          entity_id, op_type, schema_version, payload)
				ON CONFLICT DO NOTHING
				RETURNING operation_id
				""")
				.param("tenant", ops.get(0).tenantId()).param("ids", ids).param("stores", stores).param("devices", devices)
				.param("actors", actors).param("seqs", seqs).param("hlcs", hlcs).param("keys", keys).param("types", types)
				.param("entities", entities).param("opTypes", opTypes).param("versions", versions)
				.param("payloads", payloads).query(UUID.class).list());
	}

	/** Acknowledgements for operations that were already stored, looked up in one query. */
	Map<UUID, OperationResult> duplicateResults(List<Operation> dups) {
		if (dups.isEmpty()) {
			return Map.of();
		}
		UUID[] ids = dups.stream().map(Operation::operationId).toArray(UUID[]::new);
		String[] keys = dups.stream().map(Operation::idempotencyKey).toArray(String[]::new);
		record Known(UUID id, String key, String status) {
		}
		List<Known> known = jdbc.sql("""
				SELECT o.operation_id, o.idempotency_key, r.status FROM operation_log o
				JOIN operation_result r ON r.tenant_id = o.tenant_id AND r.operation_id = o.operation_id
				WHERE o.operation_id = ANY(:ids) OR o.idempotency_key = ANY(:keys)
				""").param("ids", ids).param("keys", keys)
				.query((rs, i) -> new Known(rs.getObject("operation_id", UUID.class), rs.getString("idempotency_key"),
						rs.getString("status")))
				.list();
		Map<UUID, String> byId = new HashMap<>();
		Map<String, String> byKey = new HashMap<>();
		for (Known k : known) {
			byId.put(k.id(), k.status());
			byKey.put(k.key(), k.status());
		}
		Map<UUID, OperationResult> out = new HashMap<>();
		for (Operation op : dups) {
			String status = byId.getOrDefault(op.operationId(), byKey.getOrDefault(op.idempotencyKey(), "applied"));
			out.put(op.operationId(), new OperationResult(op.operationId(), "duplicate", status, null, null));
		}
		return out;
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
					FOR UPDATE OF r SKIP LOCKED
					""").param("types", types.toArray(String[]::new)).param("ids", ids.toArray(UUID[]::new))
					.query((rs, n) -> toOperation(rs))
					.list();
			for (Operation op : woken) {
				apply(op, batch);
			}
		}
	}

	/**
	 * Applies any parked operation whose awaited entity now exists. Run after the upload transaction commits: of two
	 * concurrent requests, one parking a child and one registering its parent, whichever commits later is guaranteed
	 * to see the other's committed rows here, so no wake-up is ever lost (also heals a crash between park and wake).
	 * Cheap: the index covers only deferred rows. Returns how many operations it applied.
	 */
	int sweepDeferred(Batch batch) {
		flagStuck();
		int applied = 0;
		for (int round = 0; round < MAX_DRAIN_ROUNDS; round++) {
			List<Operation> stuck = jdbc.sql("""
					SELECT o.* FROM operation_result r
					JOIN operation_log o ON o.tenant_id = r.tenant_id AND o.operation_id = r.operation_id
					JOIN entity_registry e ON e.tenant_id = r.tenant_id AND e.entity_type = r.waiting_entity_type
					                      AND e.entity_id = r.waiting_entity_id
					WHERE r.status = 'deferred'
					ORDER BY o.hlc, o.local_seq
					LIMIT 500
					FOR UPDATE OF r SKIP LOCKED
					""").query((rs, n) -> toOperation(rs)).list();
			if (stuck.isEmpty()) {
				return applied;
			}
			for (Operation op : stuck) {
				apply(op, batch);
				applied++;
			}
			drainDeferred(batch);
		}
		return applied;
	}

	/**
	 * A parent that never arrives (its create was rejected, or the device that owns it was lost) would leave a child
	 * deferred forever, invisible to the merchant. After {@value #STUCK_DAYS} days it becomes a review flag.
	 */
	private void flagStuck() {
		jdbc.sql("""
				INSERT INTO conflict_flag (tenant_id, kind, scope_key, entity_type, entity_id, operation_id, detail)
				SELECT o.tenant_id, 'stuck_operation', o.operation_id::text, o.entity_type, o.entity_id, o.operation_id,
				       jsonb_build_object('waitingFor', r.waiting_entity_type || ' ' || r.waiting_entity_id)
				FROM operation_result r JOIN operation_log o ON o.tenant_id = r.tenant_id AND o.operation_id = r.operation_id
				WHERE r.status = 'deferred' AND r.updated_at < now() - make_interval(days => :days)
				ON CONFLICT (tenant_id, kind, scope_key) WHERE status = 'open' DO NOTHING
				""").param("days", STUCK_DAYS).update();
	}

	Operation toOperation(java.sql.ResultSet rs) throws java.sql.SQLException {
		Hlc declared = Hlc.parse(rs.getString("hlc"));
		java.time.Instant receivedAt = rs.getTimestamp("received_at").toInstant();
		return new Operation(rs.getObject("operation_id", UUID.class), rs.getObject("tenant_id", UUID.class),
				rs.getObject("store_id", UUID.class), rs.getObject("device_id", UUID.class),
				rs.getObject("actor_user_id", UUID.class), rs.getLong("local_seq"), declared.effectiveAt(receivedAt),
				rs.getString("idempotency_key"), rs.getString("entity_type"), rs.getObject("entity_id", UUID.class),
				rs.getString("op_type"), rs.getInt("schema_version"), new Payload(json.readTree(rs.getString("payload"))),
				declared.isSkewedAt(receivedAt));
	}

	OperationResult apply(Operation op, Batch batch) {
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
				else if (op.isCreate() && handler.registersEntity()) {
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
			batch.parked = true;
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
		catch (TransientDataAccessException | DataAccessResourceFailureException ex) {
			throw ex; // deadlock, timeout, lost connection: the whole batch rolls back and the device retries it unchanged
		}
		catch (RuntimeException ex) {
			// A bug in a handler must not wedge a merchant's whole upload queue behind one operation. The raw op is
			// already in the immutable log, so it can be re-applied after a fix; the device shows "action required".
			log.error("Operation {} ({} {}) failed unexpectedly", op.operationId(), op.entityType(), op.opType(), ex);
			return record(op, "rejected", "internal_error", "The server could not apply this operation; it has been kept for review", null);
		}
	}

	private void checkActor(Operation op, EntityOperationHandler handler, OperationContext ctx, Batch batch) {
		if (op.clockSkewed()) {
			ctx.flag("clock_skew", op.operationId().toString(), op.entityType(), op.entityId(),
					Map.of("deviceId", op.deviceId().toString(), "mergedAs", op.hlc().raw()));
		}
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
			batch.everRegistered.add(new EntityKey(op.entityType(), op.entityId()));
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

	/** Sort key: client order first, then hot-row operations in global lock order (see EntityOperationHandler.lockTier). */
	String lockOrder(Operation op, int requestIndex) {
		EntityOperationHandler handler = handlers.get(op.entityType());
		if (handler == null || handler.lockTier() < 0) {
			return "0|%06d".formatted(requestIndex);
		}
		return "1|%02d|%s|%012d|%06d".formatted(handler.lockTier(), handler.lockKey(op), op.localSeq(), requestIndex);
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
