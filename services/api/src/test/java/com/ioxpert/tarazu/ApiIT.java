package com.ioxpert.tarazu;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Supplier;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Base for tests that need the whole app against real Postgres. All subclasses share one Spring context.
 * The dev tenant header stands in for authentication; DeviceTokenAuthenticator has its own IdentityIT.
 */
@SpringBootTest
@AutoConfigureMockMvc
@TestPropertySource(properties = { "tarazu.auth.dev-header-enabled=true", "tarazu.pin.iterations=1000",
		"tarazu.auth.otp.pepper=test-pepper-0123456789abcdef", "tarazu.auth.otp.resend-seconds=0", "tarazu.auth.otp.max-per-hour=1000" })
public abstract class ApiIT extends AbstractPostgresIT {

	@Autowired protected MockMvc mvc;
	@Autowired protected JdbcTemplate jdbc;
	@Autowired protected TransactionTemplate tx;
	@Autowired protected JsonMapper json;

	/** Seeds through the app role with the tenant bound, which also exercises the RLS WITH CHECK path. */
	protected Seed seedTenant() {
		var seed = new Seed(UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID());
		tx.executeWithoutResult(status -> {
			bind(seed.tenant());
			jdbc.update("INSERT INTO tenant (id, name) VALUES (?, 'Test Kirana')", seed.tenant());
			jdbc.update("INSERT INTO business (id, tenant_id, name) VALUES (?, ?, 'Test Kirana')", seed.business(), seed.tenant());
			jdbc.update("INSERT INTO store (id, tenant_id, business_id, name) VALUES (?, ?, ?, 'Main')",
					seed.store(), seed.tenant(), seed.business());
			jdbc.update("INSERT INTO device (id, tenant_id, store_id, label) VALUES (?, ?, ?, 'Counter 1')",
					seed.device(), seed.tenant(), seed.store());
			jdbc.update("INSERT INTO app_user (id, tenant_id, display_name) VALUES (?, ?, 'Owner')", seed.owner(), seed.tenant());
			jdbc.update("INSERT INTO user_role (tenant_id, user_id, role) VALUES (?, ?, 'owner')", seed.tenant(), seed.owner());
		});
		return seed;
	}

	protected UUID addDevice(Seed seed) {
		UUID id = UUID.randomUUID();
		inTenant(seed.tenant(), () -> jdbc.update("INSERT INTO device (id, tenant_id, store_id, label) VALUES (?, ?, ?, 'Counter')",
				id, seed.tenant(), seed.store()));
		return id;
	}

	/** Public hook for helpers in other packages. */
	public UUID addDeviceForTest(Seed seed) {
		return addDevice(seed);
	}

	protected UUID addUser(Seed seed, String role) {
		UUID id = UUID.randomUUID();
		inTenant(seed.tenant(), () -> {
			jdbc.update("INSERT INTO app_user (id, tenant_id, display_name) VALUES (?, ?, ?)", id, seed.tenant(), role);
			return jdbc.update("INSERT INTO user_role (tenant_id, user_id, role) VALUES (?, ?, ?)", seed.tenant(), id, role);
		});
		return id;
	}

	protected void bind(UUID tenant) {
		jdbc.queryForObject("SELECT set_config('app.tenant_id', ?, true)", String.class, tenant.toString());
	}

	/** Runs in one transaction with the tenant bound, so RLS applies exactly as it does for the API. */
	protected <T> T inTenant(UUID tenant, Supplier<T> work) {
		return tx.execute(status -> {
			bind(tenant);
			return work.get();
		});
	}

	protected long count(Seed seed, String sql, Object... args) {
		return inTenant(seed.tenant(), () -> jdbc.queryForObject(sql, Long.class, args));
	}

	protected ResultActions uploadRaw(UUID tenant, List<Map<String, Object>> ops) throws Exception {
		return mvc.perform(post("/v1/sync/upload").header("X-Tenant-Id", tenant)
				.contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("operations", ops))));
	}

	/** Uploads and expects HTTP 200; returns the per-operation results in request order. */
	protected JsonNode upload(Seed seed, Map<String, Object>... ops) throws Exception {
		return upload(seed, List.of(ops));
	}

	protected JsonNode upload(Seed seed, List<Map<String, Object>> ops) throws Exception {
		String body = uploadRaw(seed.tenant(), ops).andExpect(status().isOk()).andReturn().getResponse().getContentAsString();
		return json.readTree(body);
	}

	protected static String statusOf(JsonNode response, int index) {
		return response.get("results").get(index).get("status").asString();
	}
}
