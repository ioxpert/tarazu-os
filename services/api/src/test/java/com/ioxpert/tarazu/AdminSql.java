package com.ioxpert.tarazu;

import org.springframework.core.env.Environment;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

/** A JdbcTemplate on the migration (admin) role: ops-owned reference data and tests that need to bypass the app role. */
public final class AdminSql {

	private AdminSql() {
	}

	public static JdbcTemplate of(Environment env) {
		return new JdbcTemplate(new DriverManagerDataSource(env.getRequiredProperty("spring.flyway.url"),
				env.getRequiredProperty("spring.flyway.user"), env.getRequiredProperty("spring.flyway.password")));
	}
}
