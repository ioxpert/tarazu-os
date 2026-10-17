package com.ioxpert.tarazu.chaos;

import static com.ioxpert.tarazu.Ops.m;
import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.UUID;

import com.ioxpert.tarazu.ApiIT;
import com.ioxpert.tarazu.Ops;
import com.ioxpert.tarazu.Seed;
import org.junit.jupiter.api.Test;

/**
 * Model-based properties: whatever order, batching and duplication delivery uses, the server's stock, khata and
 * product projections equal an independent plain-Java model of the same operations. Replay a failure with the
 * seed in the message.
 */
class LedgerProjectionPropertyIT extends ApiIT {

	private void deliver(Seed seed, List<List<Map<String, Object>>> plan) {
		try {
			for (var batch : plan) {
				var res = upload(seed, batch);
				assertThat(res.get("results").size()).as("every op acknowledged").isEqualTo(batch.size());
			}
		}
		catch (Exception e) {
			throw new AssertionError(e);
		}
	}

	@Test
	void stockAndKhataProjectionsEqualTheModelForAnyDeliveryOrder() {
		Property.check(25, 1000, seed -> {
			Random rnd = new Random(seed);
			Seed tenant = seedTenant();
			var devices = Scenario.devices(this, tenant, 1 + rnd.nextInt(4));
			var scenario = Scenario.generate(rnd, devices, 1 + rnd.nextInt(5), 1 + rnd.nextInt(4), 20 + rnd.nextInt(80));

			deliver(tenant, Scenario.deliveryPlan(rnd, scenario.all(), 1 + rnd.nextInt(30), rnd.nextInt(40)));

			// stock: balance, movement count, oversold flag and open review flag all follow the model
			Map<UUID, Long> stock = new HashMap<>();
			Map<UUID, Long> counts = new HashMap<>();
			Map<UUID, Boolean> oversold = new HashMap<>();
			inTenant(tenant.tenant(), () -> {
				jdbc.query("SELECT product_id, qty_milli, movement_count, oversold FROM stock_balance", rs -> {
					UUID p = rs.getObject("product_id", UUID.class);
					stock.put(p, rs.getLong("qty_milli"));
					counts.put(p, rs.getLong("movement_count"));
					oversold.put(p, rs.getBoolean("oversold"));
				});
				return null;
			});
			assertThat(stock).as("stock_balance").isEqualTo(scenario.expectedStock);
			assertThat(counts).as("each movement counted exactly once").isEqualTo(scenario.movementCount);
			scenario.expectedStock.forEach((p, qty) -> assertThat(oversold.get(p)).as("oversold flag for %s", p).isEqualTo(qty < 0));
			List<String> openOversold = inTenant(tenant.tenant(), () -> jdbc.queryForList(
					"SELECT scope_key FROM conflict_flag WHERE kind = 'oversold' AND status = 'open'", String.class));
			long expectedOpen = scenario.expectedStock.values().stream().filter(q -> q < 0).count();
			assertThat((long) openOversold.size()).as("one open oversold flag per negative product").isEqualTo(expectedOpen);

			Map<UUID, Long> khata = new HashMap<>();
			inTenant(tenant.tenant(), () -> {
				jdbc.query("SELECT party_id, balance_paise FROM khata_balance", rs -> {
					khata.put(rs.getObject("party_id", UUID.class), rs.getLong("balance_paise"));
				});
				return null;
			});
			assertThat(khata).as("khata_balance").isEqualTo(scenario.expectedKhata);

			assertThat(inTenant(tenant.tenant(), () -> jdbc.queryForList("SELECT projection FROM verify_projections()", String.class)))
					.as("verify_projections finds no drift").isEmpty();
			assertThat(count(tenant, "SELECT count(*) FROM operation_result WHERE status NOT IN ('applied', 'flagged')"))
					.as("nothing left deferred or rejected").isZero();
			assertThat(count(tenant, "SELECT count(*) FROM operation_log")).isEqualTo(scenario.all().size());
		});
	}

	@Test
	void productFieldsConvergeToThePerFieldNewestWriteInAnyOrder() {
		final String[] UNITS = { "piece", "packet", "kg", "litre", "box" };
		Property.check(25, 5000, seed -> {
			Random rnd = new Random(seed);
			Seed tenant = seedTenant();
			var devices = Scenario.devices(this, tenant, 3);
			UUID product = UUID.randomUUID();
			String[] fields = { "name", "barcode", "sku", "unit" };

			record Write(long millis, int counter, String node, String field, String value) {
				boolean newerThan(Write o) {
					return o == null || millis > o.millis || (millis == o.millis && (counter > o.counter
							|| (counter == o.counter && node.compareTo(o.node) > 0)));
				}
			}
			List<Map<String, Object>> ops = new ArrayList<>();
			Map<String, Write> winner = new HashMap<>();
			java.util.Set<String> used = new java.util.HashSet<>();
			Write createName = null;
			for (int i = 0; i < 12 + rnd.nextInt(20); i++) {
				int d = rnd.nextInt(devices.size());
				long millis = 1000 + rnd.nextInt(5000);
				int counter = rnd.nextInt(3);
				String node = "d" + d;
				if (!used.add(millis + "/" + counter + "/" + node)) {
					continue;
				}
				Map<String, Object> payload = new LinkedHashMap<>();
				List<Write> writes = new ArrayList<>();
				for (String f : fields) {
					if (rnd.nextInt(100) < 50 || (i == 0 && f.equals("name"))) {
						// unit must be one of the contract's UomUnit values (docs/adr/0011); the other fields are free text
						String value = f.equals("unit") ? UNITS[i % UNITS.length] : f + "-" + i;
						payload.put(f, value);
						writes.add(new Write(millis, counter, node, f, value));
					}
				}
				if (payload.isEmpty()) {
					continue;
				}
				boolean create = createName == null && payload.containsKey("name");
				if (create) {
					createName = writes.get(0);
				}
				var op = new LinkedHashMap<>(devices.get(d).op("product", product, create ? "create" : "update", payload));
				op.put("hlc", Ops.hlc(millis, counter, node));
				ops.add(op);
				writes.forEach(w -> {
					if (w.newerThan(winner.get(w.field()))) {
						winner.put(w.field(), w);
					}
				});
			}
			// the create must exist logically; every other op depends on it and may arrive before it
			deliver(tenant, Scenario.deliveryPlan(rnd, ops, 6, 30));

			var row = inTenant(tenant.tenant(), () -> jdbc.queryForMap("SELECT name, barcode, sku, unit FROM product WHERE id = ?", product));
			for (String f : fields) {
				Object expected = winner.containsKey(f) ? winner.get(f).value() : (f.equals("unit") ? "piece" : null);
				assertThat(row.get(f)).as("field %s", f).isEqualTo(expected);
			}
			assertThat(count(tenant, "SELECT count(*) FROM operation_result WHERE status = 'deferred'")).isZero();
		});
	}

	@Test
	void anyPermutationOfTheSameOperationsYieldsTheSameState() {
		Property.check(10, 9000, seed -> {
			Random rnd = new Random(seed);
			Seed first = seedTenant();
			Seed second = seedTenant();
			// the same logical operations, built once with ids valid for both tenants (ids are tenant-scoped)
			var d1 = Scenario.devices(this, first, 3);
			var scenario = Scenario.generate(rnd, d1, 3, 3, 60);
			var forSecond = remap(scenario.all(), first, second);

			deliver(first, Scenario.deliveryPlan(new Random(seed * 31), scenario.all(), 10, 20));
			deliver(second, Scenario.deliveryPlan(new Random(seed * 97), forSecond, 7, 20));

			assertThat(digest(second)).isEqualTo(digest(first));
		});
	}

	private List<Map<String, Object>> remap(List<Map<String, Object>> ops, Seed from, Seed to) {
		// second tenant has its own store/device; map device ids by position so local sequences stay per-device
		Map<Object, UUID> devices = new HashMap<>();
		List<Map<String, Object>> out = new ArrayList<>();
		for (var op : ops) {
			var copy = new LinkedHashMap<>(op);
			copy.put("storeId", to.store());
			copy.put("deviceId", devices.computeIfAbsent(op.get("deviceId"), k -> k.equals(from.device()) ? to.device() : addDevice(to)));
			copy.put("operationId", com.ioxpert.tarazu.tenancy.UuidV7.next());
			copy.put("idempotencyKey", "second:" + op.get("idempotencyKey"));
			out.add(copy);
		}
		return out;
	}

	private List<String> digest(Seed seed) {
		List<String> rows = new ArrayList<>();
		inTenant(seed.tenant(), () -> {
			rows.addAll(jdbc.queryForList("SELECT 'stock ' || product_id || ' ' || qty_milli || ' ' || movement_count FROM stock_balance", String.class));
			rows.addAll(jdbc.queryForList("SELECT 'khata ' || party_id || ' ' || balance_paise || ' ' || entry_count FROM khata_balance", String.class));
			rows.addAll(jdbc.queryForList("SELECT 'product ' || id || ' ' || name FROM product", String.class));
			// open flags are state and must converge; resolved ones are history of transient dips, which depend on arrival order
			rows.addAll(jdbc.queryForList("SELECT 'flag ' || kind || ' ' || entity_id FROM conflict_flag WHERE status = 'open'", String.class));
			return null;
		});
		Collections.sort(rows);
		return rows;
	}
}
