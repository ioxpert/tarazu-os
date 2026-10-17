package com.ioxpert.tarazu.syncgateway;

import java.time.Instant;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Hybrid logical clock timestamp, as written by the device: {@code 2026-10-17T10:00:00.000Z-0000-a1b2c3d4}
 * (UTC millis, 4-hex counter, node id). Orders by time, then counter, then node, so two writes never tie.
 */
public record Hlc(Instant instant, int counter, String node, String raw) implements Comparable<Hlc> {

	public static final String REGEX = "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z-[0-9a-fA-F]{4}-[A-Za-z0-9]{1,16}";
	private static final Pattern PATTERN = Pattern.compile("(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z)-([0-9a-fA-F]{4})-([A-Za-z0-9]{1,16})");

	public static Hlc parse(String raw) {
		Matcher m = raw == null ? null : PATTERN.matcher(raw);
		if (m == null || !m.matches()) {
			throw new IllegalArgumentException("Malformed HLC: " + raw);
		}
		try {
			return new Hlc(Instant.parse(m.group(1)), Integer.parseInt(m.group(2), 16), m.group(3), raw);
		}
		catch (java.time.format.DateTimeParseException ex) {
			throw new IllegalArgumentException("Impossible HLC date: " + raw, ex);
		}
	}

	/** Largest amount a device clock may run ahead of the server before its writes are treated as received "now". */
	public static final java.time.Duration MAX_FUTURE_DRIFT = java.time.Duration.ofHours(24);

	public boolean isSkewedAt(Instant receivedAt) {
		return instant.isAfter(receivedAt.plus(MAX_FUTURE_DRIFT));
	}

	/**
	 * The clock to use when merging. A device whose clock is far in the future (wrong date, dead RTC battery) would
	 * otherwise win every field-level merge for years; its writes count as made at the moment they arrived instead.
	 */
	public Hlc effectiveAt(Instant receivedAt) {
		if (!isSkewedAt(receivedAt)) {
			return this;
		}
		String clamped = "%s-%04x-%s".formatted(java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'")
				.withZone(java.time.ZoneOffset.UTC).format(receivedAt), counter, node);
		return new Hlc(receivedAt.truncatedTo(java.time.temporal.ChronoUnit.MILLIS), counter, node, clamped);
	}

	@Override
	public int compareTo(Hlc other) {
		int c = instant.compareTo(other.instant);
		if (c != 0) {
			return c;
		}
		c = Integer.compare(counter, other.counter);
		return c != 0 ? c : node.compareTo(other.node);
	}
}
