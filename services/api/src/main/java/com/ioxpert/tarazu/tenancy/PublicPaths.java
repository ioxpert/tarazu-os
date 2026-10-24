package com.ioxpert.tarazu.tenancy;

import java.util.List;

/**
 * The only /v1 paths reachable without a credential: the OTP onboarding and login handshake (ADR 0007) and the one-time
 * device pairing redemption (ADR 0015). Each carries its own opaque, single-purpose token or code and rate limits. Exact matches only, so encoded, trailing-slash or
 * ;parameterised variants do not match and stay authenticated. Adding a path here needs an ADR.
 */
public final class PublicPaths {

	public static final List<String> ALL = List.of("/v1/auth/otp/config", "/v1/auth/signup/start", "/v1/auth/signup/verify",
			"/v1/auth/signup/resend", "/v1/auth/login/start", "/v1/auth/login/verify",
			"/v1/pairing/redeem");

	private PublicPaths() {
	}
}
