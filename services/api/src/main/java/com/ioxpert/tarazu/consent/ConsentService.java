package com.ioxpert.tarazu.consent;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import com.ioxpert.tarazu.identity.AccessPolicy;
import com.ioxpert.tarazu.identity.AuditLog;
import com.ioxpert.tarazu.identity.Permission;
import com.ioxpert.tarazu.tenancy.ApiException;
import com.ioxpert.tarazu.tenancy.TenantContext;
import com.ioxpert.tarazu.tenancy.TenantSession;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
class ConsentService {

	record EventView(UUID id, String subjectType, UUID subjectId, String purpose, String action, String policyVersion,
			String channel, Instant occurredAt) {
	}

	record SharingView(UUID id, String subjectType, UUID subjectId, String purpose, String recipient,
			List<String> dataCategories, UUID consentEventId, Instant sharedAt) {
	}

	record Mode(boolean localOnly) {
	}

	private final JdbcClient jdbc;
	private final TenantSession tenantSession;
	private final AccessPolicy access;
	private final AuditLog audit;
	private final TenantSettings settings;

	ConsentService(JdbcClient jdbc, TenantSession tenantSession, AccessPolicy access, AuditLog audit,
			TenantSettings settings) {
		this.jdbc = jdbc;
		this.tenantSession = tenantSession;
		this.access = access;
		this.audit = audit;
		this.settings = settings;
	}

	/** Idempotent on the event id / idempotency key: a replay returns the stored event unchanged. */
	@Transactional
	EventView record(UUID id, String idempotencyKey, String subjectType, UUID subjectId, String purpose, String action,
			String policyVersion, String channel, Instant occurredAt) {
		tenantSession.bindCurrentTenant();
		access.require(Permission.CONSENT_RECORD);
		requirePurpose(purpose);
		var principal = TenantContext.principal();
		int inserted = jdbc.sql("""
				INSERT INTO consent_event (id, tenant_id, subject_type, subject_id, purpose, action, policy_version, channel,
				                           recorded_by, idempotency_key, occurred_at)
				VALUES (:id, :tenant, :subjectType, :subject, :purpose, :action, :policy, :channel, :by, :key, :at)
				ON CONFLICT DO NOTHING
				""").param("id", id).param("tenant", principal.tenant().value()).param("subjectType", subjectType)
				.param("subject", subjectId).param("purpose", purpose).param("action", action).param("policy", policyVersion)
				.param("channel", channel).param("by", principal.userId()).param("key", idempotencyKey)
				.param("at", java.sql.Timestamp.from(occurredAt)).update();
		if (inserted == 1) {
			audit.record(AuditLog.Entry.of("consent." + action, subjectType, subjectId, purpose)
					.withDetails(java.util.Map.of("policyVersion", policyVersion, "channel", channel)));
		}
		return jdbc.sql("""
				SELECT id, subject_type, subject_id, purpose, action, policy_version, channel, occurred_at
				FROM consent_event WHERE id = :id OR idempotency_key = :key ORDER BY (id = :id) DESC LIMIT 1
				""").param("id", id).param("key", idempotencyKey).query(this::event).single();
	}

	@Transactional(readOnly = true)
	List<EventView> current(String subjectType, UUID subjectId) {
		tenantSession.bindCurrentTenant();
		return jdbc.sql("""
				SELECT event_id AS id, subject_type, subject_id, purpose, action, policy_version, channel, occurred_at
				FROM consent_current WHERE subject_type = :type AND subject_id = :id ORDER BY purpose
				""").param("type", subjectType).param("id", subjectId).query(this::event).list();
	}

	@Transactional(readOnly = true)
	List<EventView> history(String subjectType, UUID subjectId) {
		tenantSession.bindCurrentTenant();
		return jdbc.sql("""
				SELECT id, subject_type, subject_id, purpose, action, policy_version, channel, occurred_at
				FROM consent_event WHERE subject_type = :type AND subject_id = :id ORDER BY occurred_at, created_at
				""").param("type", subjectType).param("id", subjectId).query(this::event).list();
	}

	/** Logs a disclosure. Refused unless the subject's latest event for the purpose is a grant, and never in local-only mode. */
	@Transactional
	SharingView logSharing(UUID id, String idempotencyKey, String subjectType, UUID subjectId, String purpose,
			String recipient, List<String> dataCategories, Instant sharedAt) {
		tenantSession.bindCurrentTenant();
		access.require(Permission.CONSENT_RECORD);
		ConsentPurpose p = requirePurpose(purpose);
		if (!p.sharesWithThirdParty()) {
			throw ApiException.unprocessable("purpose_has_no_sharing", "Purpose '" + purpose + "' does not involve third parties");
		}
		if (settings.isLocalOnly()) {
			throw ApiException.conflict("local_only_mode", "This merchant is in local-only mode; nothing may be shared");
		}
		var existing = jdbc.sql("SELECT id FROM third_party_sharing_log WHERE id = :id OR idempotency_key = :key")
				.param("id", id).param("key", idempotencyKey).query(UUID.class).optional();
		if (existing.isEmpty()) {
			var grant = jdbc.sql("""
					SELECT event_id FROM consent_current
					WHERE subject_type = :type AND subject_id = :subject AND purpose = :purpose AND action = 'grant'
					""").param("type", subjectType).param("subject", subjectId).param("purpose", purpose)
					.query(UUID.class).optional();
			if (grant.isEmpty()) {
				throw ApiException.conflict("consent_not_granted",
						"No active consent for purpose '" + purpose + "' (never given, or withdrawn)");
			}
			try {
				jdbc.sql("""
						INSERT INTO third_party_sharing_log (id, tenant_id, subject_type, subject_id, purpose, recipient,
						                                     data_categories, consent_event_id, idempotency_key, shared_at)
						VALUES (:id, :tenant, :type, :subject, :purpose, :recipient, :categories, :event, :key, :at)
						""").param("id", id).param("tenant", TenantContext.require().value()).param("type", subjectType)
						.param("subject", subjectId).param("purpose", purpose).param("recipient", recipient)
						.param("categories", dataCategories.toArray(String[]::new)).param("event", grant.get())
						.param("key", idempotencyKey).param("at", java.sql.Timestamp.from(sharedAt)).update();
			}
			catch (DuplicateKeyException ex) {
				// concurrent replay: fall through to the read below
			}
		}
		return jdbc.sql("""
				SELECT id, subject_type, subject_id, purpose, recipient, data_categories, consent_event_id, shared_at
				FROM third_party_sharing_log WHERE id = :id OR idempotency_key = :key ORDER BY (id = :id) DESC LIMIT 1
				""").param("id", id).param("key", idempotencyKey).query(this::sharing).single();
	}

	@Transactional(readOnly = true)
	List<SharingView> sharingLog(String subjectType, UUID subjectId) {
		tenantSession.bindCurrentTenant();
		return jdbc.sql("""
				SELECT id, subject_type, subject_id, purpose, recipient, data_categories, consent_event_id, shared_at
				FROM third_party_sharing_log
				WHERE (CAST(:type AS text) IS NULL OR subject_type = :type) AND (CAST(:subject AS uuid) IS NULL OR subject_id = :subject)
				ORDER BY shared_at DESC LIMIT 500
				""").param("type", subjectType).param("subject", subjectId).query(this::sharing).list();
	}

	@Transactional(readOnly = true)
	Mode mode() {
		tenantSession.bindCurrentTenant();
		return new Mode(settings.isLocalOnly());
	}

	@Transactional
	Mode setMode(boolean localOnly, String reason) {
		tenantSession.bindCurrentTenant();
		access.require(Permission.SETTINGS_MANAGE);
		var principal = TenantContext.principal();
		boolean before = settings.isLocalOnly();
		jdbc.sql("""
				INSERT INTO tenant_setting (tenant_id, local_only, updated_by) VALUES (:tenant, :mode, :by)
				ON CONFLICT (tenant_id) DO UPDATE SET local_only = EXCLUDED.local_only, updated_at = now(), updated_by = EXCLUDED.updated_by
				""").param("tenant", principal.tenant().value()).param("mode", localOnly).param("by", principal.userId()).update();
		if (before != localOnly) {
			audit.record(AuditLog.Entry.of("tenant.local_only_set", "tenant", principal.tenant().value(), reason)
					.withDetails(java.util.Map.of("localOnly", localOnly)));
		}
		return new Mode(localOnly);
	}

	private static ConsentPurpose requirePurpose(String purpose) {
		return ConsentPurpose.fromWire(purpose)
				.orElseThrow(() -> ApiException.unprocessable("unknown_purpose", "Unknown consent purpose: " + purpose));
	}

	private EventView event(java.sql.ResultSet rs, int n) throws java.sql.SQLException {
		return new EventView(rs.getObject("id", UUID.class), rs.getString("subject_type"),
				rs.getObject("subject_id", UUID.class), rs.getString("purpose"), rs.getString("action"),
				rs.getString("policy_version"), rs.getString("channel"), rs.getTimestamp("occurred_at").toInstant());
	}

	private SharingView sharing(java.sql.ResultSet rs, int n) throws java.sql.SQLException {
		return new SharingView(rs.getObject("id", UUID.class), rs.getString("subject_type"),
				rs.getObject("subject_id", UUID.class), rs.getString("purpose"), rs.getString("recipient"),
				List.of((String[]) rs.getArray("data_categories").getArray()), rs.getObject("consent_event_id", UUID.class),
				rs.getTimestamp("shared_at").toInstant());
	}
}
