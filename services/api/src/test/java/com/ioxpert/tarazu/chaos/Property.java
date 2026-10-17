package com.ioxpert.tarazu.chaos;

import java.util.function.LongConsumer;

/**
 * Minimal seeded property runner (no extra dependency). Runs the body for seeds base..base+n-1 and, on failure,
 * rethrows with the seed so the exact case replays with {@code Property.check(1, thatSeed, body)}.
 */
final class Property {

	private Property() {
	}

	static void check(int trials, long baseSeed, LongConsumer body) {
		for (long seed = baseSeed; seed < baseSeed + trials; seed++) {
			try {
				body.accept(seed);
			}
			catch (Throwable t) {
				throw new AssertionError("Property failed for seed " + seed + ": " + t.getMessage(), t);
			}
		}
	}
}
