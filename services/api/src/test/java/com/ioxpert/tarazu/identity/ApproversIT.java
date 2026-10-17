package com.ioxpert.tarazu.identity;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;

import com.ioxpert.tarazu.ApiIT;
import com.ioxpert.tarazu.Seed;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import tools.jackson.databind.JsonNode;

/** Offline owner approval (ADR 0008): the verifiers a device caches, and the business/store the device learns from /me. */
class ApproversIT extends ApiIT {

	private MockHttpServletRequestBuilder asOwner(MockHttpServletRequestBuilder req, Seed seed) {
		return req.header("X-Tenant-Id", seed.tenant()).header("X-Staff-Id", seed.owner()).contentType(MediaType.APPLICATION_JSON);
	}

	private String registerDevice(Seed seed) throws Exception {
		var res = mvc.perform(asOwner(put("/v1/identity/devices/" + UUID.randomUUID()), seed)
				.content(json.writeValueAsString(Map.of("storeId", seed.store(), "label", "Counter 2"))))
				.andExpect(status().isCreated()).andReturn();
		return json.readTree(res.getResponse().getContentAsString()).get("token").asString();
	}

	private void setPin(Seed seed, UUID user, String pin) throws Exception {
		mvc.perform(asOwner(put("/v1/identity/users/" + user + "/pin"), seed)
				.content(json.writeValueAsString(Map.of("pin", pin, "reason", "test")))).andExpect(status().isNoContent());
	}

	private UUID addOwner(Seed seed, String name) {
		UUID id = UUID.randomUUID();
		inTenant(seed.tenant(), () -> {
			jdbc.update("INSERT INTO app_user (id, tenant_id, display_name) VALUES (?, ?, ?)", id, seed.tenant(), name);
			return jdbc.update("INSERT INTO user_role (tenant_id, user_id, role) VALUES (?, ?, 'owner')", seed.tenant(), id);
		});
		return id;
	}

	private JsonNode approvers(String token) throws Exception {
		var res = mvc.perform(get("/v1/identity/approvers").header("Authorization", "Bearer " + token))
				.andExpect(status().isOk()).andReturn();
		return json.readTree(res.getResponse().getContentAsString());
	}

	/** Independent of the production hasher: PBKDF2-HMAC-SHA256, 32-byte key, PIN as the UTF-8 digits, base64 on the wire. */
	private static String pbkdf2(String pin, byte[] salt, int iterations) throws Exception {
		byte[] key = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
				.generateSecret(new PBEKeySpec(pin.toCharArray(), salt, iterations, 256)).getEncoded();
		return Base64.getEncoder().encodeToString(key);
	}

	@Test
	void theReturnedVerifierIsPbkdf2HmacSha256OfTheUtf8PinWithTheReturnedSaltAndIterations() throws Exception {
		Seed seed = seedTenant();
		setPin(seed, seed.owner(), "4821");
		String token = registerDevice(seed);

		JsonNode list = approvers(token);
		assertThat(list.size()).isEqualTo(1);
		JsonNode a = list.get(0);
		assertThat(a.get("userId").asString()).isEqualTo(seed.owner().toString());
		assertThat(a.get("displayName").asString()).isEqualTo("Owner");
		int iterations = a.get("iterations").asInt();
		assertThat(iterations).as("tarazu.pin.iterations of the test profile").isEqualTo(1000);

		byte[] salt = Base64.getDecoder().decode(a.get("pinSalt").asString());
		byte[] hash = Base64.getDecoder().decode(a.get("pinHash").asString());
		assertThat(salt).hasSize(16);
		assertThat(hash).as("256-bit key").hasSize(32);
		assertThat(pbkdf2("4821", salt, iterations)).isEqualTo(a.get("pinHash").asString());
		assertThat(pbkdf2("4822", salt, iterations)).isNotEqualTo(a.get("pinHash").asString());
		assertThat(Base64.getEncoder().encodeToString(salt)).as("canonical standard base64, not url-safe").isEqualTo(a.get("pinSalt").asString());
		assertThat("4821".getBytes(StandardCharsets.UTF_8)).hasSize(4);
	}

	@Test
	void onlyActiveOwnersWithAPinAreReturned() throws Exception {
		Seed seed = seedTenant();
		setPin(seed, seed.owner(), "1111");
		UUID noPin = addOwner(seed, "Owner without PIN");
		UUID second = addOwner(seed, "Second owner");
		setPin(seed, second, "2222");
		UUID disabled = addOwner(seed, "Disabled owner");
		setPin(seed, disabled, "3333");
		UUID cashier = addUser(seed, "cashier");
		setPin(seed, cashier, "4444");
		UUID manager = addUser(seed, "manager");
		setPin(seed, manager, "5555");
		inTenant(seed.tenant(), () -> jdbc.update("UPDATE app_user SET status = 'disabled' WHERE id = ?", disabled));
		String token = registerDevice(seed);

		JsonNode list = approvers(token);
		List<String> ids = new java.util.ArrayList<>();
		list.forEach(n -> ids.add(n.get("userId").asString()));
		assertThat(ids).containsExactlyInAnyOrder(seed.owner().toString(), second.toString());
		assertThat(ids).doesNotContain(noPin.toString(), disabled.toString(), cashier.toString(), manager.toString());
	}

	@Test
	void anOwnerScopedToAnotherStoreIsNotAnApproverHere() throws Exception {
		Seed seed = seedTenant();
		UUID elsewhere = UUID.randomUUID();
		UUID branchOwner = addUser(seed, "cashier");
		inTenant(seed.tenant(), () -> {
			jdbc.update("INSERT INTO store (id, tenant_id, business_id, name) VALUES (?, ?, ?, 'Branch')", elsewhere, seed.tenant(), seed.business());
			return jdbc.update("INSERT INTO user_role (tenant_id, user_id, role, store_id) VALUES (?, ?, 'owner', ?)", seed.tenant(), branchOwner, elsewhere);
		});
		setPin(seed, branchOwner, "6666");
		setPin(seed, seed.owner(), "1111");
		JsonNode list = approvers(registerDevice(seed));
		assertThat(list.size()).isEqualTo(1);
		assertThat(list.get(0).get("userId").asString()).isEqualTo(seed.owner().toString());
	}

	@Test
	void tenantsAreIsolated() throws Exception {
		Seed a = seedTenant();
		Seed b = seedTenant();
		setPin(a, a.owner(), "1111");
		setPin(b, b.owner(), "2222");
		JsonNode forA = approvers(registerDevice(a));
		assertThat(forA.size()).isEqualTo(1);
		assertThat(forA.get(0).get("userId").asString()).isEqualTo(a.owner().toString());
		JsonNode forB = approvers(registerDevice(b));
		assertThat(forB.size()).isEqualTo(1);
		assertThat(forB.get(0).get("userId").asString()).isEqualTo(b.owner().toString());
	}

	@Test
	void aRequestWithoutADeviceCredentialNeverGetsTheVerifiers() throws Exception {
		Seed seed = seedTenant();
		setPin(seed, seed.owner(), "1111");
		mvc.perform(get("/v1/identity/approvers")).andExpect(status().isUnauthorized());
		// the dev tenant header (even with the owner identified) is a tenant-level principal, not a device
		mvc.perform(get("/v1/identity/approvers").header("X-Tenant-Id", seed.tenant()))
				.andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("device_credential_required"));
		mvc.perform(get("/v1/identity/approvers").header("X-Tenant-Id", seed.tenant()).header("X-Staff-Id", seed.owner()))
				.andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("device_credential_required"));
		mvc.perform(get("/v1/identity/approvers").header("Authorization", "Bearer tzd.nonsense")).andExpect(status().isUnauthorized());
	}

	@Test
	void aRevokedDeviceGetsNoVerifiers() throws Exception {
		Seed seed = seedTenant();
		setPin(seed, seed.owner(), "1111");
		UUID device = UUID.randomUUID();
		var res = mvc.perform(asOwner(put("/v1/identity/devices/" + device), seed)
				.content(json.writeValueAsString(Map.of("storeId", seed.store())))).andReturn();
		String token = json.readTree(res.getResponse().getContentAsString()).get("token").asString();
		mvc.perform(asOwner(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post("/v1/identity/devices/" + device + "/revoke"), seed)
				.content(json.writeValueAsString(Map.of("reason", "lost")))).andExpect(status().isNoContent());
		mvc.perform(get("/v1/identity/approvers").header("Authorization", "Bearer " + token))
				.andExpect(status().isUnauthorized()).andExpect(jsonPath("$.code").value("device_revoked"));
	}

	// ---------- /me and the business UPI address ----------

	@Test
	void meCarriesTheStoreNameAndBusinessForADeviceCredentialAndNullForATenantLevelOne() throws Exception {
		Seed seed = seedTenant();
		mvc.perform(asOwner(put("/v1/identity/businesses/" + seed.business()), seed).content(json.writeValueAsString(
				Map.of("name", "Sharma Kirana", "gstMode", "composition", "gstin", "27AAPFU0939F1ZV", "stateCode", "27", "upiVpa", "sharma.kirana@okhdfcbank"))))
				.andExpect(status().isOk()).andExpect(jsonPath("$.upiVpa").value("sharma.kirana@okhdfcbank"));
		String token = registerDevice(seed);
		mvc.perform(get("/v1/identity/me").header("Authorization", "Bearer " + token))
				.andExpect(status().isOk()).andExpect(jsonPath("$.storeName").value("Main"))
				.andExpect(jsonPath("$.business.id").value(seed.business().toString()))
				.andExpect(jsonPath("$.business.name").value("Sharma Kirana"))
				.andExpect(jsonPath("$.business.gstMode").value("composition"))
				.andExpect(jsonPath("$.business.gstin").value("27AAPFU0939F1ZV"))
				.andExpect(jsonPath("$.business.stateCode").value("27"))
				.andExpect(jsonPath("$.business.upiVpa").value("sharma.kirana@okhdfcbank"));
		mvc.perform(get("/v1/identity/me").header("X-Tenant-Id", seed.tenant()))
				.andExpect(status().isOk()).andExpect(jsonPath("$.business").doesNotExist()).andExpect(jsonPath("$.storeName").doesNotExist());
	}

	@Test
	void theUpiAddressIsOwnerOnlyValidatedAndAudited() throws Exception {
		Seed seed = seedTenant();
		UUID manager = addUser(seed, "manager");
		String path = "/v1/identity/businesses/" + seed.business();
		Map<String, Object> body = Map.of("name", "K", "gstMode", "non_gst", "upiVpa", "shop@upi");
		mvc.perform(put(path).header("X-Tenant-Id", seed.tenant()).header("X-Staff-Id", manager)
				.contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(body))).andExpect(status().isForbidden());
		for (String bad : List.of("no-at-sign", "a@b", "@upi", "x y@upi", "shop@up1", "shop@@upi")) {
			mvc.perform(asOwner(put(path), seed).content(json.writeValueAsString(Map.of("name", "K", "gstMode", "non_gst", "upiVpa", bad))))
					.andExpect(status().isBadRequest());
		}
		mvc.perform(asOwner(put(path), seed).content(json.writeValueAsString(body))).andExpect(status().isOk());
		mvc.perform(asOwner(put(path), seed).content(json.writeValueAsString(body))).andExpect(status().isOk());
		assertThat(count(seed, "SELECT count(*) FROM audit_log WHERE action = 'business.upi_vpa_set' AND entity_id = ?", seed.business()))
				.as("audited on change only").isEqualTo(1);
		mvc.perform(asOwner(put(path), seed).content(json.writeValueAsString(Map.of("name", "K", "gstMode", "non_gst")))).andExpect(status().isOk())
				.andExpect(jsonPath("$.upiVpa").doesNotExist());
		assertThat(count(seed, "SELECT count(*) FROM audit_log WHERE action = 'business.upi_vpa_set' AND entity_id = ?", seed.business())).isEqualTo(2);
	}
}
