package com.ioxpert.tarazu.identity;

import java.nio.charset.StandardCharsets;
import java.util.Optional;
import java.util.UUID;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/**
 * Maps an email or phone to the one account that owns it, so login can find a tenant from a contact (ADR 0007).
 * Contacts are normalised and stored only as HMAC-SHA256 hashes. {@code register}/{@code release} act on the bound
 * tenant; {@code lookup} is the deliberate cross-tenant read.
 */
@Component
public class ContactDirectory {

	public enum Channel {
		EMAIL, PHONE;

		public String wire() {
			return name().toLowerCase();
		}

		public static Optional<Channel> fromWire(String v) {
			return "email".equals(v) ? Optional.of(EMAIL) : "phone".equals(v) ? Optional.of(PHONE) : Optional.empty();
		}
	}

	public record Owner(UUID tenantId, UUID userId) {
	}

	private final JdbcClient jdbc;
	private final byte[] pepper;

	ContactDirectory(JdbcClient jdbc, @Value("${tarazu.auth.otp.pepper:}") String pepper) {
		this.jdbc = jdbc;
		this.pepper = pepper.getBytes(StandardCharsets.UTF_8);
	}

	public boolean configured() {
		return pepper.length >= 16;
	}

	/** Lower-cased trimmed email; null when it is not a plausible address. */
	public static String normaliseEmail(String raw) {
		if (raw == null) {
			return null;
		}
		String e = raw.trim().toLowerCase();
		return e.length() <= 254 && e.matches("[^@\\s]+@[^@\\s]+\\.[^@\\s]+") ? e : null;
	}

	/** E.164. A bare 10-digit Indian mobile (starting 6-9) gets +91; otherwise a leading + and 8-15 digits are required. */
	public static String normalisePhone(String raw) {
		if (raw == null) {
			return null;
		}
		String t = raw.trim();
		boolean plus = t.startsWith("+");
		String d = t.replaceAll("\\D", "");
		if (!plus && d.length() == 11 && d.startsWith("0")) {
			d = d.substring(1);
		}
		if (!plus && d.length() == 12 && d.startsWith("91")) {
			plus = true;
		}
		if (!plus && d.length() == 10 && d.matches("[6-9]\\d{9}")) {
			return "+91" + d;
		}
		return plus && d.length() >= 8 && d.length() <= 15 ? "+" + d : null;
	}

	public static String normalise(Channel channel, String raw) {
		return channel == Channel.EMAIL ? normaliseEmail(raw) : normalisePhone(raw);
	}

	public byte[] hash(Channel channel, String normalised) {
		if (!configured()) {
			throw new IllegalStateException("tarazu.auth.otp.pepper is not configured");
		}
		try {
			Mac mac = Mac.getInstance("HmacSHA256");
			mac.init(new SecretKeySpec(pepper, "HmacSHA256"));
			return mac.doFinal((channel.wire() + ":" + normalised).getBytes(StandardCharsets.UTF_8));
		}
		catch (java.security.GeneralSecurityException ex) {
			throw new IllegalStateException(ex);
		}
	}

	/** Requires a tenant-bound transaction. False when another account already holds the contact. */
	public boolean register(Channel channel, String normalised, UUID tenantId, UUID userId) {
		return Boolean.TRUE.equals(jdbc.sql("SELECT contact_register(:h, :t, :u)").param("h", hash(channel, normalised))
				.param("t", tenantId).param("u", userId).query(Boolean.class).single());
	}

	public void release(Channel channel, String normalised) {
		jdbc.sql("SELECT contact_release(:h)").param("h", hash(channel, normalised)).query().listOfRows();
	}

	public Optional<Owner> lookup(Channel channel, String normalised) {
		return jdbc.sql("SELECT tenant_id, user_id FROM contact_lookup(:h)").param("h", hash(channel, normalised))
				.query((rs, n) -> new Owner(rs.getObject("tenant_id", UUID.class), rs.getObject("user_id", UUID.class))).optional();
	}

	/** Counts one OTP request against the contact; false when it exceeded {@code max} within {@code windowMinutes}. */
	public boolean allowOtpRequest(Channel channel, String normalised, int max, int windowMinutes) {
		return Boolean.TRUE.equals(jdbc.sql("SELECT otp_throttle_hit(:h, :max, make_interval(mins => :w))")
				.param("h", hash(channel, normalised)).param("max", max).param("w", windowMinutes)
				.query(Boolean.class).single());
	}

	/** Keyed hash with the same server-side pepper, for OTP codes and the like: {@code HMAC(pepper, purpose|data)}. */
	public byte[] keyedHash(String purpose, String data) {
		if (!configured()) {
			throw new IllegalStateException("tarazu.auth.otp.pepper is not configured");
		}
		try {
			Mac mac = Mac.getInstance("HmacSHA256");
			mac.init(new SecretKeySpec(pepper, "HmacSHA256"));
			return mac.doFinal((purpose + "|" + data).getBytes(StandardCharsets.UTF_8));
		}
		catch (java.security.GeneralSecurityException ex) {
			throw new IllegalStateException(ex);
		}
	}
}
