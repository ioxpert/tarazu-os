package com.ioxpert.tarazu.syncgateway;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.UUID;

import com.ioxpert.tarazu.AbstractPostgresIT;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.dao.DataAccessException;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.support.TransactionTemplate;

@SpringBootTest
@AutoConfigureMockMvc
@TestPropertySource(properties = "tarazu.auth.dev-header-enabled=true")
class SyncUploadIT extends AbstractPostgresIT {

	@Autowired MockMvc mvc;
	@Autowired JdbcTemplate jdbc;
	@Autowired TransactionTemplate tx;

	record Seed(UUID tenant, UUID store, UUID device) {
	}

	/** Seeds through the app role with the tenant bound, which also exercises the RLS WITH CHECK path. */
	private Seed seedTenant() {
		var seed = new Seed(UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID());
		tx.executeWithoutResult(status -> {
			bind(seed.tenant());
			jdbc.update("INSERT INTO tenant (id, name) VALUES (?, 'Test Kirana')", seed.tenant());
			jdbc.update("INSERT INTO store (id, tenant_id, name) VALUES (?, ?, 'Main')", seed.store(), seed.tenant());
			jdbc.update("INSERT INTO device (id, tenant_id, store_id, label) VALUES (?, ?, ?, 'Counter 1')",
					seed.device(), seed.tenant(), seed.store());
		});
		return seed;
	}

	private void bind(UUID tenant) {
		jdbc.queryForObject("SELECT set_config('app.tenant_id', ?, true)", String.class, tenant.toString());
	}

	private static String body(Seed s, UUID operationId, String idempotencyKey) {
		return """
				{"operations":[{"operationId":"%s","storeId":"%s","deviceId":"%s","localSeq":1,
				"hlc":"2026-10-17T10:00:00.000Z-0000-dev1","idempotencyKey":"%s","entityType":"invoice",
				"entityId":"%s","opType":"create","schemaVersion":1,"payload":{"total":"125.00"}}]}
				""".formatted(operationId, s.store(), s.device(), idempotencyKey, UUID.randomUUID());
	}

	@Test
	void healthIsOpenWithoutAuth() throws Exception {
		mvc.perform(get("/actuator/health")).andExpect(status().isOk());
	}

	@Test
	void uploadWithoutTenantIsUnauthorized() throws Exception {
		mvc.perform(post("/v1/sync/upload").contentType(MediaType.APPLICATION_JSON).content("{}"))
				.andExpect(status().isUnauthorized());
	}

	@Test
	void replayingABatchIsIdempotent() throws Exception {
		var seed = seedTenant();
		var opId = UUID.randomUUID();
		var json = body(seed, opId, "key-" + opId);

		mvc.perform(post("/v1/sync/upload").header("X-Tenant-Id", seed.tenant())
				.contentType(MediaType.APPLICATION_JSON).content(json))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.accepted").value(1))
				.andExpect(jsonPath("$.duplicates").value(0));

		mvc.perform(post("/v1/sync/upload").header("X-Tenant-Id", seed.tenant())
				.contentType(MediaType.APPLICATION_JSON).content(json))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.accepted").value(0))
				.andExpect(jsonPath("$.duplicates").value(1));

		tx.executeWithoutResult(s -> {
			bind(seed.tenant());
			assertThat(jdbc.queryForObject("SELECT count(*) FROM operation_log", Integer.class)).isEqualTo(1);
		});
	}

	@Test
	void invalidPayloadIsRejected() throws Exception {
		var seed = seedTenant();
		mvc.perform(post("/v1/sync/upload").header("X-Tenant-Id", seed.tenant())
				.contentType(MediaType.APPLICATION_JSON)
				.content("{\"operations\":[{\"opType\":\"explode\"}]}"))
				.andExpect(status().isBadRequest());
	}

	@Test
	void anotherTenantsStoreCannotBeReferenced() throws Exception {
		var a = seedTenant();
		var b = seedTenant();
		var opId = UUID.randomUUID();
		// tenant B uploads an op pointing at tenant A's store and device
		mvc.perform(post("/v1/sync/upload").header("X-Tenant-Id", b.tenant())
				.contentType(MediaType.APPLICATION_JSON).content(body(a, opId, "x-" + opId)))
				.andExpect(status().isUnprocessableEntity());
	}

	@Test
	void rowLevelSecurityHidesOtherTenantsRows() throws Exception {
		var a = seedTenant();
		var b = seedTenant();
		var opId = UUID.randomUUID();
		mvc.perform(post("/v1/sync/upload").header("X-Tenant-Id", a.tenant())
				.contentType(MediaType.APPLICATION_JSON).content(body(a, opId, "rls-" + opId)))
				.andExpect(status().isOk());

		tx.executeWithoutResult(s -> {
			bind(b.tenant());
			assertThat(jdbc.queryForObject("SELECT count(*) FROM operation_log", Integer.class)).isZero();
			assertThat(jdbc.queryForObject("SELECT count(*) FROM store", Integer.class)).isEqualTo(1);
		});
		tx.executeWithoutResult(s -> {
			assertThat(jdbc.queryForObject("SELECT count(*) FROM operation_log", Integer.class))
					.as("no tenant bound sees nothing").isZero();
		});
	}

	@Test
	void operationLogIsAppendOnly() throws Exception {
		var seed = seedTenant();
		var opId = UUID.randomUUID();
		mvc.perform(post("/v1/sync/upload").header("X-Tenant-Id", seed.tenant())
				.contentType(MediaType.APPLICATION_JSON).content(body(seed, opId, "ao-" + opId)))
				.andExpect(status().isOk());

		assertThatThrownBy(() -> tx.executeWithoutResult(s -> {
			bind(seed.tenant());
			jdbc.update("UPDATE operation_log SET hlc = 'tampered'");
		})).isInstanceOf(DataAccessException.class);
		assertThatThrownBy(() -> tx.executeWithoutResult(s -> {
			bind(seed.tenant());
			jdbc.update("DELETE FROM operation_log");
		})).isInstanceOf(DataAccessException.class);
	}
}
