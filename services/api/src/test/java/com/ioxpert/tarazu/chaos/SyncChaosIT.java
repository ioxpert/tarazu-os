package com.ioxpert.tarazu.chaos;

import static com.ioxpert.tarazu.Ops.m;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;

import com.ioxpert.tarazu.ApiIT;
import com.ioxpert.tarazu.Ops;
import com.ioxpert.tarazu.Seed;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;

/**
 * Chaos for the sync path, run in CI: duplicate replay storms from many threads, children before parents,
 * network partitions healing in odd orders, hot-row contention between devices, and failures mid-batch.
 */
class SyncChaosIT extends ApiIT {

	@AfterEach
	void endOutage() {
		FaultInjectionHandler.TRANSIENT_OUTAGE.set(false);
	}

	private int rawUpload(Seed seed, List<Map<String, Object>> batch) throws Exception {
		return mvc.perform(post("/v1/sync/upload").header("X-Tenant-Id", seed.tenant()).contentType(MediaType.APPLICATION_JSON)
				.content(json.writeValueAsString(Map.of("operations", batch)))).andReturn().getResponse().getStatus();
	}

	private <T> List<T> parallel(int threads, List<Callable<T>> tasks) throws Exception {
		try (ExecutorService pool = Executors.newFixedThreadPool(threads)) {
			List<Future<T>> futures = new ArrayList<>();
			for (var task : tasks) {
				futures.add(pool.submit(task));
			}
			List<T> out = new ArrayList<>();
			for (var f : futures) {
				out.add(f.get());
			}
			return out;
		}
	}

	private Map<UUID, Long> stockOf(Seed seed) {
		Map<UUID, Long> stock = new HashMap<>();
		inTenant(seed.tenant(), () -> {
			jdbc.query("SELECT product_id, qty_milli FROM stock_balance", rs -> {
				stock.put(rs.getObject("product_id", UUID.class), rs.getLong("qty_milli"));
			});
			return null;
		});
		return stock;
	}

	private void assertConverged(Seed seed, Scenario scenario) {
		assertThat(stockOf(seed)).isEqualTo(scenario.expectedStock);
		Map<UUID, Long> khata = new HashMap<>();
		inTenant(seed.tenant(), () -> {
			jdbc.query("SELECT party_id, balance_paise FROM khata_balance", rs -> {
				khata.put(rs.getObject("party_id", UUID.class), rs.getLong("balance_paise"));
			});
			return null;
		});
		assertThat(khata).isEqualTo(scenario.expectedKhata);
		assertThat(inTenant(seed.tenant(), () -> jdbc.queryForList("SELECT projection FROM verify_projections()", String.class))).isEmpty();
		assertThat(count(seed, "SELECT count(*) FROM operation_log")).isEqualTo(scenario.all().size());
		assertThat(count(seed, "SELECT count(*) FROM operation_result WHERE status NOT IN ('applied', 'flagged')")).isZero();
	}

	@Test
	void aDuplicateReplayStormFromManyThreadsAppliesEveryOperationExactlyOnce() throws Exception {
		Random rnd = new Random(42);
		Seed seed = seedTenant();
		var devices = Scenario.devices(this, seed, 4);
		var scenario = Scenario.generate(rnd, devices, 4, 4, 300);
		var batches = Scenario.deliveryPlan(rnd, scenario.all(), 25, 0);

		// 8 threads each replay every batch, three times over, in their own random order
		List<Callable<Integer>> tasks = new ArrayList<>();
		for (int t = 0; t < 8; t++) {
			long threadSeed = t;
			tasks.add(() -> {
				Random r = new Random(threadSeed);
				List<List<Map<String, Object>>> mine = new ArrayList<>();
				for (int round = 0; round < 3; round++) {
					List<List<Map<String, Object>>> copy = new ArrayList<>(batches);
					Collections.shuffle(copy, r);
					mine.addAll(copy);
				}
				int failures = 0;
				for (var batch : mine) {
					if (rawUpload(seed, batch) != 200) {
						failures++;
					}
				}
				return failures;
			});
		}
		assertThat(parallel(8, tasks)).as("no request failed").containsOnly(0);
		assertConverged(seed, scenario);
		assertThat(count(seed, "SELECT count(*) FROM stock_movement"))
				.isEqualTo(scenario.events.stream().filter(e -> e.get("entityType").equals("stock_movement")).count());
	}

	@Test
	void childrenBeforeParentsAcrossBatchesAndDevicesStillConverge() throws Exception {
		Random rnd = new Random(7);
		Seed seed = seedTenant();
		var devices = Scenario.devices(this, seed, 3);
		var scenario = Scenario.generate(rnd, devices, 5, 5, 200);

		// every event first (all deferred), the parents last
		var plan = Scenario.deliveryPlan(rnd, scenario.events, 20, 0);
		int deferred = 0;
		for (var batch : plan) {
			deferred += upload(seed, batch).get("deferred").asInt();
		}
		assertThat(deferred).as("events are parked, not lost or rejected").isEqualTo(scenario.events.size());
		assertThat(count(seed, "SELECT count(*) FROM stock_movement")).isZero();

		for (var batch : Scenario.deliveryPlan(rnd, scenario.parents, 3, 0)) {
			upload(seed, batch);
		}
		assertConverged(seed, scenario);
	}

	@Test
	void partitionedCountersSellingTheSameLastUnitsAllPersistAndStockShowsTheShortfall() throws Exception {
		Seed seed = seedTenant();
		var counters = Scenario.devices(this, seed, 3);
		UUID product = UUID.randomUUID();
		upload(seed, counters.get(0).product(product, "Hot item"), counters.get(0).stock(UUID.randomUUID(), product, 3000, "opening"));

		// all three counters lose the network and each sells 2 units against what it believes is 3 in stock
		List<List<Map<String, Object>>> offline = new ArrayList<>();
		for (Ops counter : counters) {
			List<Map<String, Object>> queue = new ArrayList<>();
			queue.add(counter.stock(UUID.randomUUID(), product, -2000, "sale"));
			offline.add(queue);
		}
		// the partition heals in a different order, with a retry because the first response was lost
		upload(seed, offline.get(2));
		upload(seed, offline.get(2));
		upload(seed, offline.get(0));
		upload(seed, offline.get(1));
		upload(seed, offline.get(0));

		assertThat(count(seed, "SELECT qty_milli FROM stock_balance WHERE product_id = ?", product)).as("3 - 3x2 units").isEqualTo(-3000);
		assertThat(count(seed, "SELECT count(*) FROM stock_movement WHERE reason = 'sale'")).isEqualTo(3);
		assertThat(count(seed, "SELECT count(*) FROM stock_balance WHERE product_id = ? AND oversold", product)).isEqualTo(1);
		assertThat(count(seed, "SELECT count(*) FROM conflict_flag WHERE kind = 'oversold' AND status = 'open'")).isEqualTo(1);
	}

	@Test
	void devicesHammeringTheSameRowsNeverFailAndNeverLoseAnOperation() throws Exception {
		Seed seed = seedTenant();
		var devices = Scenario.devices(this, seed, 4);
		var scenario = Scenario.generate(new Random(99), devices, 2, 2, 600); // 2 hot products and parties
		for (var batch : Scenario.deliveryPlan(new Random(1), scenario.parents, 10, 0)) {
			upload(seed, batch);
		}

		AtomicInteger failures = new AtomicInteger();
		List<Callable<Void>> tasks = new ArrayList<>();
		List<List<Map<String, Object>>> batches = Scenario.deliveryPlan(new Random(2), scenario.events, 15, 0);
		for (int t = 0; t < 4; t++) {
			int offset = t;
			tasks.add(() -> {
				for (int i = offset; i < batches.size(); i += 4) {
					if (rawUpload(seed, batches.get(i)) != 200) {
						failures.incrementAndGet();
					}
				}
				return null;
			});
		}
		parallel(4, tasks);
		assertThat(failures.get()).as("deadlocks are retried, not surfaced").isZero();
		assertConverged(seed, scenario);
	}

	@Test
	void aBatchThatDiesMidWayLeavesNothingHalfAppliedAndTheRetryCompletesIt() throws Exception {
		Seed seed = seedTenant();
		var d = new Ops(seed);
		UUID product = UUID.randomUUID();
		var batch = List.of(d.product(product, "Before the outage"), d.stock(UUID.randomUUID(), product, 1000, "opening"),
				d.create("chaos_fault", UUID.randomUUID(), m("mode", "transient")),
				d.stock(UUID.randomUUID(), product, 500, "purchase"));

		FaultInjectionHandler.TRANSIENT_OUTAGE.set(true);
		org.assertj.core.api.Assertions.assertThatThrownBy(() -> rawUpload(seed, batch)).as("the outage surfaces to the client as a failure to retry");
		assertThat(count(seed, "SELECT count(*) FROM operation_log")).as("atomic: nothing from the dead batch is stored").isZero();
		assertThat(count(seed, "SELECT count(*) FROM product")).isZero();

		FaultInjectionHandler.TRANSIENT_OUTAGE.set(false);
		var retried = upload(seed, batch);
		assertThat(retried.get("results").size()).isEqualTo(4);
		assertThat(count(seed, "SELECT qty_milli FROM stock_balance WHERE product_id = ?", product)).isEqualTo(1500);
		assertThat(count(seed, "SELECT count(*) FROM operation_log")).isEqualTo(4);
	}

	@Test
	void aHandlerBugRejectsOneOperationWithoutWedgingTheQueue() throws Exception {
		Seed seed = seedTenant();
		var d = new Ops(seed);
		UUID product = UUID.randomUUID();
		var res = upload(seed, d.product(product, "Survivor"), d.create("chaos_fault", UUID.randomUUID(), m("mode", "bug")),
				d.stock(UUID.randomUUID(), product, 2000, "opening"));
		assertThat(statusOf(res, 0)).isEqualTo("applied");
		assertThat(statusOf(res, 1)).isEqualTo("rejected");
		assertThat(res.get("results").get(1).get("code").asString()).isEqualTo("internal_error");
		assertThat(statusOf(res, 2)).isEqualTo("applied");
		assertThat(count(seed, "SELECT count(*) FROM operation_log")).as("the failed op is kept for re-application").isEqualTo(3);
	}
}
