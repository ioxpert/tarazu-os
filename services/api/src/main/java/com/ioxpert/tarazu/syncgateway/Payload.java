package com.ioxpert.tarazu.syncgateway;

import java.time.Instant;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.Optional;
import java.util.UUID;

import tools.jackson.databind.JsonNode;

/** Typed, strict access to an operation payload. Wrong shapes raise {@link InvalidPayloadException}. */
public final class Payload {

	private final JsonNode node;

	public Payload(JsonNode node) {
		this.node = node;
	}

	public JsonNode node() {
		return node;
	}

	/** The key is present, even if its value is JSON null (used to clear a field). */
	public boolean present(String field) {
		return node.has(field);
	}

	public boolean has(String field) {
		JsonNode v = node.get(field);
		return v != null && !v.isNull();
	}

	public String text(String field) {
		return optText(field).orElseThrow(() -> missing(field));
	}

	public Optional<String> optText(String field) {
		JsonNode v = node.get(field);
		if (v == null || v.isNull()) {
			return Optional.empty();
		}
		if (!v.isString()) {
			throw wrong(field, "a string");
		}
		String s = v.stringValue().trim();
		if (s.isEmpty()) {
			return Optional.empty();
		}
		if (s.length() > 2000) {
			throw wrong(field, "at most 2000 characters");
		}
		return Optional.of(s);
	}

	public UUID uuid(String field) {
		return optUuid(field).orElseThrow(() -> missing(field));
	}

	public Optional<UUID> optUuid(String field) {
		return optText(field).map(s -> {
			try {
				return UUID.fromString(s);
			}
			catch (IllegalArgumentException ex) {
				throw wrong(field, "a UUID");
			}
		});
	}

	/** Integral number only: money is paise and quantity is milli-units, never a float. */
	public long integer(String field) {
		return optInteger(field).orElseThrow(() -> missing(field));
	}

	public long integer(String field, long fallback) {
		return optInteger(field).orElse(fallback);
	}

	public Optional<Long> optInteger(String field) {
		JsonNode v = node.get(field);
		if (v == null || v.isNull()) {
			return Optional.empty();
		}
		if (!v.isIntegralNumber() || !v.canConvertToLong()) {
			throw wrong(field, "an integer");
		}
		return Optional.of(v.longValue());
	}

	public boolean bool(String field, boolean fallback) {
		JsonNode v = node.get(field);
		if (v == null || v.isNull()) {
			return fallback;
		}
		if (!v.isBoolean()) {
			throw wrong(field, "a boolean");
		}
		return v.booleanValue();
	}

	public Instant instant(String field) {
		try {
			return Instant.parse(text(field));
		}
		catch (DateTimeParseException ex) {
			throw wrong(field, "an ISO-8601 instant");
		}
	}

	public LocalDate date(String field) {
		try {
			return LocalDate.parse(text(field));
		}
		catch (DateTimeParseException ex) {
			throw wrong(field, "a date (yyyy-MM-dd)");
		}
	}

	public JsonNode array(String field) {
		JsonNode v = node.get(field);
		if (v == null || !v.isArray()) {
			throw wrong(field, "an array");
		}
		return v;
	}

	public JsonNode optObject(String field) {
		JsonNode v = node.get(field);
		return v != null && v.isObject() ? v : null;
	}

	private static InvalidPayloadException missing(String field) {
		return new InvalidPayloadException("Field '" + field + "' is required");
	}

	private static InvalidPayloadException wrong(String field, String expected) {
		return new InvalidPayloadException("Field '" + field + "' must be " + expected);
	}
}
