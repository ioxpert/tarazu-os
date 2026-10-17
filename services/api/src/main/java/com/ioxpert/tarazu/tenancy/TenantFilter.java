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

	@Override
	protected boolean shouldNotFilter(HttpServletRequest request) {
		return !request.getRequestURI().startsWith("/v1/");
	}

	@Override
	protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
			throws ServletException, IOException {
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
