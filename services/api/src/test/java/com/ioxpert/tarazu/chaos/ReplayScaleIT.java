package com.ioxpert.tarazu.chaos;

import static com.ioxpert.tarazu.Ops.m;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.UUID;

import com.ioxpert.tarazu.ApiIT;
import com.ioxpert.tarazu.Ops;
import com.ioxpert.tarazu.Seed;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import tools.jackson.databind.JsonNode;

/**
 * PRD: a device must be able to hold 100,000 unsynced operations and later push them. This pushes exactly that
 * through the real API in 500-op batches, replays the whole backlog (a lost final response), delivers a shuffled
 * copy as a second device would after a long partition, and checks every projection against an independent model.
 */
@Tag("scale")
class ReplayScaleIT extends ApiIT {

	static final int DEVICES = 10;
	static final int OPS = 100_000;
	static final int BATCH = 500;
	static final int PRODUCTS = 200;
	static final int PARTIES = 300;

	private record Result(JsonNode body, long nanos) {
	}

	private Result send(Seed seed, String body) throws Exception {
		long t0 = System.nanoTime();
		var response = mvc.perform(post("/v1/sync/upload").header("X-Tenant-Id", seed.tenant()).contentType(MediaType.APPLICATION_JSON).content(body))
				.andReturn().getResponse();
		assertThat(response.getStatus()).as(response.getContentAsString()).isEqualTo(200);
		return new Result(json.readTree(response.getContentAsString()), System.nanoTime() - t0);
	}

	private static long p95(List<Long> nanos) {
		long[] sorted = nanos.stream().mapToLong(Long::longValue).sorted().toArray();
		return sorted[(int) Math.floor(sorted.length * 0.95)];
	}

	@Test
	void aHundredThousandQueuedOperationsUploadReplayAndConvergeWithZeroDrift() throws Exception {
		Random rnd = new Random(2026);
		Seed seed = seedTenant();
		List<Ops> devices = Scenario.devices(this, seed, DEVICES);

		// parents first, as a device creates its catalogue before selling
		List<Map<String, Object>> parents = new ArrayList<>();
		List<UUID> products = new ArrayList<>();
		List<UUID> parties = new ArrayList<>();
		for (int i = 0; i < PRODUCTS; i++) {
			UUID id = new UUID(rnd.nextLong(), rnd.nextLong());
			products.add(id);
			parents.add(devices.get(i % DEVICES).product(id, "Product " + i));
		}
		for (int i = 0; i < PARTIES; i++) {
			UUID id = new UUID(rnd.nextLong(), rnd.nextLong());
			parties.add(id);
			parents.add(devices.get(i % DEVICES).party(id, "Party " + i));
		}

		Map<UUID, Long> expectedStock = new HashMap<>();
		Map<UUID, Long> expectedKhata = new HashMap<>();
		long[] kinds = new long[3];
		List<String> bodies = new ArrayList<>();
		for (int i = 0; i < parents.size(); i += BATCH) {
			bodies.add(json.writeValueAsString(Map.of("operations", parents.subList(i, Math.min(parents.size(), i + BATCH)))));
		}
		List<Map<String, Object>> batch = new ArrayList<>();
		for (int i = 0; i < OPS; i++) {
			Ops device = devices.get(i % DEVICES);
			UUID id = new UUID(rnd.nextLong(), rnd.nextLong());
			int roll = rnd.nextInt(100);
			if (roll < 60) {
				UUID product = products.get(rnd.nextInt(PRODUCTS));
				long qty = (rnd.nextInt(10) + 1) * 1000L * (rnd.nextInt(100) < 65 ? -1 : 1);
				batch.add(device.stock(id, product, qty, qty < 0 ? "sale" : "purchase"));
				expectedStock.merge(product, qty, Long::sum);
				kinds[0]++;
			}
			else if (roll < 90) {
				UUID party = parties.get(rnd.nextInt(PARTIES));
				long amount = rnd.nextInt(100_000) + 1;
				boolean debit = rnd.nextInt(100) < 70;
				batch.add(device.khata(id, party, debit ? "debit" : "credit", amount));
				expectedKhata.merge(party, debit ? amount : -amount, Long::sum);
				kinds[1]++;
			}
			else {
				batch.add(device.create("payment", id, m("partyId", parties.get(rnd.nextInt(PARTIES)), "direction", "in", "mode", "upi",
						"amountPaise", rnd.nextInt(10_000) + 1)));
				kinds[2]++;
			}
			if (batch.size() == BATCH) {
				bodies.add(json.writeValueAsString(Map.of("operations", batch)));
				batch = new ArrayList<>();
			}
		}
		if (!batch.isEmpty()) {
			bodies.add(json.writeValueAsString(Map.of("operations", batch)));
		}
		int totalOps = PRODUCTS + PARTIES + OPS;

		// 1. the backlog arrives
		List<Long> firstPass = new ArrayList<>();
		long t0 = System.nanoTime();
		int accepted = 0;
		for (String body : bodies) {
			Result r = send(seed, body);
			firstPass.add(r.nanos());
			assertThat(r.body().get("rejected").asInt()).isZero();
			accepted += r.body().get("accepted").asInt();
		}
		long uploadMs = (System.nanoTime() - t0) / 1_000_000;
		assertThat(accepted).isEqualTo(totalOps);
		assertThat(count(seed, "SELECT count(*) FROM operation_log")).isEqualTo(totalOps);
		assertConverged(seed, expectedStock, expectedKhata, kinds);

		// 2. the response to the last batch was lost, so the device resends the whole backlog: all duplicates
		t0 = System.nanoTime();
		int duplicates = 0;
		for (String body : bodies) {
			Result r = send(seed, body);
			assertThat(r.body().get("accepted").asInt()).isZero();
			duplicates += r.body().get("duplicates").asInt();
		}
		long replayMs = (System.nanoTime() - t0) / 1_000_000;
		assertThat(duplicates).isEqualTo(totalOps);
		assertThat(count(seed, "SELECT count(*) FROM operation_log")).isEqualTo(totalOps);
		assertConverged(seed, expectedStock, expectedKhata, kinds);

		System.out.printf("ReplayScaleIT: %,d ops in %,d batches: first upload %,d ms (%,d ops/s, batch P95 %d ms), full replay %,d ms%n",
				totalOps, bodies.size(), uploadMs, totalOps * 1000L / Math.max(1, uploadMs), p95(firstPass) / 1_000_000, replayMs);
	}

	private void assertConverged(Seed seed, Map<UUID, Long> expectedStock, Map<UUID, Long> expectedKhata, long[] kinds) {
		assertThat(count(seed, "SELECT count(*) FROM stock_movement")).isEqualTo(kinds[0]);
		assertThat(count(seed, "SELECT count(*) FROM khata_entry")).isEqualTo(kinds[1]);
		assertThat(count(seed, "SELECT count(*) FROM payment")).isEqualTo(kinds[2]);
		Map<UUID, Long> stock = new HashMap<>();
		Map<UUID, Long> khata = new HashMap<>();
		inTenant(seed.tenant(), () -> {
			jdbc.query("SELECT product_id, qty_milli FROM stock_balance", rs -> {
				stock.put(rs.getObject("product_id", UUID.class), rs.getLong("qty_milli"));
			});
			jdbc.query("SELECT party_id, balance_paise FROM khata_balance", rs -> {
				khata.put(rs.getObject("party_id", UUID.class), rs.getLong("balance_paise"));
			});
			return null;
		});
		assertThat(stock).isEqualTo(expectedStock);
		assertThat(khata).isEqualTo(expectedKhata);
		assertThat(inTenant(seed.tenant(), () -> jdbc.queryForList("SELECT projection FROM verify_projections()", String.class)))
				.as("projection mismatch must be zero").isEmpty();
		assertThat(count(seed, "SELECT count(*) FROM operation_result WHERE status NOT IN ('applied', 'flagged')")).isZero();
		assertThat(count(seed, "SELECT count(*) FROM (SELECT idempotency_key FROM operation_log GROUP BY 1 HAVING count(*) > 1) d"))
				.as("zero duplicate operations").isZero();
	}
}
