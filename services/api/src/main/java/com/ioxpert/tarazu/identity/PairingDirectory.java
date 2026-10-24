package com.ioxpert.tarazu.identity;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/**
 * Maps a pairing code to the tenant and pairing that own it, so a counter with no credential yet can redeem it
 * (docs/adr/0015). Codes are stored only as keyed hashes; the table gives the API role nothing, and these calls go through
 * SECURITY DEFINER functions. {@code register} acts on the bound tenant; {@code lookup} is the deliberate cross-tenant read.
 */
@Component
class PairingDirectory {

	record Owner(UUID tenantId, UUID pairingId) {
	}

	private static final String THROTTLE_KEY = "all-redemptions";

	private final JdbcClient jdbc;
	private final ContactDirectory keys;

	PairingDirectory(JdbcClient jdbc, ContactDirectory keys) {
		this.jdbc = jdbc;
		this.keys = keys;
	}

	boolean configured() {
		return keys.configured();
	}

	byte[] hash(String normalisedCode) {
		return keys.keyedHash("pairing", normalisedCode);
	}

	/** Requires a tenant-bound transaction. False when the hash is already taken by a live code. */
	boolean register(byte[] hash, UUID tenantId, UUID pairingId, Instant expiresAt) {
		return Boolean.TRUE.equals(jdbc.sql("SELECT pairing_register(:h, :t, :p, :e)").param("h", hash).param("t", tenantId)
				.param("p", pairingId).param("e", java.sql.Timestamp.from(expiresAt)).query(Boolean.class).single());
	}

	Optional<Owner> lookup(byte[] hash) {
		return jdbc.sql("SELECT tenant_id, pairing_id FROM pairing_lookup(:h)").param("h", hash)
				.query((rs, n) -> new Owner(rs.getObject("tenant_id", UUID.class), rs.getObject("pairing_id", UUID.class))).optional();
	}

	/** Failed redemptions are counted across the whole deployment: a wrong guess maps to no row, so there is nothing per-code to count. */
	boolean hasRoom(int max, int windowMinutes) {
		return Boolean.TRUE.equals(jdbc.sql("SELECT otp_throttle_peek(:h, :max, make_interval(mins => :w))")
				.param("h", keys.keyedHash("pairing-throttle", THROTTLE_KEY)).param("max", max).param("w", windowMinutes)
				.query(Boolean.class).single());
	}

	void recordFailure(int max, int windowMinutes) {
		jdbc.sql("SELECT otp_throttle_hit(:h, :max, make_interval(mins => :w))")
				.param("h", keys.keyedHash("pairing-throttle", THROTTLE_KEY)).param("max", max).param("w", windowMinutes)
				.query(Boolean.class).single();
	}
}
