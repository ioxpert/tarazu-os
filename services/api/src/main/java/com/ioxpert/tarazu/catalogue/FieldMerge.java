package com.ioxpert.tarazu.catalogue;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import com.ioxpert.tarazu.syncgateway.Hlc;
import com.ioxpert.tarazu.syncgateway.Operation;
import org.springframework.jdbc.core.simple.JdbcClient;
import tools.jackson.databind.json.JsonMapper;

/**
 * Field-level last-writer-wins by hybrid logical clock. Each column carries the HLC of the write that last
 * set it (field_clock). A write only overwrites a field whose clock is older, so two devices editing
 * different fields both survive, and a stale write (arriving late) never clobbers a newer one. Table and
 * column names come from handler constants, never from payloads.
 */
final class FieldMerge {

	private FieldMerge() {
	}

	/** Creates the row, or merges into it if it already exists (e.g. a replayed create from another op id). */
	static void upsert(JdbcClient jdbc, JsonMapper json, String table, Operation op, Map<String, Object> fields) {
		Map<String, Object> clock = new LinkedHashMap<>();
		fields.keySet().forEach(f -> clock.put(f, op.hlc().raw()));
		StringBuilder cols = new StringBuilder("id, tenant_id, field_clock");
		StringBuilder vals = new StringBuilder(":id, :tenant, CAST(:clock AS jsonb)");
		for (String f : fields.keySet()) {
			cols.append(", ").append(f);
			vals.append(", :f_").append(f);
		}
		var stmt = jdbc.sql("INSERT INTO " + table + " (" + cols + ") VALUES (" + vals + ") ON CONFLICT (id) DO NOTHING")
				.param("id", op.entityId()).param("tenant", op.tenantId())
				.param("clock", json.writeValueAsString(clock));
		for (var e : fields.entrySet()) {
			stmt = stmt.param("f_" + e.getKey(), e.getValue());
		}
		if (stmt.update() == 0) {
			merge(jdbc, json, table, op, fields);
		}
	}

	/** Applies each field whose incoming HLC is newer than the stored clock for that field. */
	@SuppressWarnings("unchecked")
	static void merge(JdbcClient jdbc, JsonMapper json, String table, Operation op, Map<String, Object> fields) {
		if (fields.isEmpty()) {
			return;
		}
		String clockJson = jdbc.sql("SELECT field_clock::text FROM " + table + " WHERE id = :id FOR UPDATE")
				.param("id", op.entityId()).query(String.class).single();
		Map<String, Object> clock = json.readValue(clockJson, Map.class);
		StringBuilder set = new StringBuilder();
		Map<String, Object> params = new LinkedHashMap<>();
		for (var e : fields.entrySet()) {
			Object stored = clock.get(e.getKey());
			if (stored != null && Hlc.parse((String) stored).compareTo(op.hlc()) >= 0) {
				continue; // a newer (or identical) write already set this field
			}
			set.append(e.getKey()).append(" = :f_").append(e.getKey()).append(", ");
			params.put("f_" + e.getKey(), e.getValue());
			clock.put(e.getKey(), op.hlc().raw());
		}
		if (params.isEmpty()) {
			return;
		}
		var stmt = jdbc.sql("UPDATE " + table + " SET " + set + "field_clock = CAST(:clock AS jsonb), updated_at = now() WHERE id = :id")
				.param("clock", json.writeValueAsString(clock)).param("id", op.entityId());
		for (var e : params.entrySet()) {
			stmt = stmt.param(e.getKey(), e.getValue());
		}
		stmt.update();
	}

	static UUID idOf(Operation op) {
		return op.entityId();
	}
}
