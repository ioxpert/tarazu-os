package com.ioxpert.tarazu.consent;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/** Per-tenant data mode. Local-only means this merchant's data never leaves the device. */
@Component
public class TenantSettings {

	private final JdbcClient jdbc;

	TenantSettings(JdbcClient jdbc) {
		this.jdbc = jdbc;
	}

	/** Requires a tenant-bound transaction. A tenant with no settings row is synced (the default). */
	public boolean isLocalOnly() {
		return jdbc.sql("SELECT local_only FROM tenant_setting").query(Boolean.class).optional().orElse(false);
	}
}
