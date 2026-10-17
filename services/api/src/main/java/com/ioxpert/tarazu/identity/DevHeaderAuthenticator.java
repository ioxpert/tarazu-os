package com.ioxpert.tarazu.identity;

import java.util.Optional;
import java.util.Set;
import java.util.UUID;

import com.ioxpert.tarazu.tenancy.ApiException;
import com.ioxpert.tarazu.tenancy.DevHeaderProperties;
import com.ioxpert.tarazu.tenancy.Principal;
import com.ioxpert.tarazu.tenancy.RequestAuthenticator;
import com.ioxpert.tarazu.tenancy.TenantId;
import com.ioxpert.tarazu.tenancy.TenantSession;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * DEV/TEST ONLY: {@code X-Tenant-Id} (and optionally {@code X-Staff-Id}, trusted without a PIN) become a
 * principal. The bean does not exist unless {@code tarazu.auth.dev-header-enabled=true}; never enable it
 * in production.
 */
@Component
@Order(Ordered.LOWEST_PRECEDENCE)
@ConditionalOnProperty(name = DevHeaderProperties.ENABLED, havingValue = "true")
class DevHeaderAuthenticator implements RequestAuthenticator {

	private final AccessPolicy access;
	private final TenantSession tenantSession;
	private final TransactionTemplate tx;

	DevHeaderAuthenticator(AccessPolicy access, TenantSession tenantSession, PlatformTransactionManager tm) {
		this.access = access;
		this.tenantSession = tenantSession;
		this.tx = new TransactionTemplate(tm);
	}

	@Override
	public Optional<Principal> authenticate(HttpServletRequest request) {
		UUID tenantId = parse(request.getHeader(DevHeaderProperties.TENANT_HEADER));
		if (tenantId == null) {
			return Optional.empty();
		}
		TenantId tenant = new TenantId(tenantId);
		UUID staff = parse(request.getHeader(DevHeaderProperties.STAFF_HEADER));
		if (staff == null) {
			return Optional.of(Principal.ofTenant(tenant));
		}
		Set<String> roles = tx.execute(status -> {
			tenantSession.bind(tenant);
			return access.rolesOf(staff);
		});
		if (roles == null || roles.isEmpty()) {
			throw ApiException.unauthorized("unknown_staff", "Unknown or disabled staff member");
		}
		return Optional.of(new Principal(tenant, null, null, staff, roles));
	}

	private static UUID parse(String header) {
		if (header == null) {
			return null;
		}
		try {
			return UUID.fromString(header.trim());
		}
		catch (IllegalArgumentException ex) {
			return null;
		}
	}
}
