package com.ioxpert.tarazu.chaos;

import static com.ioxpert.tarazu.Ops.m;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.UUID;

import com.ioxpert.tarazu.Ops;
import com.ioxpert.tarazu.Seed;

/**
 * A random merchant history built by several devices, plus the answer computed independently in plain Java:
 * what each product's stock and each party's khata balance must be once every operation has been applied,
 * whatever order, batching or duplication delivery used.
 */
final class Scenario {

	final List<Map<String, Object>> parents = new ArrayList<>();
	final List<Map<String, Object>> events = new ArrayList<>();
	final Map<UUID, Long> expectedStock = new HashMap<>();
	final Map<UUID, Long> expectedKhata = new HashMap<>();
	final Map<UUID, Long> movementCount = new HashMap<>();

	List<Map<String, Object>> all() {
		List<Map<String, Object>> all = new ArrayList<>(parents);
		all.addAll(events);
		return all;
	}

	/** @param devices one Ops per device (separate local sequences, as on real devices) */
	static Scenario generate(Random rnd, List<Ops> devices, int products, int parties, int eventCount) {
		Scenario s = new Scenario();
		List<UUID> productIds = new ArrayList<>();
		List<UUID> partyIds = new ArrayList<>();
		for (int i = 0; i < products; i++) {
			UUID id = new UUID(rnd.nextLong(), rnd.nextLong());
			productIds.add(id);
			s.parents.add(pick(rnd, devices).product(id, "Product " + i));
		}
		for (int i = 0; i < parties; i++) {
			UUID id = new UUID(rnd.nextLong(), rnd.nextLong());
			partyIds.add(id);
			s.parents.add(pick(rnd, devices).party(id, "Party " + i));
		}
		for (int i = 0; i < eventCount; i++) {
			Ops device = pick(rnd, devices);
			UUID id = new UUID(rnd.nextLong(), rnd.nextLong());
			if (rnd.nextInt(100) < 65) {
				UUID product = productIds.get(rnd.nextInt(products));
				long qty = (rnd.nextInt(20) + 1) * 1000L * (rnd.nextBoolean() ? 1 : -1);
				String reason = qty > 0 ? (rnd.nextBoolean() ? "purchase" : "adjustment") : (rnd.nextBoolean() ? "sale" : "damage");
				s.events.add(device.stock(id, product, qty, reason));
				s.expectedStock.merge(product, qty, Long::sum);
				s.movementCount.merge(product, 1L, Long::sum);
			}
			else {
				UUID party = partyIds.get(rnd.nextInt(parties));
				long amount = rnd.nextInt(50_000) + 1;
				boolean debit = rnd.nextBoolean();
				s.events.add(device.khata(id, party, debit ? "debit" : "credit", amount));
				s.expectedKhata.merge(party, debit ? amount : -amount, Long::sum);
			}
		}
		return s;
	}

	/** Shuffles, cuts into random-sized batches and sprinkles in re-sent copies, like a flaky network would. */
	static List<List<Map<String, Object>>> deliveryPlan(Random rnd, List<Map<String, Object>> ops, int maxBatch, int duplicatePercent) {
		List<Map<String, Object>> shuffled = new ArrayList<>(ops);
		Collections.shuffle(shuffled, rnd);
		List<List<Map<String, Object>>> batches = new ArrayList<>();
		for (int i = 0; i < shuffled.size();) {
			int size = Math.min(shuffled.size() - i, 1 + rnd.nextInt(maxBatch));
			batches.add(new ArrayList<>(shuffled.subList(i, i + size)));
			i += size;
		}
		int originals = batches.size();
		for (int b = 0; b < originals; b++) {
			while (rnd.nextInt(100) < duplicatePercent) {
				batches.add(rnd.nextInt(batches.size() + 1), batches.get(b));
			}
		}
		return batches;
	}

	private static Ops pick(Random rnd, List<Ops> devices) {
		return devices.get(rnd.nextInt(devices.size()));
	}

	static List<Ops> devices(com.ioxpert.tarazu.ApiIT it, Seed seed, int n) {
		List<Ops> devices = new ArrayList<>();
		devices.add(new Ops(seed));
		for (int i = 1; i < n; i++) {
			devices.add(new Ops(seed, it.addDeviceForTest(seed), null));
		}
		return devices;
	}

	static Map<String, Object> shallow(Map<String, Object> op) {
		return m("operationId", op.get("operationId"));
	}
}
