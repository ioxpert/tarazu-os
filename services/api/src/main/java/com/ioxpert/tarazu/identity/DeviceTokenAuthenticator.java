package com.ioxpert.tarazu.identity;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

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

/**
 * Production credential: {@code Authorization: Bearer tzd.<tenantId>.<deviceId>.<secret>}, issued once at
 * device registration. The tenant id inside the token lets us bind RLS before the lookup. A revoked device
 * is rejected here, on every request, so revocation takes effect at the device's next sync.
 *
 * <p>Optionally {@code X-Staff-Id} + {@code X-Staff-Pin} identify the acting staff member.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
class DeviceTokenAuthenticator implements RequestAuthenticator {

	static final String PREFIX = "tzd.";
	static final String STAFF_ID = "X-Staff-Id";
	static final String STAFF_PIN = "X-Staff-Pin";

	private final JdbcClient jdbc;
	private final TenantSession tenantSession;
	private final PinVerifier pinVerifier;
	private final AccessPolicy access;
	private final TransactionTemplate tx;

	DeviceTokenAuthenticator(JdbcClient jdbc, TenantSession tenantSession, PinVerifier pinVerifier,
			AccessPolicy access, PlatformTransactionManager tm) {
		this.jdbc = jdbc;
		this.tenantSession = tenantSession;
		this.pinVerifier = pinVerifier;
		this.access = access;
		this.tx = new TransactionTemplate(tm);
	}

	@Override
	public Optional<Principal> authenticate(HttpServletRequest request) {
		String header = request.getHeader("Authorization");
		if (header == null || !header.startsWith("Bearer " + PREFIX)) {
			return Optional.empty();
		}
		String[] parts = header.substring("Bearer ".length()).trim().split("\\.", 4);
		if (parts.length != 4) {
			throw ApiException.unauthorized("invalid_token", "Malformed device token");
		}
		UUID tenantId;
		UUID deviceId;
		try {
			tenantId = UUID.fromString(parts[1]);
			deviceId = UUID.fromString(parts[2]);
		}
		catch (IllegalArgumentException ex) {
			throw ApiException.unauthorized("invalid_token", "Malformed device token");
		}
		TenantId tenant = new TenantId(tenantId);
		byte[] presented = DeviceService.sha256(parts[3]);

		record Found(UUID storeId, String status, byte[] hash) {
		}
		Found found = tx.execute(status -> {
			tenantSession.bind(tenant);
			return jdbc.sql("SELECT store_id, status, token_hash FROM device WHERE id = :id").param("id", deviceId)
					.query((rs, n) -> new Found(rs.getObject("store_id", UUID.class), rs.getString("status"),
							rs.getBytes("token_hash")))
					.optional().orElse(null);
		});
		byte[] expected = found != null && found.hash() != null ? found.hash() : new byte[32];
		boolean ok = MessageDigest.isEqual(presented, expected) && found != null && found.hash() != null;
		if (!ok) {
			throw ApiException.unauthorized("invalid_token", "Unknown device or wrong secret");
		}
		if ("revoked".equals(found.status())) {
			throw ApiException.unauthorized("device_revoked",
					"This device has been revoked by the owner; sync is no longer permitted");
		}

		UUID staffId = parseStaff(request.getHeader(STAFF_ID));
		if (staffId == null) {
			return Optional.of(new Principal(tenant, deviceId, found.storeId(), null, Set.of()));
		}
		PinVerifier.Status pin = pinVerifier.verify(tenant, staffId, request.getHeader(STAFF_PIN));
		switch (pin) {
			case OK -> {
			}
			case LOCKED -> throw ApiException.unauthorized("pin_locked", "Too many wrong PINs; try again later");
			case NO_PIN -> throw ApiException.unauthorized("pin_not_set", "No PIN is set for this staff member");
			default -> throw ApiException.unauthorized("invalid_pin", "Wrong staff id or PIN");
		}
		Set<String> roles = tx.execute(status -> {
			tenantSession.bind(tenant);
			return access.rolesOf(staffId, found.storeId());
		});
		return Optional.of(new Principal(tenant, deviceId, found.storeId(), staffId, roles));
	}

	private static UUID parseStaff(String header) {
		if (header == null || header.isBlank()) {
			return null;
		}
		try {
			return UUID.fromString(header.trim());
		}
		catch (IllegalArgumentException ex) {
			throw ApiException.unauthorized("invalid_pin", "Wrong staff id or PIN");
		}
	}

	static byte[] utf8(String s) {
		return s.getBytes(StandardCharsets.UTF_8);
	}
}
