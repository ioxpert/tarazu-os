package com.ioxpert.tarazu.identity;

import java.util.Collection;
import java.util.EnumSet;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

import com.ioxpert.tarazu.tenancy.ApiException;
import com.ioxpert.tarazu.tenancy.Principal;
import com.ioxpert.tarazu.tenancy.TenantContext;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/**
 * Role to permission decisions. Call inside a tenant-bound transaction (it reads user_role under RLS).
 */
@Component
public class AccessPolicy {

	private final JdbcClient jdbc;

	AccessPolicy(JdbcClient jdbc) {
		this.jdbc = jdbc;
	}

	public static boolean permits(Collection<String> roles, Permission permission) {
		return roles.stream().map(Role::fromWire).flatMap(java.util.Optional::stream)
				.anyMatch(r -> RolePermissions.of(r).contains(permission));
	}

	public static boolean permitsAny(Collection<String> roles, Set<Permission> anyOf) {
		return anyOf.stream().anyMatch(p -> permits(roles, p));
	}

	/** Controller guard: the acting staff member (not just the device) must hold the permission. */
	public void require(Permission permission) {
		Principal principal = TenantContext.principal();
		if (principal.userId() == null) {
			throw ApiException.forbidden("staff_identification_required",
					"Identify the acting staff member (X-Staff-Id and X-Staff-Pin) for this action");
		}
		if (!permits(principal.roles(), permission)) {
			throw ApiException.forbidden("permission_denied", "Role not permitted: " + permission);
		}
	}

	/** Active roles a user holds for a store (tenant-wide roles plus roles scoped to that store or its business). */
	public Set<String> rolesOf(UUID userId, UUID storeId) {
		List<String> roles = jdbc.sql("""
				SELECT r.role FROM user_role r
				JOIN app_user u ON u.tenant_id = r.tenant_id AND u.id = r.user_id
				WHERE u.id = :user AND u.status = 'active'
				  AND (r.store_id IS NULL OR r.store_id = :store)
				  AND (r.business_id IS NULL
				       OR r.business_id = (SELECT s.business_id FROM store s WHERE s.id = :store))
				""").param("user", userId).param("store", storeId).query(String.class).list();
		return new HashSet<>(roles);
	}

	/** Roles for a user regardless of scope. Empty set for unknown or disabled users. */
	public Set<String> rolesOf(UUID userId) {
		return new HashSet<>(jdbc.sql("""
				SELECT r.role FROM user_role r
				JOIN app_user u ON u.tenant_id = r.tenant_id AND u.id = r.user_id
				WHERE u.id = :user AND u.status = 'active'
				""").param("user", userId).query(String.class).list());
	}

	/** True when the user is an active owner: the only role whose PIN can approve voids, discounts and backdating. */
	public boolean isActiveOwner(UUID userId) {
		return userId != null && rolesOf(userId).contains(Role.OWNER.wire());
	}

	public static Set<Permission> none() {
		return EnumSet.noneOf(Permission.class);
	}
}
