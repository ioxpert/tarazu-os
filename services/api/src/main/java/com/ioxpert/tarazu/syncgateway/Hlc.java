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
		return new Hlc(Instant.parse(m.group(1)), Integer.parseInt(m.group(2), 16), m.group(3), raw);
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
