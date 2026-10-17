package com.ioxpert.tarazu;

import static org.junit.jupiter.api.Assumptions.assumeTrue;

import org.junit.jupiter.api.BeforeAll;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.DockerClientFactory;
import org.testcontainers.postgresql.PostgreSQLContainer;

/**
 * Integration tests run against a real Postgres 16 (RLS cannot be faked).
 * Either set TARAZU_TEST_DB_URL (+ optional admin/app creds; used by CI and by local runs without
 * Docker) or let Testcontainers start one. With neither available the tests are skipped.
 */
public abstract class AbstractPostgresIT {

	private static final String ENV_URL = System.getenv("TARAZU_TEST_DB_URL");

	private static PostgreSQLContainer container;

	@BeforeAll
	static void requireDatabase() {
		assumeTrue(ENV_URL != null || DockerClientFactory.instance().isDockerAvailable(),
				"needs TARAZU_TEST_DB_URL or Docker");
	}

	@DynamicPropertySource
	static void database(DynamicPropertyRegistry registry) {
		if (ENV_URL != null) {
			registry.add("spring.datasource.url", () -> ENV_URL);
			registry.add("spring.flyway.url", () -> ENV_URL);
			registry.add("spring.flyway.user", () -> env("DB_ADMIN_USER", "tarazu_admin"));
			registry.add("spring.flyway.password", () -> env("DB_ADMIN_PASSWORD", "tarazu_admin_dev"));
			registry.add("spring.datasource.username", () -> env("DB_APP_USER", "tarazu_app"));
			registry.add("spring.datasource.password", () -> env("DB_APP_PASSWORD", "tarazu_app_dev"));
		}
		else if (DockerClientFactory.instance().isDockerAvailable()) {
			if (container == null) {
				container = new PostgreSQLContainer("postgres:16-alpine").withInitScript("db/test-init-roles.sql");
				container.start();
			}
			registry.add("spring.datasource.url", container::getJdbcUrl);
			registry.add("spring.flyway.url", container::getJdbcUrl);
			registry.add("spring.flyway.user", container::getUsername);
			registry.add("spring.flyway.password", container::getPassword);
			registry.add("spring.datasource.username", () -> "tarazu_app");
			registry.add("spring.datasource.password", () -> "tarazu_app_dev");
		}
	}

	private static String env(String name, String fallback) {
		String value = System.getenv(name);
		return value != null ? value : fallback;
	}
}
