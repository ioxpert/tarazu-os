package com.ioxpert.tarazu.tenancy;

import java.util.Set;
import java.util.UUID;

/**
 * The authenticated caller. {@code deviceId}/{@code storeId} are set when the request carried a device
 * credential; {@code userId}/{@code roles} when a staff member was identified (PIN or dev header).
 * Roles are the lower-case role names (see identity.Role); tenancy does not depend on identity.
 */
public record Principal(TenantId tenant, UUID deviceId, UUID storeId, UUID userId, Set<String> roles) {

	public Principal {
		roles = Set.copyOf(roles);
	}

	public static Principal ofTenant(TenantId tenant) {
		return new Principal(tenant, null, null, null, Set.of());
	}

	public boolean hasRole(String role) {
		return roles.contains(role);
	}
}
