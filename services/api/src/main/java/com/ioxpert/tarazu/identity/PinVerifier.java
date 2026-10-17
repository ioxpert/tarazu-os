package com.ioxpert.tarazu.identity;

import java.time.Duration;
import java.time.Instant;
import java.util.UUID;

import com.ioxpert.tarazu.tenancy.TenantId;
import com.ioxpert.tarazu.tenancy.TenantSession;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Checks a staff PIN and keeps the failure counter. Runs in its own transaction so a failed attempt
 * is counted even though the request that caused it is then rejected.
 */
@Component
class PinVerifier {

	static final int MAX_FAILURES = 5;
	static final Duration LOCK = Duration.ofMinutes(15);

	enum Status { OK, INVALID, LOCKED, NO_PIN, UNKNOWN_USER }

	private record Row(byte[] salt, byte[] hash, Integer iterations, int failed, Instant lockedUntil, boolean active) {
	}

	private final JdbcClient jdbc;
	private final TenantSession tenantSession;
	private final PinHasher hasher;
	private final TransactionTemplate tx;

	PinVerifier(JdbcClient jdbc, TenantSession tenantSession, PinHasher hasher, PlatformTransactionManager tm) {
		this.jdbc = jdbc;
		this.tenantSession = tenantSession;
		this.hasher = hasher;
		this.tx = new TransactionTemplate(tm);
	}

	Status verify(TenantId tenant, UUID userId, String pin) {
		return tx.execute(status -> {
			tenantSession.bind(tenant);
			Row row = jdbc.sql("""
					SELECT pin_salt, pin_hash, pin_iterations, pin_failed_count, pin_locked_until, status = 'active' AS active
					FROM app_user WHERE id = :id FOR UPDATE
					""").param("id", userId).query((rs, n) -> new Row(rs.getBytes("pin_salt"), rs.getBytes("pin_hash"),
					(Integer) rs.getObject("pin_iterations"), rs.getInt("pin_failed_count"),
					rs.getTimestamp("pin_locked_until") == null ? null : rs.getTimestamp("pin_locked_until").toInstant(),
					rs.getBoolean("active"))).optional().orElse(null);
			if (row == null || !row.active()) {
				return Status.UNKNOWN_USER;
			}
			if (row.hash() == null) {
				return Status.NO_PIN;
			}
			if (row.lockedUntil() != null && row.lockedUntil().isAfter(Instant.now())) {
				return Status.LOCKED;
			}
			if (pin != null && hasher.matches(pin, row.salt(), row.hash(), row.iterations())) {
				if (row.failed() > 0 || row.lockedUntil() != null) {
					jdbc.sql("UPDATE app_user SET pin_failed_count = 0, pin_locked_until = NULL WHERE id = :id")
							.param("id", userId).update();
				}
				return Status.OK;
			}
			int failed = row.failed() + 1;
			boolean lock = failed >= MAX_FAILURES;
			jdbc.sql("""
					UPDATE app_user SET pin_failed_count = :failed,
					       pin_locked_until = CASE WHEN :lock THEN now() + make_interval(secs => :secs) END
					WHERE id = :id
					""").param("failed", lock ? 0 : failed).param("lock", lock).param("secs", LOCK.toSeconds())
					.param("id", userId).update();
			return lock ? Status.LOCKED : Status.INVALID;
		});
	}
}
