package com.ioxpert.tarazu.identity;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

import com.ioxpert.tarazu.tenancy.ApiException;
import com.ioxpert.tarazu.tenancy.TenantContext;
import com.ioxpert.tarazu.tenancy.TenantSession;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Staff users, role grants and PINs. Every change is audited with a reason. */
@Service
class UserService {

	record RoleGrant(String role, UUID businessId, UUID storeId) {
	}

	record UserView(UUID id, String displayName, String phone, String status, boolean pinSet, List<RoleGrant> roles) {
	}

	private final JdbcClient jdbc;
	private final TenantSession tenantSession;
	private final AccessPolicy access;
	private final AuditLog audit;
	private final PinHasher hasher;
	private final PinVerifier verifier;

	UserService(JdbcClient jdbc, TenantSession tenantSession, AccessPolicy access, AuditLog audit, PinHasher hasher,
			PinVerifier verifier) {
		this.jdbc = jdbc;
		this.tenantSession = tenantSession;
		this.access = access;
		this.audit = audit;
		this.hasher = hasher;
		this.verifier = verifier;
	}

	/** Owners are managed by owners: a manager must not reset an owner's PIN, disable them or rewrite their roles. */
	private void requireOwnerToTouchOwner(UUID target) {
		if (TenantContext.principal().hasRole("owner")) {
			return;
		}
		if (access.rolesOf(target).contains("owner")) {
			throw ApiException.forbidden("owner_only", "Only an owner can change an owner account");
		}
	}

	/** Serialises owner-count changes so two owners cannot disable each other at the same time. */
	private void lockOwners() {
		jdbc.sql("SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))) l")
				.param("k", TenantContext.require().value() + "/owners").query(Integer.class).single();
	}

	@Transactional
	UserView upsert(UUID id, String displayName, String phone, String status) {
		tenantSession.bindCurrentTenant();
		access.require(Permission.USER_MANAGE);
		var tenant = TenantContext.require().value();
		requireOwnerToTouchOwner(id);
		lockOwners();
		long ownersBefore = activeOwners();
		try {
			jdbc.sql("""
					INSERT INTO app_user (id, tenant_id, display_name, phone, status)
					VALUES (:id, :tenant, :name, :phone, :status)
					ON CONFLICT (tenant_id, id) DO UPDATE SET display_name = EXCLUDED.display_name, phone = EXCLUDED.phone,
					                               status = EXCLUDED.status
					""").param("id", id).param("tenant", tenant).param("name", displayName).param("phone", phone)
					.param("status", status).update();
		}
		catch (DataIntegrityViolationException ex) {
			throw ApiException.conflict("id_conflict", "User id is not available");
		}
		if ("disabled".equals(status)) {
			requireOwnerRemains(ownersBefore);
		}
		audit.record(AuditLog.Entry.of("user.upserted", "app_user", id, null).withDetails(Map.of("status", status)));
		return view(id);
	}

	@Transactional
	UserView replaceRoles(UUID userId, List<RoleGrant> grants, String reason) {
		tenantSession.bindCurrentTenant();
		access.require(Permission.USER_MANAGE);
		var principal = TenantContext.principal();
		requireExists(userId);
		requireOwnerToTouchOwner(userId);
		lockOwners();
		Set<String> before = rolesOfAnyScope(userId);
		Set<String> after = grants.stream().map(RoleGrant::role).collect(Collectors.toSet());
		boolean touchesOwner = before.contains("owner") != after.contains("owner");
		if (touchesOwner && !principal.hasRole("owner")) {
			throw ApiException.forbidden("owner_only", "Only an owner can grant or remove the owner role");
		}
		long ownersBefore = activeOwners();
		jdbc.sql("DELETE FROM user_role WHERE user_id = :id").param("id", userId).update();
		for (RoleGrant grant : grants) {
			try {
				jdbc.sql("""
						INSERT INTO user_role (tenant_id, user_id, role, business_id, store_id)
						VALUES (:tenant, :user, :role, :business, :store) ON CONFLICT DO NOTHING
						""").param("tenant", principal.tenant().value()).param("user", userId)
						.param("role", grant.role()).param("business", grant.businessId()).param("store", grant.storeId())
						.update();
			}
			catch (DataIntegrityViolationException ex) {
				throw ApiException.unprocessable("unknown_scope", "Role scope (business/store) does not exist");
			}
		}
		requireOwnerRemains(ownersBefore);
		audit.record(AuditLog.Entry.of("user.roles_changed", "app_user", userId, reason)
				.withDetails(Map.of("before", before.stream().sorted().toList(), "after", after.stream().sorted().toList())));
		return view(userId);
	}

	@Transactional
	void setPin(UUID userId, String pin, String reason) {
		tenantSession.bindCurrentTenant();
		access.require(Permission.USER_MANAGE);
		requireExists(userId);
		requireOwnerToTouchOwner(userId);
		var hashed = hasher.hash(pin);
		jdbc.sql("""
				UPDATE app_user SET pin_salt = :salt, pin_hash = :hash, pin_iterations = :iter, pin_set_at = now(),
				       pin_failed_count = 0, pin_locked_until = NULL
				WHERE id = :id
				""").param("salt", hashed.salt()).param("hash", hashed.hash()).param("iter", hashed.iterations())
				.param("id", userId).update();
		audit.record(AuditLog.Entry.of("user.pin_set", "app_user", userId, reason));
	}

	/** Verification is its own transaction (failed attempts must persist), so no @Transactional here. */
	PinVerifier.Status verifyPin(UUID userId, String pin) {
		return verifier.verify(TenantContext.require(), userId, pin);
	}

	@Transactional(readOnly = true)
	Set<String> rolesFor(UUID userId) {
		tenantSession.bindCurrentTenant();
		return access.rolesOf(userId);
	}

	@Transactional(readOnly = true)
	UserView get(UUID id) {
		tenantSession.bindCurrentTenant();
		access.require(Permission.USER_MANAGE);
		requireExists(id);
		return view(id);
	}

	@Transactional(readOnly = true)
	List<UserView> list() {
		tenantSession.bindCurrentTenant();
		access.require(Permission.USER_MANAGE);
		return jdbc.sql("SELECT id FROM app_user ORDER BY created_at").query(UUID.class).list().stream()
				.map(this::view).toList();
	}

	private UserView view(UUID id) {
		var roles = jdbc.sql("SELECT role, business_id, store_id FROM user_role WHERE user_id = :id ORDER BY role")
				.param("id", id).query((rs, n) -> new RoleGrant(rs.getString("role"),
						rs.getObject("business_id", UUID.class), rs.getObject("store_id", UUID.class)))
				.list();
		return jdbc.sql("SELECT display_name, phone, status, pin_hash IS NOT NULL AS pin_set FROM app_user WHERE id = :id")
				.param("id", id).query((rs, n) -> new UserView(id, rs.getString("display_name"), rs.getString("phone"),
						rs.getString("status"), rs.getBoolean("pin_set"), roles))
				.single();
	}

	private void requireExists(UUID id) {
		if (jdbc.sql("SELECT count(*) FROM app_user WHERE id = :id").param("id", id).query(Long.class).single() == 0) {
			throw ApiException.notFound("user_not_found", "No such user");
		}
	}

	private Set<String> rolesOfAnyScope(UUID id) {
		return jdbc.sql("SELECT DISTINCT role FROM user_role WHERE user_id = :id").param("id", id)
				.query(String.class).set();
	}

	/** A tenant must always keep at least one active owner, or nobody can approve voids and discounts. */
	private void requireOwnerRemains(long ownersBefore) {
		if (ownersBefore > 0 && activeOwners() == 0) {
			throw ApiException.conflict("last_owner", "The tenant must keep at least one active owner");
		}
	}

	private long activeOwners() {
		return jdbc.sql("""
				SELECT count(DISTINCT u.id) FROM app_user u JOIN user_role r ON r.tenant_id = u.tenant_id AND r.user_id = u.id
				WHERE r.role = 'owner' AND u.status = 'active'
				""").query(Long.class).single();
	}
}
