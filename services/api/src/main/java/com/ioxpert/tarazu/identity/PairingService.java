package com.ioxpert.tarazu.identity;

import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;

import com.ioxpert.tarazu.tenancy.ApiException;
import com.ioxpert.tarazu.tenancy.TenantContext;
import com.ioxpert.tarazu.tenancy.TenantId;
import com.ioxpert.tarazu.tenancy.TenantSession;
import com.ioxpert.tarazu.tenancy.UuidV7;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Pairing a counter (docs/adr/0015). The owner asks for a short one-time code for a store; the counter redeems it with a
 * device id and a 256-bit secret it generated itself, so a lost response can be retried safely: the same code, device id
 * and secret replay to the same result, and anyone else is refused.
 */
@Service
class PairingService {

	record Created(String code, Instant expiresAt, UUID storeId, String label) {
	}

	record Redeemed(UUID tenantId, UUID deviceId, UUID storeId, String label, String token, boolean created) {
	}

	/** No 0/O/1/I: a code read off a screen and typed on a counter must not be ambiguous. 8 characters = 40 bits. */
	static final String ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
	static final int CODE_LENGTH = 8;
	private static final SecureRandom RANDOM = new SecureRandom();

	private final JdbcClient jdbc;
	private final TransactionTemplate tx;
	private final TenantSession tenantSession;
	private final AccessPolicy access;
	private final AuditLog audit;
	private final DeviceService devices;
	private final PairingDirectory directory;
	private final int ttlMinutes;
	private final int maxFailures;
	private final int windowMinutes;

	PairingService(JdbcClient jdbc, PlatformTransactionManager tm, TenantSession tenantSession, AccessPolicy access, AuditLog audit,
			DeviceService devices, PairingDirectory directory, @Value("${tarazu.pairing.ttl-minutes:10}") int ttlMinutes,
			@Value("${tarazu.pairing.max-failures:30}") int maxFailures, @Value("${tarazu.pairing.window-minutes:10}") int windowMinutes) {
		this.jdbc = jdbc;
		this.tx = new TransactionTemplate(tm);
		this.tenantSession = tenantSession;
		this.access = access;
		this.audit = audit;
		this.devices = devices;
		this.directory = directory;
		this.ttlMinutes = ttlMinutes;
		this.maxFailures = maxFailures;
		this.windowMinutes = windowMinutes;
	}

	/** Upper-cases and drops spaces and dashes; null when what is left cannot be a code. */
	static String normalise(String raw) {
		if (raw == null) {
			return null;
		}
		String c = raw.replaceAll("[\\s-]", "").toUpperCase(java.util.Locale.ROOT);
		if (c.length() != CODE_LENGTH) {
			return null;
		}
		for (char ch : c.toCharArray()) {
			if (ALPHABET.indexOf(ch) < 0) {
				return null;
			}
		}
		return c;
	}

	static String display(String code) {
		return code.substring(0, 4) + "-" + code.substring(4);
	}

	private static String newCode() {
		StringBuilder sb = new StringBuilder(CODE_LENGTH);
		for (int i = 0; i < CODE_LENGTH; i++) {
			sb.append(ALPHABET.charAt(RANDOM.nextInt(ALPHABET.length())));
		}
		return sb.toString();
	}

	private void requireConfigured() {
		if (!directory.configured()) {
			throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "pairing_not_configured", "Device pairing is not configured for this deployment");
		}
	}

	/** Owner side: a code for a new counter of one store. */
	Created create(UUID storeId, String label) {
		requireConfigured();
		return tx.execute(s -> {
			tenantSession.bindCurrentTenant();
			access.require(Permission.DEVICE_MANAGE);
			var principal = TenantContext.principal();
			UUID id = UuidV7.next();
			Instant expires = Instant.now().plusSeconds(ttlMinutes * 60L);
			try {
				jdbc.sql("""
						INSERT INTO device_pairing (id, tenant_id, store_id, label, created_by, expires_at)
						VALUES (:id, :tenant, :store, :label, :by, :exp)
						""").param("id", id).param("tenant", principal.tenant().value()).param("store", storeId)
						.param("label", label).param("by", principal.userId()).param("exp", java.sql.Timestamp.from(expires)).update();
			}
			catch (DataIntegrityViolationException ex) {
				throw ApiException.unprocessable("unknown_store", "Store does not exist for this tenant");
			}
			for (int attempt = 0; attempt < 8; attempt++) {
				String code = newCode();
				if (directory.register(directory.hash(code), principal.tenant().value(), id, expires)) {
					audit.record(AuditLog.Entry.of("device.pairing_created", "device_pairing", id, null).withDetails(Map.of("storeId", storeId)));
					return new Created(display(code), expires, storeId, label);
				}
			}
			throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "pairing_code_unavailable", "Could not allocate a pairing code; try again");
		});
	}

	/**
	 * Counter side, no credential yet. A wrong, expired or unknown code is one answer (404) so codes cannot be probed, and
	 * counts against a deployment-wide failure budget that is committed even though the request fails.
	 */
	Redeemed redeem(String rawCode, UUID deviceId, String secret) {
		requireConfigured();
		if (!directory.hasRoom(maxFailures, windowMinutes)) {
			throw tooMany();
		}
		String code = normalise(rawCode);
		try {
			if (code == null) {
				throw invalid();
			}
			return tx.execute(s -> redeemInTx(code, deviceId, secret));
		}
		catch (ApiException ex) {
			if (ex.status() == HttpStatus.NOT_FOUND || ex.status() == HttpStatus.CONFLICT) {
				tx.executeWithoutResult(s -> directory.recordFailure(maxFailures, windowMinutes));
			}
			throw ex;
		}
	}

	private Redeemed redeemInTx(String code, UUID deviceId, String secret) {
		var owner = directory.lookup(directory.hash(code)).orElseThrow(PairingService::invalid);
		tenantSession.bind(new TenantId(owner.tenantId()));
		record Row(UUID storeId, String label, UUID createdBy, boolean expired, UUID deviceId) {
		}
		Row row = jdbc.sql("""
				SELECT store_id, label, created_by, expires_at <= now() AS expired, device_id
				FROM device_pairing WHERE id = :id FOR UPDATE
				""").param("id", owner.pairingId())
				.query((rs, n) -> new Row(rs.getObject("store_id", UUID.class), rs.getString("label"), rs.getObject("created_by", UUID.class),
						rs.getBoolean("expired"), rs.getObject("device_id", UUID.class)))
				.optional().orElseThrow(PairingService::invalid);
		String token = DeviceService.tokenOf(owner.tenantId(), deviceId, secret);
		if (row.deviceId() != null) {
			// already redeemed: only the counter that holds the same device id and secret gets the same answer again
			byte[] stored = jdbc.sql("SELECT token_hash FROM device WHERE id = :id").param("id", row.deviceId())
					.query((rs, n) -> rs.getBytes("token_hash")).optional().orElse(null);
			if (row.deviceId().equals(deviceId) && stored != null && MessageDigest.isEqual(stored, DeviceService.sha256(secret))) {
				return new Redeemed(owner.tenantId(), deviceId, row.storeId(), row.label(), token, false);
			}
			throw ApiException.conflict("pairing_used", "This code has already been used");
		}
		if (row.expired()) {
			throw invalid();
		}
		boolean exists = jdbc.sql("SELECT count(*) FROM device WHERE id = :id").param("id", deviceId).query(Long.class).single() > 0;
		if (exists) {
			throw ApiException.conflict("device_exists", "Device id already registered");
		}
		devices.insert(owner.tenantId(), deviceId, row.storeId(), row.label(), secret, row.createdBy());
		jdbc.sql("UPDATE device_pairing SET consumed_at = now(), device_id = :d WHERE id = :id").param("d", deviceId).param("id", owner.pairingId()).update();
		audit.recordFor(new AuditLog.Entry("device.paired", "device", deviceId, null, Map.of("storeId", row.storeId(), "pairingId", owner.pairingId()),
				null, row.createdBy(), deviceId), owner.tenantId());
		return new Redeemed(owner.tenantId(), deviceId, row.storeId(), row.label(), token, true);
	}

	private static ApiException invalid() {
		return ApiException.notFound("pairing_invalid", "Unknown or expired pairing code");
	}

	private static ApiException tooMany() {
		return new ApiException(HttpStatus.TOO_MANY_REQUESTS, "too_many_requests", "Too many wrong pairing codes; try again later");
	}
}
