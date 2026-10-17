package com.ioxpert.tarazu.identity;

import java.util.Map;
import java.util.UUID;

import com.ioxpert.tarazu.tenancy.TenantContext;
import com.ioxpert.tarazu.tenancy.UuidV7;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import tools.jackson.databind.json.JsonMapper;

/**
 * Append-only audit trail: actor, action, reason, timestamp. Writes join the caller's transaction,
 * so an audited action and its audit row commit or roll back together.
 */
@Component
public class AuditLog {

	/** @param operationId when set, (operation, action) is unique so replaying an operation never double-logs */
	public record Entry(String action, String entityType, UUID entityId, String reason, Map<String, Object> details,
			UUID operationId, UUID actorUserId, UUID actorDeviceId) {

		public static Entry of(String action, String entityType, UUID entityId, String reason) {
			return new Entry(action, entityType, entityId, reason, Map.of(), null, null, null);
		}

		public Entry withDetails(Map<String, Object> details) {
			return new Entry(action, entityType, entityId, reason, details, operationId, actorUserId, actorDeviceId);
		}

		public Entry byOperation(UUID operationId, UUID actorUserId, UUID actorDeviceId) {
			return new Entry(action, entityType, entityId, reason, details, operationId, actorUserId, actorDeviceId);
		}
	}

	private final JdbcClient jdbc;
	private final JsonMapper json;

	AuditLog(JdbcClient jdbc, JsonMapper json) {
		this.jdbc = jdbc;
		this.json = json;
	}

	/** Requires a tenant-bound transaction. Missing actor fields default to the current principal. */
	public void record(Entry entry) {
		var principal = TenantContext.principal();
		UUID user = entry.actorUserId() != null ? entry.actorUserId() : principal.userId();
		UUID device = entry.actorDeviceId() != null ? entry.actorDeviceId() : principal.deviceId();
		jdbc.sql("""
				INSERT INTO audit_log (id, tenant_id, actor_user_id, actor_device_id, action, entity_type, entity_id,
				                       reason, details, operation_id)
				VALUES (:id, :tenant, :user, :device, :action, :entityType, :entityId, :reason,
				        CAST(:details AS jsonb), :operationId)
				ON CONFLICT DO NOTHING
				""")
				.param("id", UuidV7.next())
				.param("tenant", principal.tenant().value())
				.param("user", user)
				.param("device", device)
				.param("action", entry.action())
				.param("entityType", entry.entityType())
				.param("entityId", entry.entityId())
				.param("reason", entry.reason())
				.param("details", json.writeValueAsString(entry.details()))
				.param("operationId", entry.operationId())
				.update();
	}
}
