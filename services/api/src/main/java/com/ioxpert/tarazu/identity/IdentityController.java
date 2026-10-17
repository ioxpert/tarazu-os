package com.ioxpert.tarazu.identity;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import com.ioxpert.tarazu.tenancy.ApiException;
import com.ioxpert.tarazu.tenancy.Principal;
import com.ioxpert.tarazu.tenancy.TenantContext;
import com.ioxpert.tarazu.tenancy.TenantSession;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.json.JsonMapper;

@RestController
@RequestMapping("/v1/identity")
class IdentityController {

	record MeResponse(UUID tenantId, UUID deviceId, UUID storeId, UUID userId, Set<String> roles, String storeName,
			OrgService.BusinessView business) {
	}

	/** Owner PIN verifier; salt and hash are standard base64 (docs/adr/0008). */
	record Approver(UUID userId, String displayName, String pinSalt, String pinHash, int iterations) {
	}

	record BusinessRequest(@NotBlank @Size(max = 200) String name,
			@NotNull @Pattern(regexp = "regular|composition|non_gst") String gstMode,
			@Pattern(regexp = "[0-9A-Z]{15}") String gstin, @Pattern(regexp = "[0-9]{2}") String stateCode,
			@Pattern(regexp = "[A-Za-z0-9._-]{2,256}@[A-Za-z]{2,64}") String upiVpa) {
	}

	record StoreRequest(@NotNull UUID businessId, @NotBlank @Size(max = 200) String name) {
	}

	record DeviceRequest(@NotNull UUID storeId, @Size(max = 100) String label) {
	}

	record DeviceRegistered(UUID id, UUID storeId, String label, String token) {
	}

	record RevokeRequest(@NotBlank @Size(max = 500) String reason) {
	}

	record UserRequest(@NotBlank @Size(max = 200) String displayName, @Size(max = 20) String phone, @Size(max = 254) String email,
			@Pattern(regexp = "active|disabled") String status) {
	}

	record RoleGrantRequest(@NotBlank @Pattern(regexp = "owner|manager|cashier|purchaser|accountant|sales_rep|delivery_agent") String role,
			UUID businessId, UUID storeId) {
	}

	record RolesRequest(@NotNull List<@Valid RoleGrantRequest> roles, @NotBlank @Size(max = 500) String reason) {
	}

	record PinRequest(@NotNull @Pattern(regexp = "[0-9]{4,8}") String pin, @NotBlank @Size(max = 500) String reason) {
	}

	record PinVerifyRequest(@NotNull String pin) {
	}

	record PinVerifyResponse(boolean valid, Set<String> roles) {
	}

	record AuditItem(UUID id, Instant occurredAt, UUID actorUserId, UUID actorDeviceId, String action,
			String entityType, UUID entityId, String reason, Map<String, Object> details) {
	}

	private final DeviceService devices;
	private final UserService users;
	private final OrgService org;
	private final AccessPolicy access;
	private final JdbcClient jdbc;
	private final TenantSession tenantSession;
	private final JsonMapper json;

	IdentityController(DeviceService devices, UserService users, OrgService org, AccessPolicy access,
			JdbcClient jdbc, TenantSession tenantSession, JsonMapper json) {
		this.devices = devices;
		this.users = users;
		this.org = org;
		this.access = access;
		this.jdbc = jdbc;
		this.tenantSession = tenantSession;
		this.json = json;
	}

	@GetMapping("/me")
	@Transactional(readOnly = true)
	MeResponse me() {
		Principal p = TenantContext.principal();
		OrgService.StoreContext store = null;
		if (p.storeId() != null) {
			tenantSession.bindCurrentTenant();
			store = org.storeContext(p.storeId()).orElse(null);
		}
		return new MeResponse(p.tenant().value(), p.deviceId(), p.storeId(), p.userId(), p.roles(),
				store == null ? null : store.storeName(), store == null ? null : store.business());
	}

	/**
	 * Owner PIN verifiers for offline approval (ADR 0008). Needs a DEVICE credential: a tenant-level or browser
	 * request never receives them. Active owners (for this store) that have a PIN set; disabled users excluded.
	 */
	@GetMapping("/approvers")
	@Transactional(readOnly = true)
	List<Approver> approvers() {
		Principal p = TenantContext.principal();
		if (p.deviceId() == null || p.storeId() == null) {
			throw ApiException.forbidden("device_credential_required", "Owner PIN verifiers are only served to a registered device");
		}
		tenantSession.bindCurrentTenant();
		var encoder = java.util.Base64.getEncoder();
		return jdbc.sql("""
				SELECT u.id, u.display_name, u.pin_salt, u.pin_hash, u.pin_iterations
				FROM app_user u
				WHERE u.status = 'active' AND u.pin_hash IS NOT NULL AND u.pin_salt IS NOT NULL AND u.pin_iterations IS NOT NULL
				  AND EXISTS (SELECT 1 FROM user_role r
				              WHERE r.tenant_id = u.tenant_id AND r.user_id = u.id AND r.role = 'owner'
				                AND (r.store_id IS NULL OR r.store_id = :store)
				                AND (r.business_id IS NULL
				                     OR r.business_id = (SELECT s.business_id FROM store s WHERE s.id = :store)))
				ORDER BY u.display_name, u.id
				""").param("store", p.storeId())
				.query((rs, n) -> new Approver(rs.getObject("id", UUID.class), rs.getString("display_name"),
						encoder.encodeToString(rs.getBytes("pin_salt")), encoder.encodeToString(rs.getBytes("pin_hash")),
						rs.getInt("pin_iterations")))
				.list();
	}

	@PutMapping("/businesses/{id}")
	OrgService.BusinessView putBusiness(@PathVariable UUID id, @Valid @RequestBody BusinessRequest body) {
		return org.upsertBusiness(id, body.name(), body.gstMode(), body.gstin(), body.stateCode(), body.upiVpa());
	}

	@GetMapping("/stores")
	List<OrgService.StoreView> listStores() {
		return org.listStores();
	}

	@PutMapping("/stores/{id}")
	OrgService.StoreView putStore(@PathVariable UUID id, @Valid @RequestBody StoreRequest body) {
		return org.upsertStore(id, body.businessId(), body.name());
	}

	@PutMapping("/devices/{id}")
	ResponseEntity<DeviceRegistered> registerDevice(@PathVariable UUID id, @Valid @RequestBody DeviceRequest body) {
		var reg = devices.register(id, body.storeId(), body.label());
		return ResponseEntity.status(reg.created() ? HttpStatus.CREATED : HttpStatus.OK)
				.body(new DeviceRegistered(reg.id(), reg.storeId(), reg.label(), reg.token()));
	}

	@PostMapping("/devices/{id}/revoke")
	ResponseEntity<Void> revokeDevice(@PathVariable UUID id, @Valid @RequestBody RevokeRequest body) {
		devices.revoke(id, body.reason());
		return ResponseEntity.noContent().build();
	}

	@GetMapping("/devices")
	List<DeviceService.DeviceView> listDevices() {
		return devices.list();
	}

	@PutMapping("/users/{id}")
	UserService.UserView putUser(@PathVariable UUID id, @Valid @RequestBody UserRequest body) {
		return users.upsert(id, body.displayName(), body.phone(), body.email(), body.status() == null ? "active" : body.status());
	}

	@GetMapping("/users")
	List<UserService.UserView> listUsers() {
		return users.list();
	}

	@GetMapping("/users/{id}")
	UserService.UserView getUser(@PathVariable UUID id) {
		return users.get(id);
	}

	@PutMapping("/users/{id}/roles")
	UserService.UserView putRoles(@PathVariable UUID id, @Valid @RequestBody RolesRequest body) {
		return users.replaceRoles(id, body.roles().stream()
				.map(r -> new UserService.RoleGrant(r.role(), r.businessId(), r.storeId())).toList(), body.reason());
	}

	@PutMapping("/users/{id}/pin")
	ResponseEntity<Void> putPin(@PathVariable UUID id, @Valid @RequestBody PinRequest body) {
		users.setPin(id, body.pin(), body.reason());
		return ResponseEntity.noContent().build();
	}

	/** Always 200 with {valid}; wrong attempts are counted and lock the PIN after five misses. */
	@PostMapping("/users/{id}/pin/verify")
	PinVerifyResponse verifyPin(@PathVariable UUID id, @Valid @RequestBody PinVerifyRequest body) {
		var status = users.verifyPin(id, body.pin());
		return switch (status) {
			case OK -> new PinVerifyResponse(true, rolesOf(id));
			case LOCKED -> throw new ApiException(HttpStatus.LOCKED, "pin_locked", "Too many wrong PINs; try again later");
			case NO_PIN -> throw ApiException.conflict("pin_not_set", "No PIN is set for this staff member");
			case UNKNOWN_USER -> throw ApiException.notFound("user_not_found", "No such user");
			case INVALID -> new PinVerifyResponse(false, Set.of());
		};
	}

	@GetMapping("/audit-log")
	@Transactional(readOnly = true)
	List<AuditItem> auditLog(@RequestParam(required = false) String entityType,
			@RequestParam(required = false) UUID entityId, @RequestParam(required = false) String action,
			@RequestParam(required = false) Instant before, @RequestParam(defaultValue = "50") int limit) {
		tenantSession.bindCurrentTenant();
		access.require(Permission.AUDIT_READ);
		int capped = Math.max(1, Math.min(limit, 200));
		return jdbc.sql("""
				SELECT id, occurred_at, actor_user_id, actor_device_id, action, entity_type, entity_id, reason, details::text AS details
				FROM audit_log
				WHERE (CAST(:entityType AS text) IS NULL OR entity_type = :entityType)
				  AND (CAST(:entityId AS uuid) IS NULL OR entity_id = :entityId)
				  AND (CAST(:action AS text) IS NULL OR action = :action)
				  AND (CAST(:before AS timestamptz) IS NULL OR occurred_at < :before)
				ORDER BY occurred_at DESC, id DESC LIMIT :limit
				""").param("entityType", entityType).param("entityId", entityId).param("action", action)
				.param("before", before == null ? null : java.sql.Timestamp.from(before)).param("limit", capped)
				.query((rs, n) -> new AuditItem(rs.getObject("id", UUID.class), rs.getTimestamp("occurred_at").toInstant(),
						rs.getObject("actor_user_id", UUID.class), rs.getObject("actor_device_id", UUID.class),
						rs.getString("action"), rs.getString("entity_type"), rs.getObject("entity_id", UUID.class),
						rs.getString("reason"), readMap(rs.getString("details"))))
				.list();
	}

	@SuppressWarnings("unchecked")
	private Map<String, Object> readMap(String raw) {
		return json.readValue(raw, Map.class);
	}

	private Set<String> rolesOf(UUID userId) {
		return users.rolesFor(userId);
	}
}
