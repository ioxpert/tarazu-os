package com.ioxpert.tarazu.identity;

import java.util.Optional;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/** Business-level settings other modules need while processing operations. */
@Component
public class BusinessDirectory {

	public enum GstMode {
		REGULAR, COMPOSITION, NON_GST;

		static GstMode fromWire(String value) {
			return valueOf(value.toUpperCase());
		}
	}

	private final JdbcClient jdbc;

	BusinessDirectory(JdbcClient jdbc) {
		this.jdbc = jdbc;
	}

	public Optional<GstMode> gstModeOfStore(UUID storeId) {
		return jdbc.sql("""
				SELECT b.gst_mode FROM business b JOIN store s ON s.tenant_id = b.tenant_id AND s.business_id = b.id
				WHERE s.id = :store
				""").param("store", storeId).query(String.class).optional().map(GstMode::fromWire);
	}
}
