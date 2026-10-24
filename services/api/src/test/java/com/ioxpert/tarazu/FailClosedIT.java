package com.ioxpert.tarazu;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.web.servlet.mvc.method.RequestMappingInfo;
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;

/**
 * Locked rule 6: /v1/** fails closed. Runs with the production default (dev header OFF) and walks every mapped
 * /v1 endpoint, so an endpoint added later cannot silently ship unauthenticated.
 */
@SpringBootTest
@AutoConfigureMockMvc
@TestPropertySource(properties = "tarazu.auth.dev-header-enabled=no") // anything but "true" is OFF
class FailClosedIT extends AbstractPostgresIT {

	@Autowired MockMvc mvc;
	@Autowired @org.springframework.beans.factory.annotation.Qualifier("requestMappingHandlerMapping") RequestMappingHandlerMapping mappings;

	@Test
	void everyV1EndpointIs401WithoutADeviceCredentialAndTheDevTenantHeaderIsIgnored() throws Exception {
		List<String> checked = new ArrayList<>();
		List<String> publicSeen = new ArrayList<>();
		for (RequestMappingInfo info : mappings.getHandlerMethods().keySet()) {
			for (String pattern : info.getPathPatternsCondition().getPatternValues()) {
				if (!pattern.startsWith("/v1/")) {
					continue;
				}
				if (com.ioxpert.tarazu.tenancy.PublicPaths.ALL.contains(pattern)) {
					publicSeen.add(pattern);
					continue; // the OTP handshake and pairing redemption are deliberately public (ADR 0007, 0015); asserted separately below
				}
				String path = pattern.replaceAll("\\{[^}]+}", UUID.randomUUID().toString());
				for (var method : info.getMethodsCondition().getMethods()) {
					HttpMethod m = HttpMethod.valueOf(method.name());
					mvc.perform(request(m, path).contentType(MediaType.APPLICATION_JSON).content("{}"))
							.andExpect(status().isUnauthorized()).andExpect(jsonPath("$.code").value("authentication_required"));
					// the dev header is a no-op when the switch is off
					mvc.perform(request(m, path).header("X-Tenant-Id", UUID.randomUUID()).header("X-Staff-Id", UUID.randomUUID())
							.contentType(MediaType.APPLICATION_JSON).content("{}")).andExpect(status().isUnauthorized());
					checked.add(m + " " + pattern);
				}
			}
		}
		assertThat(publicSeen).as("every allow-listed public path is a real endpoint and nothing else is public")
				.containsExactlyInAnyOrderElementsOf(com.ioxpert.tarazu.tenancy.PublicPaths.ALL);
		assertThat(checked).as("the walk really found the API").hasSizeGreaterThan(25).contains("POST /v1/sync/upload");
	}

	@Test
	void theOtpEndpointsAreNotConfiguredWithoutAPepperAndSaySoInsteadOfUsingADefaultSecret() throws Exception {
		mvc.perform(request(HttpMethod.GET, "/v1/auth/otp/config")).andExpect(status().isOk()).andExpect(jsonPath("$.enabled").value(false));
		mvc.perform(request(HttpMethod.POST, "/v1/auth/signup/start").contentType(MediaType.APPLICATION_JSON)
				.content("{\"ownerName\":\"A\",\"businessName\":\"B\",\"email\":\"a@b.in\"}"))
				.andExpect(status().isServiceUnavailable()).andExpect(jsonPath("$.code").value("otp_not_configured"));
		mvc.perform(request(HttpMethod.POST, "/v1/pairing/redeem").contentType(MediaType.APPLICATION_JSON)
				.content("{\"code\":\"ABCD-EFGH\",\"deviceId\":\"" + UUID.randomUUID() + "\",\"secret\":\"" + "a".repeat(43) + "\"}"))
				.andExpect(status().isServiceUnavailable()).andExpect(jsonPath("$.code").value("pairing_not_configured"));
	}

	@Test
	void encodedOrParameterisedPathsDoNotSlipPastTheGuard() throws Exception {
		mvc.perform(request(HttpMethod.GET, "/%76%31/tax/rules")).andExpect(status().isUnauthorized());
		mvc.perform(request(HttpMethod.GET, "/v1;a=b/consent/purposes")).andExpect(status().isUnauthorized());
		mvc.perform(request(HttpMethod.GET, "/v1/auth/otp/config/")).andExpect(status().isUnauthorized());
		mvc.perform(request(HttpMethod.GET, "/v1/auth/%6Ftp/config")).andExpect(status().isUnauthorized());
		mvc.perform(request(HttpMethod.GET, "/actuator/health")).andExpect(status().isOk());
	}

	@Test
	void anOversizedBodyIsRefusedBeforeAnyWork() throws Exception {
		byte[] huge = new byte[9 * 1024 * 1024];
		mvc.perform(request(HttpMethod.POST, "/v1/sync/upload").contentType(MediaType.APPLICATION_JSON).content(huge))
				.andExpect(status().isPayloadTooLarge()).andExpect(jsonPath("$.code").value("payload_too_large"));
	}
}
