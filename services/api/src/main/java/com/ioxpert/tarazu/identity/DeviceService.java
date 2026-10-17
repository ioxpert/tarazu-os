package com.ioxpert.tarazu.identity;

import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.ioxpert.tarazu.tenancy.ApiException;
import com.ioxpert.tarazu.tenancy.TenantContext;
import com.ioxpert.tarazu.tenancy.TenantSession;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Device registration and revocation. Revocation is enforced by the authenticator on every request. */
@Service
class DeviceService {

	record Registration(UUID id, UUID storeId, String label, String token, boolean created) {
	}

	record DeviceView(UUID id, UUID storeId, String label, String status, java.time.Instant lastSeenAt,
			java.time.Instant revokedAt, String revokeReason) {
	}

	private static final SecureRandom RANDOM = new SecureRandom();

	private final JdbcClient jdbc;
	private final TenantSession tenantSession;
	private final AccessPolicy access;
	private final AuditLog audit;

	DeviceService(JdbcClient jdbc, TenantSession tenantSession, AccessPolicy access, AuditLog audit) {
		this.jdbc = jdbc;
		this.tenantSession = tenantSession;
		this.access = access;
		this.audit = audit;
	}

	/** Idempotent on the client-chosen id: a replay returns the device without a token (the secret is shown once). */
	@Transactional
	Registration register(UUID id, UUID storeId, String label) {
		tenantSession.bindCurrentTenant();
		access.require(Permission.DEVICE_MANAGE);
		var principal = TenantContext.principal();
		var existing = jdbc.sql("SELECT store_id, label FROM device WHERE id = :id").param("id", id)
				.query((rs, n) -> Map.entry(rs.getObject("store_id", UUID.class), String.valueOf(rs.getString("label"))))
				.optional();
		if (existing.isPresent()) {
			if (!existing.get().getKey().equals(storeId)) {
				throw ApiException.conflict("device_exists", "Device id already registered to another store");
			}
			return new Registration(id, storeId, label, null, false);
		}
		String secret = newSecret();
		try {
			jdbc.sql("""
					INSERT INTO device (id, tenant_id, store_id, label, token_hash, registered_by)
					VALUES (:id, :tenant, :store, :label, :hash, :by)
					""")
					.param("id", id).param("tenant", principal.tenant().value()).param("store", storeId)
					.param("label", label).param("hash", sha256(secret)).param("by", principal.userId()).update();
		}
		catch (DataIntegrityViolationException ex) {
			throw ApiException.unprocessable("unknown_store", "Store does not exist for this tenant");
		}
		audit.record(AuditLog.Entry.of("device.registered", "device", id, null).withDetails(Map.of("storeId", storeId)));
		String token = DeviceTokenAuthenticator.PREFIX + principal.tenant().value() + "." + id + "." + secret;
		return new Registration(id, storeId, label, token, true);
	}

	@Transactional
	void revoke(UUID id, String reason) {
		tenantSession.bindCurrentTenant();
		access.require(Permission.DEVICE_MANAGE);
		var principal = TenantContext.principal();
		int updated = jdbc.sql("""
				UPDATE device SET status = 'revoked', revoked_at = now(), revoked_by = :by, revoke_reason = :reason
				WHERE id = :id AND status = 'active'
				""").param("by", principal.userId()).param("reason", reason).param("id", id).update();
		if (updated == 1) {
			audit.record(AuditLog.Entry.of("device.revoked", "device", id, reason));
			return;
		}
		boolean exists = jdbc.sql("SELECT count(*) FROM device WHERE id = :id").param("id", id)
				.query(Long.class).single() > 0;
		if (!exists) {
			throw ApiException.notFound("device_not_found", "No such device");
		}
		// already revoked: idempotent
	}

	@Transactional(readOnly = true)
	List<DeviceView> list() {
		tenantSession.bindCurrentTenant();
		access.require(Permission.DEVICE_MANAGE);
		return jdbc.sql("""
				SELECT id, store_id, label, status, last_seen_at, revoked_at, revoke_reason FROM device ORDER BY created_at
				""").query((rs, n) -> new DeviceView(rs.getObject("id", UUID.class), rs.getObject("store_id", UUID.class),
				rs.getString("label"), rs.getString("status"),
				rs.getTimestamp("last_seen_at") == null ? null : rs.getTimestamp("last_seen_at").toInstant(),
				rs.getTimestamp("revoked_at") == null ? null : rs.getTimestamp("revoked_at").toInstant(),
				rs.getString("revoke_reason"))).list();
	}

	private static String newSecret() {
		byte[] bytes = new byte[32];
		RANDOM.nextBytes(bytes);
		return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
	}

	static byte[] sha256(String value) {
		try {
			return MessageDigest.getInstance("SHA-256").digest(DeviceTokenAuthenticator.utf8(value));
		}
		catch (NoSuchAlgorithmException ex) {
			throw new IllegalStateException(ex);
		}
	}
}
