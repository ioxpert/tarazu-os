package com.ioxpert.tarazu.identity;

import static com.ioxpert.tarazu.Ops.m;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.ioxpert.tarazu.ApiIT;
import com.ioxpert.tarazu.Ops;
import com.ioxpert.tarazu.Seed;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

class IdentityIT extends ApiIT {

	private MockHttpServletRequestBuilder asOwner(MockHttpServletRequestBuilder req, Seed seed) {
		return req.header("X-Tenant-Id", seed.tenant()).header("X-Staff-Id", seed.owner())
				.contentType(MediaType.APPLICATION_JSON);
	}

	private String body(Object o) {
		return json.writeValueAsString(o);
	}

	/** Registers a device through the API and returns its bearer token. */
	private String registerDevice(Seed seed, UUID deviceId) throws Exception {
		var res = mvc.perform(asOwner(put("/v1/identity/devices/" + deviceId), seed)
				.content(body(Map.of("storeId", seed.store(), "label", "Counter 2"))))
				.andExpect(status().isCreated()).andExpect(jsonPath("$.token").isNotEmpty()).andReturn();
		return json.readTree(res.getResponse().getContentAsString()).get("token").asString();
	}

	private void setPin(Seed seed, UUID user, String pin) throws Exception {
		mvc.perform(asOwner(put("/v1/identity/users/" + user + "/pin"), seed)
				.content(body(Map.of("pin", pin, "reason", "initial PIN")))).andExpect(status().isNoContent());
	}

	@Test
	void managementCallsNeedAnIdentifiedStaffMemberWithTheRole() throws Exception {
		Seed seed = seedTenant();
		UUID cashier = addUser(seed, "cashier");
		mvc.perform(put("/v1/identity/devices/" + UUID.randomUUID()).header("X-Tenant-Id", seed.tenant())
				.contentType(MediaType.APPLICATION_JSON).content(body(Map.of("storeId", seed.store()))))
				.andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("staff_identification_required"));
		mvc.perform(put("/v1/identity/devices/" + UUID.randomUUID()).header("X-Tenant-Id", seed.tenant())
				.header("X-Staff-Id", cashier).contentType(MediaType.APPLICATION_JSON).content(body(Map.of("storeId", seed.store()))))
				.andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("permission_denied"));
		mvc.perform(get("/v1/identity/me").header("X-Tenant-Id", seed.tenant()).header("X-Staff-Id", cashier))
				.andExpect(status().isOk()).andExpect(jsonPath("$.roles[0]").value("cashier"));
	}

	@Test
	void aRegisteredDeviceAuthenticatesWithItsTokenAndTheSecretIsShownOnce() throws Exception {
		Seed seed = seedTenant();
		UUID device = UUID.randomUUID();
		String token = registerDevice(seed, device);

		mvc.perform(get("/v1/identity/me").header("Authorization", "Bearer " + token))
				.andExpect(status().isOk()).andExpect(jsonPath("$.deviceId").value(device.toString()))
				.andExpect(jsonPath("$.tenantId").value(seed.tenant().toString()));

		// replay of the registration: same device, no secret
		mvc.perform(asOwner(put("/v1/identity/devices/" + device), seed).content(body(Map.of("storeId", seed.store()))))
				.andExpect(status().isOk()).andExpect(jsonPath("$.token").doesNotExist());
		// the id cannot be re-pointed at another store
		UUID otherStore = UUID.randomUUID();
		inTenant(seed.tenant(), () -> jdbc.update("INSERT INTO store (id, tenant_id, business_id, name) VALUES (?, ?, ?, 'Second')",
				otherStore, seed.tenant(), seed.business()));
		mvc.perform(asOwner(put("/v1/identity/devices/" + device), seed).content(body(Map.of("storeId", otherStore))))
				.andExpect(status().isConflict());

		// wrong secret, malformed token, other tenant's id: all 401, none leak which part was wrong
		String forged = token.substring(0, token.lastIndexOf('.') + 1) + "AAAA";
		mvc.perform(get("/v1/identity/me").header("Authorization", "Bearer " + forged))
				.andExpect(status().isUnauthorized()).andExpect(jsonPath("$.code").value("invalid_token"));
		mvc.perform(get("/v1/identity/me").header("Authorization", "Bearer tzd.nonsense"))
				.andExpect(status().isUnauthorized());
		assertThat(count(seed, "SELECT count(*) FROM device WHERE token_hash IS NOT NULL AND id = ?", device))
				.as("only a hash of the secret is stored").isEqualTo(1);
	}

	@Test
	void aRevokedDeviceIsRefusedAtItsNextSyncAndItsUnsyncedOpsAreNotApplied() throws Exception {
		Seed seed = seedTenant();
		UUID device = UUID.randomUUID();
		String token = registerDevice(seed, device);
		var ops = new Ops(seed, device, null);

		mvc.perform(post("/v1/sync/upload").header("Authorization", "Bearer " + token).contentType(MediaType.APPLICATION_JSON)
				.content(body(Map.of("operations", List.of(ops.product(UUID.randomUUID(), "before revoke"))))))
				.andExpect(status().isOk());

		mvc.perform(asOwner(post("/v1/identity/devices/" + device + "/revoke"), seed)
				.content(body(Map.of("reason", "phone stolen")))).andExpect(status().isNoContent());
		// idempotent
		mvc.perform(asOwner(post("/v1/identity/devices/" + device + "/revoke"), seed)
				.content(body(Map.of("reason", "phone stolen")))).andExpect(status().isNoContent());

		mvc.perform(post("/v1/sync/upload").header("Authorization", "Bearer " + token).contentType(MediaType.APPLICATION_JSON)
				.content(body(Map.of("operations", List.of(ops.product(UUID.randomUUID(), "after revoke"))))))
				.andExpect(status().isUnauthorized()).andExpect(jsonPath("$.code").value("device_revoked"));
		mvc.perform(get("/v1/sync/credentials").header("Authorization", "Bearer " + token))
				.andExpect(status().isUnauthorized()).andExpect(jsonPath("$.code").value("device_revoked"));

		// even on a path that does not use the token (dev header), a revoked device's ops are refused
		uploadRaw(seed.tenant(), List.of(ops.product(UUID.randomUUID(), "via dev header")))
				.andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("device_revoked"));
		assertThat(count(seed, "SELECT count(*) FROM product")).isEqualTo(1);
		assertThat(count(seed, "SELECT count(*) FROM audit_log WHERE action = 'device.revoked' AND reason = 'phone stolen'"))
				.as("revoked once, audited once").isEqualTo(1);
	}

	@Test
	void aDeviceCanOnlyUploadAsItself() throws Exception {
		Seed seed = seedTenant();
		UUID device = UUID.randomUUID();
		String token = registerDevice(seed, device);
		var asOther = new Ops(seed); // seed.device(), not the token's device
		mvc.perform(post("/v1/sync/upload").header("Authorization", "Bearer " + token).contentType(MediaType.APPLICATION_JSON)
				.content(body(Map.of("operations", List.of(asOther.product(UUID.randomUUID(), "spoof"))))))
				.andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("device_mismatch"));
	}

	@Test
	void staffPinIsVerifiedWithLockoutAndNeverStoredInTheClear() throws Exception {
		Seed seed = seedTenant();
		UUID cashier = addUser(seed, "cashier");
		setPin(seed, cashier, "4821");
		assertThat(inTenant(seed.tenant(), () -> jdbc.queryForObject("SELECT pin_hash IS NOT NULL AND pin_salt IS NOT NULL FROM app_user WHERE id = ?", Boolean.class, cashier))).isTrue();
		assertThat(inTenant(seed.tenant(), () -> jdbc.queryForObject("SELECT encode(pin_hash, 'escape') LIKE '%4821%' FROM app_user WHERE id = ?", Boolean.class, cashier))).isFalse();

		mvc.perform(post("/v1/identity/users/" + cashier + "/pin/verify").header("X-Tenant-Id", seed.tenant())
				.contentType(MediaType.APPLICATION_JSON).content(body(Map.of("pin", "4821"))))
				.andExpect(status().isOk()).andExpect(jsonPath("$.valid").value(true)).andExpect(jsonPath("$.roles[0]").value("cashier"));
		for (int i = 0; i < 4; i++) {
			mvc.perform(post("/v1/identity/users/" + cashier + "/pin/verify").header("X-Tenant-Id", seed.tenant())
					.contentType(MediaType.APPLICATION_JSON).content(body(Map.of("pin", "0000"))))
					.andExpect(status().isOk()).andExpect(jsonPath("$.valid").value(false));
		}
		mvc.perform(post("/v1/identity/users/" + cashier + "/pin/verify").header("X-Tenant-Id", seed.tenant())
				.contentType(MediaType.APPLICATION_JSON).content(body(Map.of("pin", "0000")))).andExpect(status().isLocked());
		// locked out even with the right PIN
		mvc.perform(post("/v1/identity/users/" + cashier + "/pin/verify").header("X-Tenant-Id", seed.tenant())
				.contentType(MediaType.APPLICATION_JSON).content(body(Map.of("pin", "4821"))))
				.andExpect(status().isLocked());

		// owner resets the PIN, which clears the lock
		setPin(seed, cashier, "9090");
		mvc.perform(post("/v1/identity/users/" + cashier + "/pin/verify").header("X-Tenant-Id", seed.tenant())
				.contentType(MediaType.APPLICATION_JSON).content(body(Map.of("pin", "9090")))).andExpect(status().isOk())
				.andExpect(jsonPath("$.valid").value(true));
	}

	@Test
	void aDeviceTokenPlusStaffPinIdentifiesTheActingStaffMember() throws Exception {
		Seed seed = seedTenant();
		UUID device = UUID.randomUUID();
		String token = registerDevice(seed, device);
		UUID manager = addUser(seed, "manager");
		setPin(seed, manager, "2468");

		mvc.perform(get("/v1/identity/me").header("Authorization", "Bearer " + token).header("X-Staff-Id", manager).header("X-Staff-Pin", "2468"))
				.andExpect(status().isOk()).andExpect(jsonPath("$.userId").value(manager.toString()))
				.andExpect(jsonPath("$.roles[0]").value("manager"));
		mvc.perform(get("/v1/identity/me").header("Authorization", "Bearer " + token).header("X-Staff-Id", manager).header("X-Staff-Pin", "1111"))
				.andExpect(status().isUnauthorized()).andExpect(jsonPath("$.code").value("invalid_pin"));
		mvc.perform(get("/v1/identity/users").header("Authorization", "Bearer " + token).header("X-Staff-Id", manager).header("X-Staff-Pin", "2468"))
				.andExpect(status().isOk());
	}

	@Test
	void rolesAreGrantedWithAReasonOnlyAnOwnerTouchesOwnerAndTheLastOwnerStays() throws Exception {
		Seed seed = seedTenant();
		UUID manager = addUser(seed, "manager");
		UUID staff = UUID.randomUUID();
		mvc.perform(asOwner(put("/v1/identity/users/" + staff), seed).content(body(Map.of("displayName", "Sunita"))))
				.andExpect(status().isOk()).andExpect(jsonPath("$.status").value("active"));
		mvc.perform(asOwner(put("/v1/identity/users/" + staff + "/roles"), seed)
				.content(body(Map.of("roles", List.of(Map.of("role", "cashier", "storeId", seed.store()), Map.of("role", "accountant")), "reason", "joined"))))
				.andExpect(status().isOk()).andExpect(jsonPath("$.roles.length()").value(2));

		// a manager cannot mint owners
		mvc.perform(put("/v1/identity/users/" + staff + "/roles").header("X-Tenant-Id", seed.tenant()).header("X-Staff-Id", manager)
				.contentType(MediaType.APPLICATION_JSON).content(body(Map.of("roles", List.of(Map.of("role", "owner")), "reason", "sneaky"))))
				.andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("owner_only"));
		// the only owner cannot be demoted or disabled
		mvc.perform(asOwner(put("/v1/identity/users/" + seed.owner() + "/roles"), seed)
				.content(body(Map.of("roles", List.of(Map.of("role", "manager")), "reason", "oops")))).andExpect(status().isConflict())
				.andExpect(jsonPath("$.code").value("last_owner"));
		mvc.perform(asOwner(put("/v1/identity/users/" + seed.owner()), seed).content(body(Map.of("displayName", "Owner", "status", "disabled"))))
				.andExpect(status().isConflict());
		assertThat(count(seed, "SELECT count(*) FROM user_role WHERE user_id = ? AND role = 'owner'", seed.owner())).isEqualTo(1);
		// roles scoped to a store that does not exist are refused
		mvc.perform(asOwner(put("/v1/identity/users/" + staff + "/roles"), seed)
				.content(body(Map.of("roles", List.of(Map.of("role", "cashier", "storeId", UUID.randomUUID())), "reason", "x"))))
				.andExpect(status().isUnprocessableEntity());
	}

	@Test
	void aManagerCannotTakeOverAnOwnerAccount() throws Exception {
		Seed seed = seedTenant();
		UUID manager = addUser(seed, "manager");
		for (var req : List.of(
				put("/v1/identity/users/" + seed.owner() + "/pin").content(body(Map.of("pin", "1234", "reason", "x"))),
				put("/v1/identity/users/" + seed.owner()).content(body(Map.of("displayName", "Owner", "status", "disabled"))),
				put("/v1/identity/users/" + seed.owner() + "/roles").content(body(Map.of("roles", List.of(Map.of("role", "owner", "storeId", seed.store())), "reason", "x"))))) {
			mvc.perform(req.header("X-Tenant-Id", seed.tenant()).header("X-Staff-Id", manager).contentType(MediaType.APPLICATION_JSON))
					.andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("owner_only"));
		}
		assertThat(count(seed, "SELECT count(*) FROM app_user WHERE id = ? AND pin_hash IS NULL AND status = 'active'", seed.owner())).isEqualTo(1);
	}

	@Test
	void theBusinessGstModeIsSetByTheOwnerAndAuditedAndTheHierarchyIsEnforced() throws Exception {
		Seed seed = seedTenant();
		UUID business = UUID.randomUUID();
		mvc.perform(asOwner(put("/v1/identity/businesses/" + business), seed)
				.content(body(Map.of("name", "Wholesale arm", "gstMode", "composition", "gstin", "27AAPFU0939F1ZV", "stateCode", "27"))))
				.andExpect(status().isOk()).andExpect(jsonPath("$.gstMode").value("composition"));
		UUID store = UUID.randomUUID();
		mvc.perform(asOwner(put("/v1/identity/stores/" + store), seed).content(body(Map.of("businessId", business, "name", "Godown"))))
				.andExpect(status().isOk());
		mvc.perform(asOwner(put("/v1/identity/stores/" + UUID.randomUUID()), seed).content(body(Map.of("businessId", UUID.randomUUID(), "name", "Orphan"))))
				.andExpect(status().isUnprocessableEntity());
		mvc.perform(asOwner(put("/v1/identity/stores/" + store), seed).content(body(Map.of("businessId", seed.business(), "name", "Moved"))))
				.andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("store_business_immutable"));
		mvc.perform(asOwner(put("/v1/identity/businesses/" + business), seed).content(body(Map.of("name", "x", "gstMode", "bogus"))))
				.andExpect(status().isBadRequest());
		assertThat(count(seed, "SELECT count(*) FROM audit_log WHERE action = 'business.gst_mode_set' AND entity_id = ?", business)).isEqualTo(1);
	}

	@Test
	void theAuditLogRecordsActorReasonAndTimeAndCannotBeEdited() throws Exception {
		Seed seed = seedTenant();
		UUID device = UUID.randomUUID();
		registerDevice(seed, device);
		mvc.perform(asOwner(post("/v1/identity/devices/" + device + "/revoke"), seed).content(body(Map.of("reason", "lost"))))
				.andExpect(status().isNoContent());

		mvc.perform(asOwner(get("/v1/identity/audit-log").param("entityType", "device").param("entityId", device.toString()), seed))
				.andExpect(status().isOk()).andExpect(jsonPath("$.length()").value(2))
				.andExpect(jsonPath("$[0].action").value("device.revoked")).andExpect(jsonPath("$[0].reason").value("lost"))
				.andExpect(jsonPath("$[0].actorUserId").value(seed.owner().toString()))
				.andExpect(jsonPath("$[0].occurredAt").isNotEmpty());
		UUID cashier = addUser(seed, "cashier");
		mvc.perform(get("/v1/identity/audit-log").header("X-Tenant-Id", seed.tenant()).header("X-Staff-Id", cashier))
				.andExpect(status().isForbidden());

		org.assertj.core.api.Assertions.assertThatThrownBy(() -> inTenant(seed.tenant(), () -> jdbc.update("UPDATE audit_log SET reason = 'edited'")))
				.isInstanceOf(org.springframework.dao.DataAccessException.class);
		org.assertj.core.api.Assertions.assertThatThrownBy(() -> inTenant(seed.tenant(), () -> jdbc.update("DELETE FROM audit_log")))
				.isInstanceOf(org.springframework.dao.DataAccessException.class);
	}

	@Test
	void otherTenantsUsersDevicesAndAuditAreInvisible() throws Exception {
		Seed a = seedTenant();
		Seed b = seedTenant();
		mvc.perform(asOwner(get("/v1/identity/users"), b)).andExpect(status().isOk()).andExpect(jsonPath("$.length()").value(1));
		mvc.perform(asOwner(get("/v1/identity/users/" + a.owner()), b)).andExpect(status().isNotFound());
		mvc.perform(asOwner(post("/v1/identity/devices/" + a.device() + "/revoke"), b).content(body(Map.of("reason", "x"))))
				.andExpect(status().isNotFound());
		// a device token minted for tenant A cannot be replayed as tenant B (the tenant id is part of the token)
		UUID device = UUID.randomUUID();
		String tokenA = registerDevice(a, device);
		String swapped = tokenA.replace(a.tenant().toString(), b.tenant().toString());
		mvc.perform(get("/v1/identity/me").header("Authorization", "Bearer " + swapped)).andExpect(status().isUnauthorized());
	}
}
