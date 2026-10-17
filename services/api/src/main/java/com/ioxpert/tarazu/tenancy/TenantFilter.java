package com.ioxpert.tarazu.tenancy;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Optional;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Authenticates /v1/** requests through the registered {@link RequestAuthenticator}s. The first one
 * that recognises a credential wins. With no recognised credential the answer is 401, so a deploy
 * that forgets auth fails closed.
 */
@Component
class TenantFilter extends OncePerRequestFilter {

	private final List<RequestAuthenticator> authenticators;

	TenantFilter(List<RequestAuthenticator> authenticators) {
		this.authenticators = authenticators;
	}

	/** Largest request body accepted on /v1/** (a full 500-operation batch is well under 1 MB). */
	static final long MAX_BODY_BYTES = 8L * 1024 * 1024;

	@Override
	protected boolean shouldNotFilter(HttpServletRequest request) {
		// fail closed: everything is authenticated except the health/info probes. (Matching "/v1/" on the raw URI
		// let encoded or ;parameterised paths such as /%76%31/... or /v1;x=y/... slip past.)
		String uri = request.getRequestURI();
		return uri.equals("/actuator/health") || uri.startsWith("/actuator/health/") || uri.equals("/actuator/info");
	}

	@Override
	protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
			throws ServletException, IOException {
		if (request.getContentLengthLong() > MAX_BODY_BYTES) {
			response.setStatus(413);
			response.setContentType("application/problem+json");
			response.getOutputStream().write(("{\"title\":\"Payload Too Large\",\"status\":413,\"code\":\"payload_too_large\","
					+ "\"detail\":\"Request body is limited to 8 MiB; upload fewer operations per request\"}")
					.getBytes(StandardCharsets.UTF_8));
			return;
		}
		Principal principal;
		try {
			principal = resolve(request).orElse(null);
		}
		catch (ApiException ex) {
			unauthorized(response, ex.code(), ex.getMessage());
			return;
		}
		if (principal == null) {
			unauthorized(response, "authentication_required", "Authentication required");
			return;
		}
		TenantContext.set(principal);
		try {
			chain.doFilter(request, response);
		}
		finally {
			TenantContext.clear();
		}
	}

	private Optional<Principal> resolve(HttpServletRequest request) {
		for (RequestAuthenticator authenticator : authenticators) {
			Optional<Principal> principal = authenticator.authenticate(request);
			if (principal.isPresent()) {
				return principal;
			}
		}
		return Optional.empty();
	}

	private static void unauthorized(HttpServletResponse response, String code, String detail) throws IOException {
		response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
		response.setContentType("application/problem+json");
		String body = "{\"title\":\"Unauthorized\",\"status\":401,\"code\":\"%s\",\"detail\":\"%s\"}"
				.formatted(code, detail.replace("\"", "'"));
		response.getOutputStream().write(body.getBytes(StandardCharsets.UTF_8));
	}
}
