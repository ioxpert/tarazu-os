package com.ioxpert.tarazu.tenancy;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * Binds the current tenant to the database transaction so Postgres row-level security applies.
 * Must be called inside a transaction: the setting is transaction-local (set_config(..., true)).
 */
@Component
public class TenantSession {

	private final JdbcClient jdbc;

	TenantSession(JdbcClient jdbc) {
		this.jdbc = jdbc;
	}

	@Transactional(propagation = Propagation.MANDATORY)
	public void bindCurrentTenant() {
		bind(TenantContext.require());
	}

	@Transactional(propagation = Propagation.MANDATORY)
	public void bind(TenantId tenant) {
		jdbc.sql("SELECT set_config('app.tenant_id', :tenant, true)")
				.param("tenant", tenant.value().toString())
				.query(String.class)
				.single();
	}
}
