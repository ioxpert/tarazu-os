package com.ioxpert.tarazu.syncgateway;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.ioxpert.tarazu.identity.AccessPolicy;
import com.ioxpert.tarazu.identity.AuditLog;
import com.ioxpert.tarazu.identity.Permission;
import com.ioxpert.tarazu.tenancy.ApiException;
import com.ioxpert.tarazu.tenancy.TenantContext;
import com.ioxpert.tarazu.tenancy.TenantSession;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.json.JsonMapper;

/**
 * What the server made of this device's operations, and the review queue. The device uses it to decide
 * between "backed up" and "action required".
 */
@RestController
@RequestMapping("/v1/sync")
class SyncStatusController {

	record StatusResponse(long applied, long flagged, long deferred, long rejected, long openFlags, Instant lastOperationAt) {
	}

	record RejectedItem(UUID operationId, String entityType, UUID entityId, String code, String detail) {
	}

	record FlagItem(UUID id, String kind, String entityType, UUID entityId, UUID operationId, String status,
			Map<String, Object> detail, Instant createdAt, Instant resolvedAt, String resolutionNote) {
	}

	record ResolveRequest(@NotNull @Pattern(regexp = "resolved|dismissed") String status, @NotBlank @Size(max = 500) String note) {
	}

	private final JdbcClient jdbc;
	private final TenantSession tenantSession;
	private final AccessPolicy access;
	private final AuditLog audit;
	private final JsonMapper json;

	SyncStatusController(JdbcClient jdbc, TenantSession tenantSession, AccessPolicy access, AuditLog audit,
			JsonMapper json) {
		this.jdbc = jdbc;
		this.tenantSession = tenantSession;
		this.access = access;
		this.audit = audit;
		this.json = json;
	}

	/** Counts are for the calling device when authenticated as one, otherwise for the whole tenant. */
	@GetMapping("/status")
	@Transactional(readOnly = true)
	StatusResponse status() {
		tenantSession.bindCurrentTenant();
		UUID device = TenantContext.principal().deviceId();
		return jdbc.sql("""
				SELECT count(*) FILTER (WHERE r.status = 'applied') AS applied,
				       count(*) FILTER (WHERE r.status = 'flagged') AS flagged,
				       count(*) FILTER (WHERE r.status = 'deferred') AS deferred,
				       count(*) FILTER (WHERE r.status = 'rejected') AS rejected,
				       max(o.received_at) AS last_at,
				       (SELECT count(*) FROM conflict_flag WHERE status = 'open') AS open_flags
				FROM operation_log o JOIN operation_result r ON r.tenant_id = o.tenant_id AND r.operation_id = o.operation_id
				WHERE (CAST(:device AS uuid) IS NULL OR o.device_id = :device)
				""").param("device", device)
				.query((rs, n) -> new StatusResponse(rs.getLong("applied"), rs.getLong("flagged"), rs.getLong("deferred"),
						rs.getLong("rejected"), rs.getLong("open_flags"),
						rs.getTimestamp("last_at") == null ? null : rs.getTimestamp("last_at").toInstant()))
				.single();
	}

	@GetMapping("/rejected")
	@Transactional(readOnly = true)
	List<RejectedItem> rejected(@RequestParam(defaultValue = "100") int limit) {
		tenantSession.bindCurrentTenant();
		UUID device = TenantContext.principal().deviceId();
		return jdbc.sql("""
				SELECT o.operation_id, o.entity_type, o.entity_id, r.code, r.detail
				FROM operation_log o JOIN operation_result r ON r.tenant_id = o.tenant_id AND r.operation_id = o.operation_id
				WHERE r.status = 'rejected' AND (CAST(:device AS uuid) IS NULL OR o.device_id = :device)
				ORDER BY o.received_at DESC LIMIT :limit
				""").param("device", device).param("limit", Math.max(1, Math.min(limit, 500)))
				.query((rs, n) -> new RejectedItem(rs.getObject("operation_id", UUID.class), rs.getString("entity_type"),
						rs.getObject("entity_id", UUID.class), rs.getString("code"), rs.getString("detail")))
				.list();
	}

	@GetMapping("/flags")
	@Transactional(readOnly = true)
	List<FlagItem> flags(@RequestParam(defaultValue = "open") @Pattern(regexp = "open|resolved|dismissed") String status,
			@RequestParam(defaultValue = "100") int limit) {
		tenantSession.bindCurrentTenant();
		return jdbc.sql("""
				SELECT id, kind, entity_type, entity_id, operation_id, status, detail::text AS detail, created_at,
				       resolved_at, resolution_note
				FROM conflict_flag WHERE status = :status ORDER BY created_at DESC LIMIT :limit
				""").param("status", status).param("limit", Math.max(1, Math.min(limit, 500)))
				.query((rs, n) -> new FlagItem(rs.getObject("id", UUID.class), rs.getString("kind"),
						rs.getString("entity_type"), rs.getObject("entity_id", UUID.class),
						rs.getObject("operation_id", UUID.class), rs.getString("status"), readMap(rs.getString("detail")),
						rs.getTimestamp("created_at").toInstant(),
						rs.getTimestamp("resolved_at") == null ? null : rs.getTimestamp("resolved_at").toInstant(),
						rs.getString("resolution_note")))
				.list();
	}

	@PostMapping("/flags/{id}/resolve")
	@Transactional
	ResponseEntity<Void> resolve(@PathVariable UUID id, @Valid @RequestBody ResolveRequest body) {
		tenantSession.bindCurrentTenant();
		access.require(Permission.RESOLVE_FLAGS);
		int updated = jdbc.sql("""
				UPDATE conflict_flag SET status = :status, resolved_at = now(), resolved_by = :by, resolution_note = :note
				WHERE id = :id AND status = 'open'
				""").param("status", body.status()).param("by", TenantContext.principal().userId())
				.param("note", body.note()).param("id", id).update();
		if (updated == 0) {
			boolean exists = jdbc.sql("SELECT count(*) FROM conflict_flag WHERE id = :id").param("id", id)
					.query(Long.class).single() > 0;
			if (!exists) {
				throw ApiException.notFound("flag_not_found", "No such flag");
			}
			return ResponseEntity.noContent().build();
		}
		audit.record(AuditLog.Entry.of("flag." + body.status(), "conflict_flag", id, body.note()));
		return ResponseEntity.noContent().build();
	}

	@SuppressWarnings("unchecked")
	private Map<String, Object> readMap(String raw) {
		return json.readValue(raw, Map.class);
	}
}
