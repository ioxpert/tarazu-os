package com.ioxpert.tarazu.identity;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.Map;
import java.util.UUID;

import com.ioxpert.tarazu.AdminSql;
import com.ioxpert.tarazu.ApiIT;
import com.ioxpert.tarazu.Seed;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.env.Environment;
import org.springframework.http.MediaType;
import org.springframework.test.context.TestPropertySource;

/** The deployment-wide budget of wrong codes (ADR 0015): a guesser is stopped, and a wrong guess never reveals anything. Own context: budget of 3. */
@TestPropertySource(properties = "tarazu.pairing.max-failures=3")
class PairingBudgetIT extends ApiIT {

	@Autowired Environment env;

	@BeforeEach
	void freshBudget() {
		AdminSql.of(env).update("DELETE FROM otp_throttle");
	}

	private org.springframework.test.web.servlet.ResultActions redeem(String code) throws Exception {
		return mvc.perform(post("/v1/pairing/redeem").contentType(MediaType.APPLICATION_JSON)
				.content(json.writeValueAsString(Map.of("code", code, "deviceId", UUID.randomUUID(), "secret", "a".repeat(43)))));
	}

	@Test
	void afterTheBudgetOfWrongCodesEvenARightCodeWaitsUntilTheWindowPasses() throws Exception {
		Seed seed = seedTenant();
		var created = mvc.perform(post("/v1/identity/device-pairings").header("X-Tenant-Id", seed.tenant()).header("X-Staff-Id", seed.owner())
				.contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("storeId", seed.store()))))
				.andExpect(status().isCreated()).andReturn();
		String code = json.readTree(created.getResponse().getContentAsString()).get("code").asString();

		for (int i = 0; i < 3; i++) {
			redeem("AAAA-AAA" + "ABCD".charAt(i)).andExpect(status().isNotFound());
		}
		redeem("AAAA-AAAA").andExpect(status().isTooManyRequests()).andExpect(jsonPath("$.code").value("too_many_requests"));
		redeem(code).andExpect(status().isTooManyRequests());

		AdminSql.of(env).update("DELETE FROM otp_throttle");
		redeem(code).andExpect(status().isCreated());
	}
}
