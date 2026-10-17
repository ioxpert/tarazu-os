package com.ioxpert.tarazu.identity;

import java.util.Collection;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/** Read access to device state for other modules (sync gateway). Requires a tenant-bound transaction. */
@Component
public class DeviceDirectory {

	public enum State { ACTIVE, REVOKED }

	/** A device and the store it was registered to. */
	public record DeviceInfo(UUID id, UUID storeId, State state) {
	}

	private final JdbcClient jdbc;

	DeviceDirectory(JdbcClient jdbc) {
		this.jdbc = jdbc;
	}

	/** Devices of the bound tenant among {@code ids}; unknown ids are simply absent. */
	public Map<UUID, DeviceInfo> find(Collection<UUID> ids) {
		return jdbc.sql("SELECT id, store_id, status FROM device WHERE id = ANY(:ids)")
				.param("ids", ids.toArray(UUID[]::new))
				.query((rs, n) -> new DeviceInfo(rs.getObject("id", UUID.class), rs.getObject("store_id", UUID.class),
						"revoked".equals(rs.getString("status")) ? State.REVOKED : State.ACTIVE))
				.list().stream().collect(Collectors.toMap(DeviceInfo::id, d -> d));
	}

	public void markSeen(UUID deviceId) {
		// at most once a minute: a hot row updated by every upload would serialise a device's concurrent batches
		jdbc.sql("""
				UPDATE device SET last_seen_at = now()
				WHERE id = :id AND (last_seen_at IS NULL OR last_seen_at < now() - interval '1 minute')
				""").param("id", deviceId).update();
	}
}
