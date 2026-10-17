package com.ioxpert.tarazu;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

import com.ioxpert.tarazu.tenancy.UuidV7;

/**
 * Builds client operations the way the device op-log writer will: UUIDv7 operation id, per-device local
 * sequence, an HLC, a deterministic idempotency key. One Ops instance simulates one device.
 */
public final class Ops {

	public static final Instant BASE = Instant.parse("2026-10-17T10:00:00.000Z");

	private final Seed seed;
	private final UUID device;
	private final UUID actor;
	private final AtomicLong seq = new AtomicLong();
	private final AtomicLong clock = new AtomicLong();

	public Ops(Seed seed) {
		this(seed, seed.device(), null);
	}

	public Ops(Seed seed, UUID device, UUID actor) {
		this.seed = seed;
		this.device = device;
		this.actor = actor;
	}

	public Ops withActor(UUID actor) {
		return new Ops(seed, device, actor);
	}

	public UUID device() {
		return device;
	}

	private static final java.time.format.DateTimeFormatter MILLIS = java.time.format.DateTimeFormatter
			.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(java.time.ZoneOffset.UTC);

	public static String hlc(long millisAfterBase, int counter, String node) {
		return "%s-%04x-%s".formatted(MILLIS.format(BASE.plusMillis(millisAfterBase)), counter, node);
	}

	/** The same op attributed to a different staff member (one device, many cashiers). */
	public static Map<String, Object> by(Map<String, Object> op, UUID actor) {
		Map<String, Object> copy = new LinkedHashMap<>(op);
		copy.put("actorUserId", actor);
		return copy;
	}

	public Map<String, Object> op(String entityType, UUID entityId, String opType, Map<String, Object> payload) {
		long n = seq.incrementAndGet();
		Map<String, Object> op = new LinkedHashMap<>();
		op.put("operationId", UuidV7.next(BASE.toEpochMilli() + clock.incrementAndGet()));
		op.put("storeId", seed.store());
		op.put("deviceId", device);
		if (actor != null) {
			op.put("actorUserId", actor);
		}
		op.put("localSeq", n);
		op.put("hlc", hlc(clock.get(), 0, device.toString().substring(0, 8).replace("-", "")));
		op.put("idempotencyKey", device + ":" + n);
		op.put("entityType", entityType);
		op.put("entityId", entityId);
		op.put("opType", opType);
		op.put("schemaVersion", 1);
		op.put("payload", payload);
		return op;
	}

	public Map<String, Object> create(String entityType, UUID entityId, Map<String, Object> payload) {
		return op(entityType, entityId, "create", payload);
	}

	public Map<String, Object> product(UUID id, String name) {
		return create("product", id, Map.of("name", name, "unit", "piece"));
	}

	public Map<String, Object> party(UUID id, String name) {
		return create("party", id, Map.of("name", name));
	}

	public Map<String, Object> stock(UUID id, UUID product, long qtyMilli, String reason) {
		return create("stock_movement", id, Map.of("productId", product, "qtyMilli", qtyMilli, "reason", reason));
	}

	public Map<String, Object> khata(UUID id, UUID party, String direction, long amountPaise) {
		return create("khata_entry", id, Map.of("partyId", party, "direction", direction, "amountPaise", amountPaise));
	}

	public static Map<String, Object> m(Object... kv) {
		Map<String, Object> map = new LinkedHashMap<>();
		for (int i = 0; i < kv.length; i += 2) {
			map.put((String) kv[i], kv[i + 1]);
		}
		return map;
	}
}
