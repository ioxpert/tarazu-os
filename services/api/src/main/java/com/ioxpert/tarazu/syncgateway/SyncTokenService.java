package com.ioxpert.tarazu.syncgateway;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

import com.ioxpert.tarazu.tenancy.ApiException;
import com.ioxpert.tarazu.tenancy.Principal;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import tools.jackson.databind.json.JsonMapper;

/**
 * Mints the short-lived JWT a device presents to the self-hosted PowerSync service. HS256 with a secret shared
 * with PowerSync (its sync rules read {@code merchant_id}, the bucket key). Not configured = 503, never a default key.
 */
@Service
class SyncTokenService {

	record Credentials(String endpoint, String token, Instant expiresAt) {
	}

	private static final Duration TTL = Duration.ofMinutes(5);
	private static final Base64.Encoder B64 = Base64.getUrlEncoder().withoutPadding();

	private final JsonMapper json;
	private final String endpoint;
	private final String audience;
	private final String keyId;
	private final byte[] secret;

	SyncTokenService(JsonMapper json, @Value("${tarazu.sync.powersync.url:}") String endpoint,
			@Value("${tarazu.sync.powersync.audience:}") String audience,
			@Value("${tarazu.sync.powersync.key-id:tarazu-1}") String keyId,
			@Value("${tarazu.sync.powersync.secret:}") String secretB64) {
		this.json = json;
		this.endpoint = endpoint;
		this.audience = audience.isBlank() ? endpoint : audience;
		this.keyId = keyId;
		this.secret = secretB64.isBlank() ? null : Base64.getUrlDecoder().decode(secretB64);
	}

	Credentials issue(Principal principal) {
		if (secret == null || endpoint.isBlank()) {
			throw new ApiException(org.springframework.http.HttpStatus.SERVICE_UNAVAILABLE, "sync_not_configured",
					"The PowerSync service is not configured for this deployment");
		}
		if (principal.deviceId() == null) {
			throw ApiException.forbidden("device_credential_required", "Sync credentials are issued to registered devices only");
		}
		Instant now = Instant.now();
		Instant exp = now.plus(TTL);
		Map<String, Object> header = new LinkedHashMap<>();
		header.put("alg", "HS256");
		header.put("typ", "JWT");
		header.put("kid", keyId);
		Map<String, Object> claims = new LinkedHashMap<>();
		claims.put("sub", principal.deviceId().toString());
		claims.put("aud", audience);
		claims.put("iat", now.getEpochSecond());
		claims.put("exp", exp.getEpochSecond());
		// bucket key = merchant (tenant) id, per the sync rules
		claims.put("merchant_id", principal.tenant().value().toString());
		claims.put("store_id", principal.storeId().toString());
		claims.put("device_id", principal.deviceId().toString());
		String signingInput = B64.encodeToString(json.writeValueAsBytes(header)) + "."
				+ B64.encodeToString(json.writeValueAsBytes(claims));
		return new Credentials(endpoint, signingInput + "." + B64.encodeToString(hmac(signingInput)), exp);
	}

	private byte[] hmac(String input) {
		try {
			Mac mac = Mac.getInstance("HmacSHA256");
			mac.init(new SecretKeySpec(secret, "HmacSHA256"));
			return mac.doFinal(input.getBytes(StandardCharsets.UTF_8));
		}
		catch (java.security.GeneralSecurityException ex) {
			throw new IllegalStateException(ex);
		}
	}
}
