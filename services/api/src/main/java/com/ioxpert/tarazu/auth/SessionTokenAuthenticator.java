package com.ioxpert.tarazu.auth;

import java.security.MessageDigest;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

import com.ioxpert.tarazu.identity.AccessPolicy;
import com.ioxpert.tarazu.tenancy.ApiException;
import com.ioxpert.tarazu.tenancy.Principal;
import com.ioxpert.tarazu.tenancy.RequestAuthenticator;
import com.ioxpert.tarazu.tenancy.TenantId;
import com.ioxpert.tarazu.tenancy.TenantSession;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/** Authenticates an owner/staff session (after OTP login). The principal has the user and all their roles. */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 1)
class SessionTokenAuthenticator implements RequestAuthenticator {

	private final JdbcClient jdbc;
	private final TenantSession tenantSession;
	private final AccessPolicy access;
	private final TransactionTemplate tx;

	SessionTokenAuthenticator(JdbcClient jdbc, TenantSession tenantSession, AccessPolicy access, PlatformTransactionManager tm) {
		this.jdbc = jdbc;
		this.tenantSession = tenantSession;
		this.access = access;
		this.tx = new TransactionTemplate(tm);
	}

	/** {tenant, session, secret} from a "Bearer tzs...." header, or null if it is not a session token. */
	static String[] parse(String header) {
		if (header == null || !header.startsWith("Bearer " + SessionService.PREFIX)) {
			return null;
		}
		String[] parts = header.substring("Bearer ".length()).trim().split("\\.", 4);
		if (parts.length != 4) {
			throw ApiException.unauthorized("invalid_token", "Malformed session token");
		}
		return parts;
	}

	@Override
	public Optional<Principal> authenticate(HttpServletRequest request) {
		String[] parts = parse(request.getHeader("Authorization"));
		if (parts == null) {
			return Optional.empty();
		}
		UUID tenantId;
		UUID sessionId;
		try {
			tenantId = UUID.fromString(parts[1]);
			sessionId = UUID.fromString(parts[2]);
		}
		catch (IllegalArgumentException ex) {
			throw ApiException.unauthorized("invalid_token", "Malformed session token");
		}
		TenantId tenant = new TenantId(tenantId);
		byte[] presented = SessionService.sha256(parts[3]);
		record Row(UUID userId, byte[] hash, boolean live, boolean userActive) {
		}
		Principal principal = tx.execute(status -> {
			tenantSession.bind(tenant);
			Row row = jdbc.sql("""
					SELECT s.user_id, s.token_hash, s.revoked_at IS NULL AND s.expires_at > now() AS live, u.status = 'active' AS active
					FROM auth_session s JOIN app_user u ON u.tenant_id = s.tenant_id AND u.id = s.user_id WHERE s.id = :id
					""").param("id", sessionId)
					.query((rs, n) -> new Row(rs.getObject("user_id", UUID.class), rs.getBytes("token_hash"), rs.getBoolean("live"),
							rs.getBoolean("active")))
					.optional().orElse(null);
			byte[] expected = row == null ? new byte[32] : row.hash();
			if (row == null || !MessageDigest.isEqual(presented, expected)) {
				return null;
			}
			if (!row.live() || !row.userActive()) {
				throw ApiException.unauthorized("session_expired", "Session expired or revoked; sign in again");
			}
			Set<String> roles = access.rolesOf(row.userId());
			return new Principal(tenant, null, null, row.userId(), roles);
		});
		if (principal == null) {
			throw ApiException.unauthorized("invalid_token", "Unknown session or wrong secret");
		}
		return Optional.of(principal);
	}
}
