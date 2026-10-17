package com.ioxpert.tarazu.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;

import com.ioxpert.tarazu.ApiIT;
import com.ioxpert.tarazu.identity.ContactDirectory.Channel;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.ResultActions;
import tools.jackson.databind.JsonNode;

class OtpOnboardingIT extends ApiIT {

	private static final AtomicInteger SEQ = new AtomicInteger(1000);
	/** The login directory is global and survives runs on a reused database, so contacts must be unique per run. */
	private static final String RUN = UUID.randomUUID().toString().substring(0, 8);
	private static final int PHONE_BASE = new java.util.Random().nextInt(90_000_000) + 10_000_000;

	@Autowired OtpSettings settings;

	@AfterEach
	void restore() {
		settings.setMode(OtpSettings.Mode.EITHER);
		settings.setMaxAttempts(5);
		settings.setResendSeconds(0);
		settings.setMaxPerHour(1000);
	}

	private String email() {
		return "owner" + SEQ.incrementAndGet() + "-" + RUN + "@example.in";
	}

	private String phone() {
		return "+9198" + String.format("%08d", PHONE_BASE + SEQ.incrementAndGet());
	}

	private ResultActions postJson(String path, Map<String, ?> body) throws Exception {
		return mvc.perform(post(path).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(body)));
	}

	private JsonNode ok(ResultActions r) throws Exception {
		return json.readTree(r.andReturn().getResponse().getContentAsString());
	}

	/** Like andExpect(status) but the failure message carries the problem body. */
	private ResultActions expect(ResultActions r, int status) throws Exception {
		var res = r.andReturn().getResponse();
		assertThat(res.getStatus()).as(res.getContentAsString()).isEqualTo(status);
		return r;
	}

	private JsonNode startSignup(Map<String, ?> body) throws Exception {
		return ok(expect(postJson("/v1/auth/signup/start", body), 202));
	}

	private ResultActions verifySignup(String token, String channel, String code) throws Exception {
		return postJson("/v1/auth/signup/verify", Map.of("signupToken", token, "channel", channel, "code", code));
	}

	private static String code(Channel channel, String contact) {
		return CapturingOtpSender.lastCode(channel, contact);
	}

	private JsonNode signUpWithEmail(String email) throws Exception {
		JsonNode started = startSignup(Map.of("ownerName", "Asha Rao", "businessName", "Rao Stores", "email", email));
		return ok(expect(verifySignup(started.get("signupToken").asString(), "email", code(Channel.EMAIL, email)), 200));
	}

	@Test
	void configTellsTheClientWhichProofsAreNeeded() throws Exception {
		assertThat(settings.maxPerHour()).isEqualTo(1000);
		assertThat(settings.resendSeconds()).isZero();
		mvc.perform(get("/v1/auth/otp/config")).andExpect(status().isOk()).andExpect(jsonPath("$.enabled").value(true))
				.andExpect(jsonPath("$.mode").value("either")).andExpect(jsonPath("$.channels.length()").value(2));
		settings.setMode(OtpSettings.Mode.BOTH);
		mvc.perform(get("/v1/auth/otp/config")).andExpect(jsonPath("$.signupRequires.length()").value(2));
		settings.setMode(OtpSettings.Mode.PHONE);
		mvc.perform(get("/v1/auth/otp/config")).andExpect(jsonPath("$.channels[0]").value("phone")).andExpect(jsonPath("$.channels.length()").value(1));
	}

	@Test
	void signingUpWithAnEmailCodeCreatesTheTenantAndAnOwnerSessionThatWorks() throws Exception {
		String email = email();
		JsonNode started = startSignup(Map.of("ownerName", "Asha Rao", "businessName", "Rao Stores", "email", email));
		assertThat(started.get("challenges").get(0).get("sentTo").asString()).startsWith(email.substring(0, 1) + "***@");
		String token = started.get("signupToken").asString();

		verifySignup(token, "email", "000000").andExpect(status().isUnauthorized()).andExpect(jsonPath("$.code").value("invalid_code"));
		JsonNode done = ok(verifySignup(token, "email", code(Channel.EMAIL, email)).andExpect(status().isOk()));
		assertThat(done.get("status").asString()).isEqualTo("completed");
		String session = done.get("session").get("token").asString();
		UUID tenant = UUID.fromString(done.get("session").get("tenantId").asString());
		assertThat(session).startsWith("tzs." + tenant + ".");

		mvc.perform(get("/v1/identity/me").header("Authorization", "Bearer " + session)).andExpect(status().isOk())
				.andExpect(jsonPath("$.tenantId").value(tenant.toString())).andExpect(jsonPath("$.roles[0]").value("owner"));
		// the new owner manages the tenant with the session alone: register the first device
		UUID device = UUID.randomUUID();
		mvc.perform(put("/v1/identity/devices/" + device).header("Authorization", "Bearer " + session).contentType(MediaType.APPLICATION_JSON)
				.content(json.writeValueAsString(Map.of("storeId", done.get("storeId").asString(), "label", "Counter 1"))))
				.andExpect(status().isCreated()).andExpect(jsonPath("$.token").isNotEmpty());

		assertThat(inTenantId(tenant, "SELECT count(*) FROM business")).isEqualTo(1);
		assertThat(inTenantId(tenant, "SELECT count(*) FROM store")).isEqualTo(1);
		assertThat(inTenantId(tenant, "SELECT count(*) FROM audit_log WHERE action = 'tenant.onboarded'")).isEqualTo(1);
		assertThat(inTenantId(tenant, "SELECT count(*) FROM user_role WHERE role = 'owner'")).isEqualTo(1);
		// a finished sign-up cannot be replayed
		verifySignup(token, "email", "123456").andExpect(status().isConflict());
	}

	private long inTenantId(UUID tenant, String sql) {
		return inTenant(tenant, () -> jdbc.queryForObject(sql, Long.class));
	}

	@Test
	void bothModeNeedsEmailAndPhoneAndAnySingleOneIsRefused() throws Exception {
		settings.setMode(OtpSettings.Mode.BOTH);
		String email = email();
		String phone = phone();
		postJson("/v1/auth/signup/start", Map.of("ownerName", "A", "businessName", "B", "email", email)).andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.code").value("contact_required"));

		JsonNode started = startSignup(Map.of("ownerName", "A", "businessName", "B", "email", email, "phone", phone));
		assertThat(started.get("challenges").size()).isEqualTo(2);
		String token = started.get("signupToken").asString();
		JsonNode afterEmail = ok(verifySignup(token, "email", code(Channel.EMAIL, email)).andExpect(status().isOk()));
		assertThat(afterEmail.get("status").asString()).isEqualTo("pending");
		assertThat(afterEmail.get("remainingChannels").get(0).asString()).isEqualTo("phone");
		assertThat(afterEmail.get("session").isNull()).isTrue();
		JsonNode done = ok(verifySignup(token, "phone", code(Channel.PHONE, phone)).andExpect(status().isOk()));
		assertThat(done.get("status").asString()).isEqualTo("completed");

		// both contacts now log in to the same account
		for (var c : new Object[][] { { "email", email }, { "phone", phone } }) {
			JsonNode login = ok(postJson("/v1/auth/login/start", Map.of("channel", c[0], "contact", c[1])).andExpect(status().isAccepted()));
			Channel ch = Channel.fromWire((String) c[0]).orElseThrow();
			String contact = ch == Channel.EMAIL ? email : phone;
			JsonNode session = ok(postJson("/v1/auth/login/verify", Map.of("challengeToken", login.get("challengeToken").asString(),
					"code", code(ch, contact))).andExpect(status().isOk()));
			assertThat(session.get("tenantId").asString()).isEqualTo(done.get("session").get("tenantId").asString());
		}
	}

	@Test
	void emailOnlyAndPhoneOnlyModesRejectTheOtherChannel() throws Exception {
		settings.setMode(OtpSettings.Mode.EMAIL);
		postJson("/v1/auth/signup/start", Map.of("ownerName", "A", "businessName", "B", "phone", phone())).andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.code").value("contact_required"));
		postJson("/v1/auth/login/start", Map.of("channel", "phone", "contact", phone())).andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.code").value("channel_not_enabled"));

		settings.setMode(OtpSettings.Mode.PHONE);
		String phone = phone();
		JsonNode started = startSignup(Map.of("ownerName", "A", "businessName", "B", "phone", phone, "email", email()));
		assertThat(started.get("challenges").size()).as("an extra email is ignored in phone-only mode").isEqualTo(1);
		JsonNode done = ok(verifySignup(started.get("signupToken").asString(), "phone", code(Channel.PHONE, phone)).andExpect(status().isOk()));
		assertThat(done.get("status").asString()).isEqualTo("completed");
	}

	@Test
	void eitherModeVerifiesEveryContactTheOwnerGave() throws Exception {
		String email = email();
		String phone = phone();
		JsonNode started = startSignup(Map.of("ownerName", "A", "businessName", "B", "email", email, "phone", phone));
		assertThat(started.get("challenges").size()).isEqualTo(2);
		postJson("/v1/auth/signup/start", Map.of("ownerName", "A", "businessName", "B")).andExpect(status().isBadRequest());
		postJson("/v1/auth/signup/start", Map.of("ownerName", "A", "businessName", "B", "email", "not-an-email")).andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.code").value("invalid_contact"));
	}

	@Test
	void loginWorksAndACodeIsSingleUse() throws Exception {
		String email = email();
		JsonNode signup = signUpWithEmail(email);
		JsonNode login = ok(postJson("/v1/auth/login/start", Map.of("channel", "email", "contact", email.toUpperCase())).andExpect(status().isAccepted()));
		String challenge = login.get("challengeToken").asString();
		String code = code(Channel.EMAIL, email);

		JsonNode session = ok(postJson("/v1/auth/login/verify", Map.of("challengeToken", challenge, "code", code)).andExpect(status().isOk()));
		assertThat(session.get("userId").asString()).isEqualTo(signup.get("session").get("userId").asString());
		assertThat(session.get("roles").get(0).asString()).isEqualTo("owner");
		postJson("/v1/auth/login/verify", Map.of("challengeToken", challenge, "code", code)).andExpect(status().isGone());
	}

	@Test
	void wrongCodesLockTheChallengeAndAnUnknownContactLooksIdentical() throws Exception {
		String email = email();
		signUpWithEmail(email);
		JsonNode login = ok(postJson("/v1/auth/login/start", Map.of("channel", "email", "contact", email)).andExpect(status().isAccepted()));
		String challenge = login.get("challengeToken").asString();
		String right = code(Channel.EMAIL, email);
		String wrong = right.equals("111111") ? "222222" : "111111";
		for (int i = 0; i < 4; i++) {
			postJson("/v1/auth/login/verify", Map.of("challengeToken", challenge, "code", wrong)).andExpect(status().isUnauthorized());
		}
		postJson("/v1/auth/login/verify", Map.of("challengeToken", challenge, "code", wrong)).andExpect(status().isTooManyRequests())
				.andExpect(jsonPath("$.code").value("too_many_attempts"));
		postJson("/v1/auth/login/verify", Map.of("challengeToken", challenge, "code", right)).andExpect(status().isTooManyRequests());

		// nobody lives at this address: same 202 and token shape, and the code can never be right
		JsonNode ghost = ok(postJson("/v1/auth/login/start", Map.of("channel", "email", "contact", email())).andExpect(status().isAccepted()));
		assertThat(ghost.get("challengeToken").asString()).matches("[0-9a-f-]{36}\\.[0-9a-f-]{36}");
		postJson("/v1/auth/login/verify", Map.of("challengeToken", ghost.get("challengeToken").asString(), "code", "123456"))
				.andExpect(status().isUnauthorized()).andExpect(jsonPath("$.code").value("invalid_code"));
	}

	@Test
	void anExpiredCodeIsRefusedAndAResendIssuesAFreshOneThatReplacesTheOld() throws Exception {
		String email = email();
		JsonNode started = startSignup(Map.of("ownerName", "A", "businessName", "B", "email", email));
		String token = started.get("signupToken").asString();
		String first = code(Channel.EMAIL, email);
		UUID tenant = UUID.fromString(token.split("\\.")[0]);
		inTenant(tenant, () -> jdbc.update("UPDATE otp_challenge SET expires_at = now() - interval '1 minute'"));
		verifySignup(token, "email", first).andExpect(status().isGone()).andExpect(jsonPath("$.code").value("code_expired"));

		postJson("/v1/auth/signup/resend", Map.of("signupToken", token, "channel", "email")).andExpect(status().isAccepted());
		String second = code(Channel.EMAIL, email);
		if (second.equals(first)) { // 1-in-a-million collision: ask again
			postJson("/v1/auth/signup/resend", Map.of("signupToken", token, "channel", "email")).andExpect(status().isAccepted());
			second = code(Channel.EMAIL, email);
		}
		verifySignup(token, "email", second).andExpect(status().isOk());
	}

	@Test
	void resendIsRateLimitedAndCodesPerContactAreCapped() throws Exception {
		String email = email();
		settings.setResendSeconds(3600);
		String token = startSignup(Map.of("ownerName", "A", "businessName", "B", "email", email)).get("signupToken").asString();
		postJson("/v1/auth/signup/resend", Map.of("signupToken", token, "channel", "email")).andExpect(status().isTooManyRequests())
				.andExpect(jsonPath("$.code").value("resend_too_soon"));

		settings.setResendSeconds(0);
		settings.setMaxPerHour(2);
		String other = email();
		startSignup(Map.of("ownerName", "A", "businessName", "B", "email", other));
		postJson("/v1/auth/signup/start", Map.of("ownerName", "A", "businessName", "B", "email", other)).andExpect(status().isAccepted());
		postJson("/v1/auth/signup/start", Map.of("ownerName", "A", "businessName", "B", "email", other)).andExpect(status().isTooManyRequests())
				.andExpect(jsonPath("$.code").value("too_many_requests"));
	}

	@Test
	void aContactBelongsToOneAccount() throws Exception {
		String email = email();
		signUpWithEmail(email);
		postJson("/v1/auth/signup/start", Map.of("ownerName", "A", "businessName", "B", "email", email)).andExpect(status().isConflict())
				.andExpect(jsonPath("$.code").value("contact_in_use"));
	}

	@Test
	void staffAddedByTheOwnerSignInWithTheirPhoneAndOnlyGetTheirRoles() throws Exception {
		String ownerEmail = email();
		JsonNode owner = signUpWithEmail(ownerEmail);
		String ownerSession = owner.get("session").get("token").asString();
		UUID staff = UUID.randomUUID();
		String phone = phone();
		mvc.perform(put("/v1/identity/users/" + staff).header("Authorization", "Bearer " + ownerSession).contentType(MediaType.APPLICATION_JSON)
				.content(json.writeValueAsString(Map.of("displayName", "Ravi", "phone", phone)))).andExpect(status().isOk());
		mvc.perform(put("/v1/identity/users/" + staff + "/roles").header("Authorization", "Bearer " + ownerSession).contentType(MediaType.APPLICATION_JSON)
				.content(json.writeValueAsString(Map.of("roles", java.util.List.of(Map.of("role", "cashier")), "reason", "joined")))).andExpect(status().isOk());
		// the number cannot be given to a second account
		postJson("/v1/auth/signup/start", Map.of("ownerName", "X", "businessName", "Y", "phone", phone)).andExpect(status().isConflict());

		JsonNode login = ok(postJson("/v1/auth/login/start", Map.of("channel", "phone", "contact", phone)).andExpect(status().isAccepted()));
		JsonNode session = ok(postJson("/v1/auth/login/verify", Map.of("challengeToken", login.get("challengeToken").asString(),
				"code", code(Channel.PHONE, phone))).andExpect(status().isOk()));
		assertThat(session.get("roles").get(0).asString()).isEqualTo("cashier");
		String staffToken = session.get("token").asString();
		mvc.perform(get("/v1/identity/users").header("Authorization", "Bearer " + staffToken)).andExpect(status().isForbidden());
		// a cashier cannot add devices or change roles either
		mvc.perform(put("/v1/identity/devices/" + UUID.randomUUID()).header("Authorization", "Bearer " + staffToken)
				.contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("storeId", owner.get("storeId").asString()))))
				.andExpect(status().isForbidden());
	}

	@Test
	void signingOutAndTamperingBothEndTheSession() throws Exception {
		JsonNode done = signUpWithEmail(email());
		String session = done.get("session").get("token").asString();
		String forged = session.substring(0, session.lastIndexOf('.') + 1) + "AAAA";
		mvc.perform(get("/v1/identity/me").header("Authorization", "Bearer " + forged)).andExpect(status().isUnauthorized())
				.andExpect(jsonPath("$.code").value("invalid_token"));
		mvc.perform(post("/v1/auth/logout").header("Authorization", "Bearer " + session)).andExpect(status().isNoContent());
		mvc.perform(get("/v1/identity/me").header("Authorization", "Bearer " + session)).andExpect(status().isUnauthorized())
				.andExpect(jsonPath("$.code").value("session_expired"));
		mvc.perform(post("/v1/auth/logout")).andExpect(status().isUnauthorized());
	}

	@Test
	void aDisabledUserCannotSignInOrKeepASession() throws Exception {
		String ownerEmail = email();
		JsonNode owner = signUpWithEmail(ownerEmail);
		String ownerSession = owner.get("session").get("token").asString();
		UUID staff = UUID.randomUUID();
		String staffEmail = email();
		mvc.perform(put("/v1/identity/users/" + staff).header("Authorization", "Bearer " + ownerSession).contentType(MediaType.APPLICATION_JSON)
				.content(json.writeValueAsString(Map.of("displayName", "Meena", "email", staffEmail)))).andExpect(status().isOk());
		JsonNode login = ok(postJson("/v1/auth/login/start", Map.of("channel", "email", "contact", staffEmail)).andExpect(status().isAccepted()));
		JsonNode session = ok(postJson("/v1/auth/login/verify", Map.of("challengeToken", login.get("challengeToken").asString(),
				"code", code(Channel.EMAIL, staffEmail))).andExpect(status().isOk()));
		mvc.perform(put("/v1/identity/users/" + staff).header("Authorization", "Bearer " + ownerSession).contentType(MediaType.APPLICATION_JSON)
				.content(json.writeValueAsString(Map.of("displayName", "Meena", "email", staffEmail, "status", "disabled")))).andExpect(status().isOk());
		mvc.perform(get("/v1/identity/me").header("Authorization", "Bearer " + session.get("token").asString())).andExpect(status().isUnauthorized());
		JsonNode again = ok(postJson("/v1/auth/login/start", Map.of("channel", "email", "contact", staffEmail)).andExpect(status().isAccepted()));
		postJson("/v1/auth/login/verify", Map.of("challengeToken", again.get("challengeToken").asString(), "code", "123456")).andExpect(status().isUnauthorized());
	}

	@Test
	void theLoginDirectoryIsUnreachableDirectlyByTheApiRole() {
		org.assertj.core.api.Assertions.assertThatThrownBy(() -> jdbc.queryForList("SELECT * FROM contact_directory"))
				.isInstanceOf(org.springframework.dao.DataAccessException.class);
		org.assertj.core.api.Assertions.assertThatThrownBy(() -> jdbc.queryForList("SELECT * FROM otp_throttle"))
				.isInstanceOf(org.springframework.dao.DataAccessException.class);
	}
}
