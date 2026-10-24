package com.ioxpert.tarazu.identity;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.security.SecureRandom;
import java.util.Base64;
import java.util.Map;
import java.util.UUID;

import com.ioxpert.tarazu.AdminSql;
import com.ioxpert.tarazu.ApiIT;
import com.ioxpert.tarazu.Seed;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.env.Environment;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

/** Device pairing against real Postgres (ADR 0015): the cross-tenant code lookup, single use, expiry, replay and the failure budget. */
class PairingIT extends ApiIT {

	private static final SecureRandom RANDOM = new SecureRandom();

	@Autowired Environment env;

	private MockHttpServletRequestBuilder asOwner(MockHttpServletRequestBuilder req, Seed seed) {
		return req.header("X-Tenant-Id", seed.tenant()).header("X-Staff-Id", seed.owner()).contentType(MediaType.APPLICATION_JSON);
	}

	private String body(Object o) {
		return json.writeValueAsString(o);
	}

	private static String newSecret() {
		byte[] b = new byte[32];
		RANDOM.nextBytes(b);
		return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
	}

	private String createCode(Seed seed) throws Exception {
		var res = mvc.perform(asOwner(post("/v1/identity/device-pairings"), seed).content(body(Map.of("storeId", seed.store(), "label", "Counter 3"))))
				.andExpect(status().isCreated()).andExpect(jsonPath("$.code").isNotEmpty()).andExpect(jsonPath("$.expiresAt").isNotEmpty()).andReturn();
		return json.readTree(res.getResponse().getContentAsString()).get("code").asString();
	}

	private ResultActions redeem(String code, UUID device, String secret) throws Exception {
		return mvc.perform(post("/v1/pairing/redeem").contentType(MediaType.APPLICATION_JSON)
				.content(body(Map.of("code", code, "deviceId", device, "secret", secret))));
	}

	@Test
	void anOwnerMakesACodeAndTheCounterTradesItForAWorkingDeviceToken() throws Exception {
		Seed seed = seedTenant();
		String code = createCode(seed);
		assertThat(code).matches("[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}");

		UUID device = UUID.randomUUID();
		String secret = newSecret();
		var res = redeem(code, device, secret).andExpect(status().isCreated())
				.andExpect(jsonPath("$.tenantId").value(seed.tenant().toString())).andExpect(jsonPath("$.deviceId").value(device.toString()))
				.andExpect(jsonPath("$.storeId").value(seed.store().toString())).andExpect(jsonPath("$.label").value("Counter 3")).andReturn();
		String token = json.readTree(res.getResponse().getContentAsString()).get("token").asString();
		assertThat(token).isEqualTo("tzd." + seed.tenant() + "." + device + "." + secret);

		mvc.perform(get("/v1/identity/me").header("Authorization", "Bearer " + token)).andExpect(status().isOk())
				.andExpect(jsonPath("$.deviceId").value(device.toString())).andExpect(jsonPath("$.storeId").value(seed.store().toString()));
		assertThat(count(seed, "SELECT count(*) FROM audit_log WHERE action = 'device.paired' AND entity_id = ? AND actor_user_id = ? AND actor_device_id = ?",
				device, seed.owner(), device)).isEqualTo(1);
		assertThat(count(seed, "SELECT count(*) FROM audit_log WHERE action = 'device.pairing_created'")).isEqualTo(1);
		assertThat(count(seed, "SELECT count(*) FROM device WHERE id = ? AND registered_by = ?", device, seed.owner())).isEqualTo(1);
	}

	@Test
	void codesAreCaseSpaceAndDashTolerant() throws Exception {
		Seed seed = seedTenant();
		String code = createCode(seed);
		redeem(code.toLowerCase().replace("-", "  "), UUID.randomUUID(), newSecret()).andExpect(status().isCreated());
	}

	@Test
	void aCodeIsSingleUseButTheSameCounterCanRetryAfterALostResponse() throws Exception {
		Seed seed = seedTenant();
		String code = createCode(seed);
		UUID device = UUID.randomUUID();
		String secret = newSecret();
		redeem(code, device, secret).andExpect(status().isCreated());

		// the response was lost: same code, device id and secret gets the same answer, not a second device
		redeem(code, device, secret).andExpect(status().isOk()).andExpect(jsonPath("$.token").value("tzd." + seed.tenant() + "." + device + "." + secret));
		assertThat(count(seed, "SELECT count(*) FROM device WHERE label = 'Counter 3'")).isEqualTo(1);

		// anyone else holding the code is refused
		redeem(code, UUID.randomUUID(), newSecret()).andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("pairing_used"));
		redeem(code, device, newSecret()).andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("pairing_used"));
		assertThat(count(seed, "SELECT count(*) FROM device WHERE label = 'Counter 3'")).isEqualTo(1);
	}

	@Test
	void anExpiredCodeIsRefusedLikeAnUnknownOne() throws Exception {
		Seed seed = seedTenant();
		String code = createCode(seed);
		inTenant(seed.tenant(), () -> jdbc.update("UPDATE device_pairing SET expires_at = now() - interval '1 second'"));
		AdminSql.of(env).update("UPDATE pairing_directory SET expires_at = now() - interval '1 second' WHERE tenant_id = ?", seed.tenant());
		redeem(code, UUID.randomUUID(), newSecret()).andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("pairing_invalid"));
		assertThat(count(seed, "SELECT count(*) FROM device WHERE label = 'Counter 3'")).isZero();
	}

	@Test
	void aWrongCodeIsNotFoundAndLooksTheSameAsAnExpiredOne() throws Exception {
		redeem("AAAA-AAAA", UUID.randomUUID(), newSecret()).andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("pairing_invalid"));
		redeem("not a code", UUID.randomUUID(), newSecret()).andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("pairing_invalid"));
		redeem("ABCD-EFG0", UUID.randomUUID(), newSecret()).andExpect(status().isNotFound());
	}

	@Test
	void theCodeLookupNeverCrossesTenants() throws Exception {
		Seed a = seedTenant();
		Seed b = seedTenant();
		String code = createCode(a);
		UUID device = UUID.randomUUID();
		redeem(code, device, newSecret()).andExpect(status().isCreated()).andExpect(jsonPath("$.tenantId").value(a.tenant().toString()));
		assertThat(count(a, "SELECT count(*) FROM device WHERE id = ?", device)).isEqualTo(1);
		assertThat(count(b, "SELECT count(*) FROM device WHERE id = ?", device)).isZero();
		assertThat(count(b, "SELECT count(*) FROM device_pairing")).isZero();
	}

	@Test
	void anOwnerCannotMakeACodeForAnotherTenantsStoreNorWithoutTheRole() throws Exception {
		Seed a = seedTenant();
		Seed b = seedTenant();
		mvc.perform(asOwner(post("/v1/identity/device-pairings"), a).content(body(Map.of("storeId", b.store()))))
				.andExpect(status().isUnprocessableEntity()).andExpect(jsonPath("$.code").value("unknown_store"));
		UUID cashier = addUser(a, "cashier");
		mvc.perform(post("/v1/identity/device-pairings").header("X-Tenant-Id", a.tenant()).header("X-Staff-Id", cashier)
				.contentType(MediaType.APPLICATION_JSON).content(body(Map.of("storeId", a.store()))))
				.andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("permission_denied"));
		mvc.perform(post("/v1/identity/device-pairings").header("X-Tenant-Id", a.tenant()).contentType(MediaType.APPLICATION_JSON)
				.content(body(Map.of("storeId", a.store())))).andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("staff_identification_required"));
	}

	@Test
	void aMalformedSecretOrDeviceIdIsRejectedBeforeTheCodeIsTouched() throws Exception {
		Seed seed = seedTenant();
		String code = createCode(seed);
		redeem(code, UUID.randomUUID(), "short").andExpect(status().isBadRequest());
		redeem(code, UUID.randomUUID(), newSecret()).andExpect(status().isCreated());
	}

	@Test
	void aRevokedPairedDeviceIsRefusedLikeAnyOther() throws Exception {
		Seed seed = seedTenant();
		UUID device = UUID.randomUUID();
		String secret = newSecret();
		redeem(createCode(seed), device, secret).andExpect(status().isCreated());
		mvc.perform(asOwner(post("/v1/identity/devices/" + device + "/revoke"), seed).content(body(Map.of("reason", "lost counter")))).andExpect(status().isNoContent());
		mvc.perform(get("/v1/identity/me").header("Authorization", "Bearer tzd." + seed.tenant() + "." + device + "." + secret))
				.andExpect(status().isUnauthorized()).andExpect(jsonPath("$.code").value("device_revoked"));
	}
}
