package com.ioxpert.tarazu.tenancy;

import java.security.SecureRandom;
import java.util.UUID;

/** RFC 9562 UUIDv7: 48-bit unix millis, then random. Time-ordered ids keep indexes append-friendly. */
public final class UuidV7 {

	private static final SecureRandom RANDOM = new SecureRandom();

	private UuidV7() {
	}

	public static UUID next() {
		return next(System.currentTimeMillis());
	}

	public static UUID next(long epochMillis) {
		long msb = (epochMillis & 0xFFFF_FFFF_FFFFL) << 16;
		long rand = RANDOM.nextLong();
		msb |= 0x7000L | (rand & 0x0FFFL);
		long lsb = (RANDOM.nextLong() & 0x3FFF_FFFF_FFFF_FFFFL) | 0x8000_0000_0000_0000L;
		return new UUID(msb, lsb);
	}

	public static boolean isV7(UUID id) {
		return id != null && id.version() == 7 && id.variant() == 2;
	}
}
