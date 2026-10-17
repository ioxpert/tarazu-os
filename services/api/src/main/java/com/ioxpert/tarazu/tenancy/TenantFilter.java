package com.ioxpert.tarazu.tenancy;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Resolves the tenant for /v1/** requests.
 *
 * <p>Real authentication (OTP login, device-bound JWT) is a later PR. Until then the ONLY way to
 * get a tenant is the dev-only X-Tenant-Id header, and only when
 * {@code tarazu.auth.dev-header-enabled=true}. With the default config every /v1/** call is 401,
 * so a deploy that forgets auth fails closed.
 */
@Component
class TenantFilter extends OncePerRequestFilter {

	static final String DEV_HEADER = "X-Tenant-Id";

	private final boolean devHeaderEnabled;

	TenantFilter(@Value("${tarazu.auth.dev-header-enabled:false}") boolean devHeaderEnabled) {
		this.devHeaderEnabled = devHeaderEnabled;
	}

	@Override
	protected boolean shouldNotFilter(HttpServletRequest request) {
		return !request.getRequestURI().startsWith("/v1/");
	}

	@Override
	protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
			throws ServletException, IOException {
		TenantId tenant = devHeaderEnabled ? parse(request.getHeader(DEV_HEADER)) : null;
		if (tenant == null) {
			response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
			response.setContentType("application/problem+json");
			response.getOutputStream().write(
					"{\"title\":\"Unauthorized\",\"status\":401,\"detail\":\"Authentication required\"}"
							.getBytes(StandardCharsets.UTF_8));
			return;
		}
		TenantContext.set(tenant);
		try {
			chain.doFilter(request, response);
		}
		finally {
			TenantContext.clear();
		}
	}

	private static TenantId parse(String header) {
		if (header == null) {
			return null;
		}
		try {
			return new TenantId(UUID.fromString(header.trim()));
		}
		catch (IllegalArgumentException ex) {
			return null;
		}
	}
}
