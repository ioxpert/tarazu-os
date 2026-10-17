package com.ioxpert.tarazu.identity;

import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * PBKDF2-HMAC-SHA256 (JDK only). A staff PIN is a short convenience gate, not a primary credential:
 * online guessing is throttled by lockout, and a leaked hash of a 4-digit PIN is brute-forceable
 * regardless of the KDF (ADR 0004).
 */
@Component
class PinHasher {

	record Hashed(byte[] salt, byte[] hash, int iterations) {
	}

	private static final SecureRandom RANDOM = new SecureRandom();

	private final int iterations;

	PinHasher(@Value("${tarazu.pin.iterations:600000}") int iterations) {
		this.iterations = iterations;
	}

	Hashed hash(String pin) {
		byte[] salt = new byte[16];
		RANDOM.nextBytes(salt);
		return new Hashed(salt, derive(pin, salt, iterations), iterations);
	}

	boolean matches(String pin, byte[] salt, byte[] expected, int iterations) {
		return MessageDigest.isEqual(derive(pin, salt, iterations), expected);
	}

	private static byte[] derive(String pin, byte[] salt, int iterations) {
		try {
			return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
					.generateSecret(new PBEKeySpec(pin.toCharArray(), salt, iterations, 256)).getEncoded();
		}
		catch (GeneralSecurityException ex) {
			throw new IllegalStateException(ex);
		}
	}
}
