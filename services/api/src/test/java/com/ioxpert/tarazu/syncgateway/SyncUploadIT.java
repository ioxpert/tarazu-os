package com.ioxpert.tarazu.syncgateway;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.ioxpert.tarazu.ApiIT;
import com.ioxpert.tarazu.Ops;
import com.ioxpert.tarazu.Seed;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessException;
import org.springframework.http.MediaType;

/** The gateway envelope: auth, validation, acknowledgement, idempotency, parking of out-of-order operations. */
class SyncUploadIT extends ApiIT {

	@Test
	void healthIsOpenWithoutAuth() throws Exception {
		mvc.perform(get("/actuator/health")).andExpect(status().isOk());
	}

	@Test
	void uploadWithoutCredentialsIsUnauthorized() throws Exception {
		mvc.perform(post("/v1/sync/upload").contentType(MediaType.APPLICATION_JSON).content("{}"))
				.andExpect(status().isUnauthorized()).andExpect(jsonPath("$.code").value("authentication_required"));
	}

	@Test
	void everyOperationIsAcknowledgedAndReplayIsIdempotent() throws Exception {
		Seed seed = seedTenant();
		var device = new Ops(seed);
		UUID product = UUID.randomUUID();
		var batch = List.of(device.product(product, "Tata Salt 1kg"));

		var first = upload(seed, batch);
		assertThat(first.get("accepted").asInt()).isEqualTo(1);
		assertThat(first.get("duplicates").asInt()).isZero();
		assertThat(statusOf(first, 0)).isEqualTo("applied");
		assertThat(first.get("results").get(0).get("operationId").asString()).isEqualTo(batch.get(0).get("operationId").toString());

		var second = upload(seed, batch);
		assertThat(second.get("accepted").asInt()).isZero();
		assertThat(second.get("duplicates").asInt()).isEqualTo(1);
		assertThat(statusOf(second, 0)).isEqualTo("duplicate");
		assertThat(second.get("results").get(0).get("originalStatus").asString()).isEqualTo("applied");

		assertThat(count(seed, "SELECT count(*) FROM operation_log")).isEqualTo(1);
		assertThat(count(seed, "SELECT count(*) FROM product")).isEqualTo(1);
	}

	@Test
	void sameIdempotencyKeyWithNewOperationIdIsADuplicateNotASecondEffect() throws Exception {
		Seed seed = seedTenant();
		var device = new Ops(seed);
		UUID product = UUID.randomUUID();
		var original = device.product(product, "Atta");
		upload(seed, original);

		var retried = new java.util.LinkedHashMap<>(original);
		retried.put("operationId", com.ioxpert.tarazu.tenancy.UuidV7.next());
		var response = upload(seed, List.of(retried));
		assertThat(statusOf(response, 0)).isEqualTo("duplicate");
		assertThat(count(seed, "SELECT count(*) FROM operation_log")).isEqualTo(1);
	}

	@Test
	void aPermanentlyInvalidOperationIsRejectedWithACodeAndDoesNotBlockTheBatch() throws Exception {
		Seed seed = seedTenant();
		var device = new Ops(seed);
		UUID good = UUID.randomUUID();
		var response = upload(seed,
				device.create("product", UUID.randomUUID(), Ops.m("unit", "piece")), // name missing
				device.create("no_such_thing", UUID.randomUUID(), Ops.m()),
				device.product(good, "Sugar"));

		assertThat(statusOf(response, 0)).isEqualTo("rejected");
		assertThat(response.get("results").get(0).get("code").asString()).isEqualTo("invalid_payload");
		assertThat(statusOf(response, 1)).isEqualTo("rejected");
		assertThat(response.get("results").get(1).get("code").asString()).isEqualTo("unknown_entity_type");
		assertThat(statusOf(response, 2)).isEqualTo("applied");
		assertThat(response.get("rejected").asInt()).isEqualTo(2);
		// rejected ops are kept raw in the log: nothing the device sent is ever lost
		assertThat(count(seed, "SELECT count(*) FROM operation_log")).isEqualTo(3);
		assertThat(count(seed, "SELECT count(*) FROM product")).isEqualTo(1);
	}

	@Test
	void anOperationBeforeItsParentIsParkedThenAppliedWhenTheParentArrives() throws Exception {
		Seed seed = seedTenant();
		var device = new Ops(seed);
		UUID product = UUID.randomUUID();
		var parent = device.product(product, "Biscuit");
		var child = device.stock(UUID.randomUUID(), product, 12_000, "purchase");

		var early = upload(seed, child);
		assertThat(statusOf(early, 0)).isEqualTo("deferred");
		assertThat(early.get("deferred").asInt()).isEqualTo(1);
		assertThat(count(seed, "SELECT count(*) FROM stock_movement")).isZero();

		upload(seed, parent);
		assertThat(count(seed, "SELECT count(*) FROM stock_movement")).isEqualTo(1);
		assertThat(count(seed, "SELECT qty_milli FROM stock_balance WHERE product_id = ?", product)).isEqualTo(12_000);
		assertThat(count(seed, "SELECT count(*) FROM operation_result WHERE status = 'deferred'")).isZero();

		// replaying the early batch now reports what actually happened to it
		var replay = upload(seed, child);
		assertThat(statusOf(replay, 0)).isEqualTo("duplicate");
		assertThat(replay.get("results").get(0).get("originalStatus").asString()).isEqualTo("applied");
	}

	@Test
	void parentAndChildInOneBatchInReverseOrderBothApply() throws Exception {
		Seed seed = seedTenant();
		var device = new Ops(seed);
		UUID product = UUID.randomUUID();
		var parent = device.product(product, "Soap");
		var child = device.stock(UUID.randomUUID(), product, 5_000, "opening");

		var response = upload(seed, child, parent);
		assertThat(statusOf(response, 0)).isEqualTo("applied"); // reported as of the end of the batch
		assertThat(statusOf(response, 1)).isEqualTo("applied");
		assertThat(count(seed, "SELECT qty_milli FROM stock_balance")).isEqualTo(5_000);
	}

	@Test
	void validationFailuresAre400() throws Exception {
		Seed seed = seedTenant();
		var device = new Ops(seed);
		var bad = device.product(UUID.randomUUID(), "x");
		bad.put("opType", "explode");
		uploadRaw(seed.tenant(), List.of(bad)).andExpect(status().isBadRequest());

		var badHlc = device.product(UUID.randomUUID(), "x");
		badHlc.put("hlc", "yesterday");
		uploadRaw(seed.tenant(), List.of(badHlc)).andExpect(status().isBadRequest());

		var notV7 = device.product(UUID.randomUUID(), "x");
		notV7.put("operationId", UUID.randomUUID());
		uploadRaw(seed.tenant(), List.of(notV7)).andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.code").value("invalid_operation_id"));
		assertThat(count(seed, "SELECT count(*) FROM operation_log")).isZero();
	}

	@Test
	void anotherTenantsStoreCannotBeReferenced() throws Exception {
		Seed a = seedTenant();
		Seed b = seedTenant();
		var asA = new Ops(a);
		uploadRaw(b.tenant(), List.of(asA.product(UUID.randomUUID(), "stolen")))
				.andExpect(status().isUnprocessableEntity()).andExpect(jsonPath("$.code").value("unknown_device"));
		assertThat(count(a, "SELECT count(*) FROM operation_log")).isZero();
	}

	@Test
	void theSameOperationIdInTwoTenantsIsTwoOperations() throws Exception {
		Seed a = seedTenant();
		Seed b = seedTenant();
		var opA = new Ops(a).product(UUID.randomUUID(), "A");
		var opB = new java.util.LinkedHashMap<>(new Ops(b).product(UUID.randomUUID(), "B"));
		opB.put("operationId", opA.get("operationId"));
		opB.put("entityId", opA.get("entityId"));
		assertThat(statusOf(upload(a, List.of(opA)), 0)).isEqualTo("applied");
		assertThat(statusOf(upload(b, List.of(opB)), 0)).as("another tenant's ids must not swallow or probe this op").isEqualTo("applied");
		assertThat(count(b, "SELECT count(*) FROM product WHERE name = 'B'")).isEqualTo(1);
		assertThat(count(a, "SELECT count(*) FROM product WHERE name = 'A'")).isEqualTo(1);
	}

	@Test
	void rowLevelSecurityHidesOtherTenantsRows() throws Exception {
		Seed a = seedTenant();
		Seed b = seedTenant();
		upload(a, new Ops(a).product(UUID.randomUUID(), "A's product"));

		assertThat(count(b, "SELECT count(*) FROM operation_log")).isZero();
		assertThat(count(b, "SELECT count(*) FROM product")).isZero();
		assertThat(count(b, "SELECT count(*) FROM store")).isEqualTo(1);
		tx.executeWithoutResult(s -> assertThat(jdbc.queryForObject("SELECT count(*) FROM operation_log", Integer.class))
				.as("no tenant bound sees nothing").isZero());
	}

	@Test
	void operationLogIsAppendOnly() throws Exception {
		Seed seed = seedTenant();
		upload(seed, new Ops(seed).product(UUID.randomUUID(), "x"));
		assertThatThrownBy(() -> inTenant(seed.tenant(), () -> jdbc.update("UPDATE operation_log SET hlc = 'tampered'")))
				.isInstanceOf(DataAccessException.class);
		assertThatThrownBy(() -> inTenant(seed.tenant(), () -> jdbc.update("DELETE FROM operation_log")))
				.isInstanceOf(DataAccessException.class);
	}

	@Test
	void statusEndpointReportsWhatTheServerMadeOfTheDevicesOperations() throws Exception {
		Seed seed = seedTenant();
		var device = new Ops(seed);
		upload(seed, device.product(UUID.randomUUID(), "ok"), device.create("product", UUID.randomUUID(), Map.of()));
		mvc.perform(get("/v1/sync/status").header("X-Tenant-Id", seed.tenant())).andExpect(status().isOk())
				.andExpect(jsonPath("$.applied").value(1)).andExpect(jsonPath("$.rejected").value(1));
		mvc.perform(get("/v1/sync/rejected").header("X-Tenant-Id", seed.tenant())).andExpect(status().isOk())
				.andExpect(jsonPath("$[0].code").value("invalid_payload"));
	}
}
