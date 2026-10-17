package com.ioxpert.tarazu.syncgateway;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.ioxpert.tarazu.identity.AccessPolicy;
import com.ioxpert.tarazu.identity.AuditLog;
import org.springframework.jdbc.core.simple.JdbcClient;
import tools.jackson.databind.json.JsonMapper;

/** Services the gateway offers a handler while it applies one operation. */
public final class OperationContext {

	private final Operation op;
	private final JdbcClient jdbc;
	private final JsonMapper json;
	private final AuditLog audit;
	private final AccessPolicy access;
	private final List<String> raisedFlags = new ArrayList<>();

	OperationContext(Operation op, JdbcClient jdbc, JsonMapper json, AuditLog audit, AccessPolicy access) {
		this.op = op;
		this.jdbc = jdbc;
		this.json = json;
		this.audit = audit;
		this.access = access;
	}

	public boolean exists(String entityType, UUID entityId) {
		return jdbc.sql("SELECT 1 FROM entity_registry WHERE entity_type = :t AND entity_id = :i")
				.param("t", entityType).param("i", entityId).query(Integer.class).optional().isPresent();
	}

	/** Declares a dependency: if the entity is unknown the operation is deferred until it arrives. */
	public void require(String entityType, UUID entityId) {
		if (!exists(entityType, entityId)) {
			throw new MissingDependencyException(entityType, entityId);
		}
	}

	/** {@link #require} for many ids of one type in a single query. */
	public void requireAll(String entityType, java.util.Collection<UUID> ids) {
		if (ids.isEmpty()) {
			return;
		}
		java.util.Set<UUID> found = new java.util.HashSet<>(jdbc.sql(
				"SELECT entity_id FROM entity_registry WHERE entity_type = :t AND entity_id = ANY(:ids)")
				.param("t", entityType).param("ids", ids.toArray(UUID[]::new)).query(UUID.class).list());
		for (UUID id : ids) {
			if (!found.contains(id)) {
				throw new MissingDependencyException(entityType, id);
			}
		}
	}

	/**
	 * Raises a human-review flag. At most one open flag per (kind, scopeKey); re-raising is a no-op, so replays
	 * and re-evaluations never pile up.
	 */
	public void flag(String kind, String scopeKey, String entityType, UUID entityId, Map<String, Object> detail) {
		int inserted = jdbc.sql("""
				INSERT INTO conflict_flag (tenant_id, kind, scope_key, entity_type, entity_id, operation_id, detail)
				VALUES (:tenant, :kind, :scope, :entityType, :entityId, :op, CAST(:detail AS jsonb))
				ON CONFLICT (tenant_id, kind, scope_key) WHERE status = 'open' DO NOTHING
				""")
				.param("tenant", op.tenantId()).param("kind", kind).param("scope", scopeKey)
				.param("entityType", entityType).param("entityId", entityId).param("op", op.operationId())
				.param("detail", json.writeValueAsString(detail)).update();
		if (inserted == 1) {
			raisedFlags.add(kind);
		}
	}

	/** Closes the open flag for (kind, scopeKey), e.g. an oversold flag once stock is back above zero. */
	public void resolveFlag(String kind, String scopeKey, String note) {
		jdbc.sql("""
				UPDATE conflict_flag SET status = 'resolved', resolved_at = now(), resolution_note = :note
				WHERE kind = :kind AND scope_key = :scope AND status = 'open'
				""").param("kind", kind).param("scope", scopeKey).param("note", note).update();
	}

	/** Writes the audit trail, attributed to the op's actor and device. Once per (operation, action). */
	public void audit(String action, String entityType, UUID entityId, String reason, Map<String, Object> details) {
		audit.record(new AuditLog.Entry(action, entityType, entityId, reason, details, op.operationId(),
				op.actorUserId(), op.deviceId()));
	}

	/** Is this user an active owner? Only an owner's PIN approves voids, discounts and backdating. */
	public boolean isActiveOwner(UUID userId) {
		return access.isActiveOwner(userId);
	}

	List<String> raisedFlags() {
		return raisedFlags;
	}
}
