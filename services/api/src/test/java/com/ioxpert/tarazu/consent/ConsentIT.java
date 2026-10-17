package com.ioxpert.tarazu.consent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.ioxpert.tarazu.ApiIT;
import com.ioxpert.tarazu.Ops;
import com.ioxpert.tarazu.Seed;
import com.ioxpert.tarazu.tenancy.UuidV7;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessException;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

class ConsentIT extends ApiIT {

	private MockHttpServletRequestBuilder asOwner(MockHttpServletRequestBuilder req, Seed seed) {
		return req.header("X-Tenant-Id", seed.tenant()).header("X-Staff-Id", seed.owner()).contentType(MediaType.APPLICATION_JSON);
	}

	private Map<String, Object> event(UUID subject, String purpose, String action, String key) {
		Map<String, Object> e = new LinkedHashMap<>();
		e.put("operationId", UuidV7.next());
		e.put("idempotencyKey", key);
		e.put("subjectType", "party");
		e.put("subjectId", subject);
		e.put("purpose", purpose);
		e.put("action", action);
		e.put("policyVersion", "2026-10-v1");
		e.put("channel", "in_app");
		e.put("occurredAt", Instant.now().toString());
		return e;
	}

	@Test
	void nothingIsPreSelectedAndEveryPurposeIsSeparate() throws Exception {
		Seed seed = seedTenant();
		UUID customer = UUID.randomUUID();
		mvc.perform(asOwner(get("/v1/consent/purposes"), seed)).andExpect(status().isOk())
				.andExpect(jsonPath("$[?(@.id=='marketing_messages')]").exists())
				.andExpect(jsonPath("$[?(@.id=='third_party_sharing' && @.thirdParty==true)]").exists());
		mvc.perform(asOwner(get("/v1/consent/subjects/party/" + customer), seed)).andExpect(status().isOk())
				.andExpect(jsonPath("$.current.length()").value(0));

		mvc.perform(asOwner(post("/v1/consent/events"), seed).content(json.writeValueAsString(event(customer, "whatsapp_reminders", "grant", "k1"))))
				.andExpect(status().isOk()).andExpect(jsonPath("$.action").value("grant"));
		mvc.perform(asOwner(get("/v1/consent/subjects/party/" + customer), seed)).andExpect(jsonPath("$.current.length()").value(1))
				.andExpect(jsonPath("$.current[0].purpose").value("whatsapp_reminders"));
	}

	@Test
	void everyFieldMustBeChosenByTheCaller() throws Exception {
		Seed seed = seedTenant();
		Map<String, Object> noAction = event(UUID.randomUUID(), "marketing_messages", "grant", "k");
		noAction.remove("action");
		mvc.perform(asOwner(post("/v1/consent/events"), seed).content(json.writeValueAsString(noAction))).andExpect(status().isBadRequest());
		Map<String, Object> noPolicy = event(UUID.randomUUID(), "marketing_messages", "grant", "k");
		noPolicy.remove("policyVersion");
		mvc.perform(asOwner(post("/v1/consent/events"), seed).content(json.writeValueAsString(noPolicy))).andExpect(status().isBadRequest());
		mvc.perform(asOwner(post("/v1/consent/events"), seed).content(json.writeValueAsString(event(UUID.randomUUID(), "mind_reading", "grant", "k"))))
				.andExpect(status().isUnprocessableEntity()).andExpect(jsonPath("$.code").value("unknown_purpose"));
	}

	@Test
	void withdrawalOverridesAGrantHistoryIsKeptAndReplayIsIdempotent() throws Exception {
		Seed seed = seedTenant();
		UUID customer = UUID.randomUUID();
		var grant = event(customer, "marketing_messages", "grant", "g1");
		var withdraw = event(customer, "marketing_messages", "withdraw", "w1");
		withdraw.put("occurredAt", Instant.now().plusSeconds(5).toString());
		mvc.perform(asOwner(post("/v1/consent/events"), seed).content(json.writeValueAsString(grant))).andExpect(status().isOk());
		mvc.perform(asOwner(post("/v1/consent/events"), seed).content(json.writeValueAsString(grant))).andExpect(status().isOk());
		mvc.perform(asOwner(post("/v1/consent/events"), seed).content(json.writeValueAsString(withdraw))).andExpect(status().isOk());

		mvc.perform(asOwner(get("/v1/consent/subjects/party/" + customer), seed)).andExpect(status().isOk())
				.andExpect(jsonPath("$.current[0].action").value("withdraw"))
				.andExpect(jsonPath("$.history.length()").value(2));
		assertThat(count(seed, "SELECT count(*) FROM consent_event")).isEqualTo(2);
		assertThat(count(seed, "SELECT count(*) FROM audit_log WHERE action LIKE 'consent.%'")).isEqualTo(2);
		org.assertj.core.api.Assertions.assertThatThrownBy(() -> inTenant(seed.tenant(), () -> jdbc.update("UPDATE consent_event SET action = 'grant'")))
				.isInstanceOf(DataAccessException.class);
		org.assertj.core.api.Assertions.assertThatThrownBy(() -> inTenant(seed.tenant(), () -> jdbc.update("DELETE FROM consent_event")))
				.isInstanceOf(DataAccessException.class);
	}

	@Test
	void sharingWithAThirdPartyNeedsAnActiveGrantAndIsLogged() throws Exception {
		Seed seed = seedTenant();
		UUID customer = UUID.randomUUID();
		Map<String, Object> share = new LinkedHashMap<>();
		share.put("operationId", UuidV7.next());
		share.put("idempotencyKey", "s1");
		share.put("subjectType", "party");
		share.put("subjectId", customer);
		share.put("purpose", "credit_assessment");
		share.put("recipient", "Acme Lender Pvt Ltd");
		share.put("dataCategories", List.of("transaction_summary"));
		share.put("sharedAt", Instant.now().toString());

		mvc.perform(asOwner(post("/v1/consent/sharing-log"), seed).content(json.writeValueAsString(share)))
				.andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("consent_not_granted"));

		mvc.perform(asOwner(post("/v1/consent/events"), seed).content(json.writeValueAsString(event(customer, "credit_assessment", "grant", "cg"))))
				.andExpect(status().isOk());
		mvc.perform(asOwner(post("/v1/consent/sharing-log"), seed).content(json.writeValueAsString(share)))
				.andExpect(status().isOk()).andExpect(jsonPath("$.recipient").value("Acme Lender Pvt Ltd"));
		mvc.perform(asOwner(post("/v1/consent/sharing-log"), seed).content(json.writeValueAsString(share))).andExpect(status().isOk());
		mvc.perform(asOwner(get("/v1/consent/sharing-log").param("subjectId", customer.toString()), seed))
				.andExpect(jsonPath("$.length()").value(1));

		// a purpose that does not involve third parties has no sharing log
		Map<String, Object> wrongPurpose = new LinkedHashMap<>(share);
		wrongPurpose.put("operationId", UuidV7.next());
		wrongPurpose.put("idempotencyKey", "s2");
		wrongPurpose.put("purpose", "marketing_messages");
		mvc.perform(asOwner(post("/v1/consent/sharing-log"), seed).content(json.writeValueAsString(wrongPurpose)))
				.andExpect(status().isUnprocessableEntity());

		// after withdrawal, sharing stops
		var withdraw = event(customer, "credit_assessment", "withdraw", "cw");
		withdraw.put("occurredAt", Instant.now().plusSeconds(5).toString());
		mvc.perform(asOwner(post("/v1/consent/events"), seed).content(json.writeValueAsString(withdraw))).andExpect(status().isOk());
		Map<String, Object> again = new LinkedHashMap<>(share);
		again.put("operationId", UuidV7.next());
		again.put("idempotencyKey", "s3");
		mvc.perform(asOwner(post("/v1/consent/sharing-log"), seed).content(json.writeValueAsString(again)))
				.andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("consent_not_granted"));
	}

	@Test
	void localOnlyModeStopsUploadsAndSharingAndIsAuditedAndOwnerOnly() throws Exception {
		Seed seed = seedTenant();
		var device = new Ops(seed);
		UUID manager = addUser(seed, "manager");
		mvc.perform(put("/v1/consent/mode").header("X-Tenant-Id", seed.tenant()).header("X-Staff-Id", manager)
				.contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("localOnly", true, "reason", "x"))))
				.andExpect(status().isForbidden());
		mvc.perform(get("/v1/consent/mode").header("X-Tenant-Id", seed.tenant())).andExpect(jsonPath("$.localOnly").value(false));

		mvc.perform(asOwner(put("/v1/consent/mode"), seed).content(json.writeValueAsString(Map.of("localOnly", true, "reason", "owner prefers data on device"))))
				.andExpect(status().isOk()).andExpect(jsonPath("$.localOnly").value(true));
		uploadRaw(seed.tenant(), List.of(device.product(UUID.randomUUID(), "blocked")))
				.andExpect(status().isForbidden()).andExpect(jsonPath("$.code").value("local_only_mode"));
		assertThat(count(seed, "SELECT count(*) FROM operation_log")).as("nothing leaves the device").isZero();

		mvc.perform(asOwner(put("/v1/consent/mode"), seed).content(json.writeValueAsString(Map.of("localOnly", false, "reason", "back online"))))
				.andExpect(status().isOk());
		upload(seed, device.product(UUID.randomUUID(), "allowed again"));
		assertThat(count(seed, "SELECT count(*) FROM audit_log WHERE action = 'tenant.local_only_set'")).isEqualTo(2);
	}

	@Test
	void consentIsTenantIsolated() throws Exception {
		Seed a = seedTenant();
		Seed b = seedTenant();
		UUID customer = UUID.randomUUID();
		mvc.perform(asOwner(post("/v1/consent/events"), a).content(json.writeValueAsString(event(customer, "marketing_messages", "grant", "x"))))
				.andExpect(status().isOk());
		mvc.perform(asOwner(get("/v1/consent/subjects/party/" + customer), b)).andExpect(jsonPath("$.current.length()").value(0))
				.andExpect(jsonPath("$.history.length()").value(0));
		assertThat(count(b, "SELECT count(*) FROM consent_event")).isZero();
	}
}
