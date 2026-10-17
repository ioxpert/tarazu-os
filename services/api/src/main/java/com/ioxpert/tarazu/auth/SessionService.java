package com.ioxpert.tarazu.auth;

import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Base64;
import java.util.UUID;

import com.ioxpert.tarazu.tenancy.UuidV7;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/** Opaque bearer sessions: {@code tzs.<tenantId>.<sessionId>.<secret>}; only a SHA-256 of the secret is stored. */
@Component
class SessionService {

	static final String PREFIX = "tzs.";
	private static final SecureRandom RANDOM = new SecureRandom();

	record Issued(String token, Instant expiresAt, UUID sessionId) {
	}

	private final JdbcClient jdbc;
	private final OtpSettings settings;

	SessionService(JdbcClient jdbc, OtpSettings settings) {
		this.jdbc = jdbc;
		this.settings = settings;
	}

	/** Inside a tenant-bound transaction. */
	Issued issue(UUID tenantId, UUID userId) {
		byte[] raw = new byte[32];
		RANDOM.nextBytes(raw);
		String secret = Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
		UUID id = UuidV7.next();
		Instant expires = Instant.now().plus(settings.sessionDays(), ChronoUnit.DAYS);
		jdbc.sql("""
				INSERT INTO auth_session (tenant_id, id, user_id, token_hash, expires_at) VALUES (:t, :id, :u, :h, :exp)
				""").param("t", tenantId).param("id", id).param("u", userId).param("h", sha256(secret))
				.param("exp", java.sql.Timestamp.from(expires)).update();
		return new Issued(PREFIX + tenantId + "." + id + "." + secret, expires, id);
	}

	static byte[] sha256(String value) {
		try {
			return MessageDigest.getInstance("SHA-256").digest(value.getBytes(java.nio.charset.StandardCharsets.UTF_8));
		}
		catch (java.security.NoSuchAlgorithmException ex) {
			throw new IllegalStateException(ex);
		}
	}
}
