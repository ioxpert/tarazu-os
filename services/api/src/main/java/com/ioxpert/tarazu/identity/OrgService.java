package com.ioxpert.tarazu.identity;

import java.util.Map;
import java.util.UUID;

import com.ioxpert.tarazu.tenancy.ApiException;
import com.ioxpert.tarazu.tenancy.TenantContext;
import com.ioxpert.tarazu.tenancy.TenantSession;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** The tenant hierarchy below the tenant: business and store. */
@Service
class OrgService {

	record BusinessView(UUID id, String name, String gstMode, String gstin, String stateCode) {
	}

	record StoreView(UUID id, UUID businessId, String name) {
	}

	private final JdbcClient jdbc;
	private final TenantSession tenantSession;
	private final AccessPolicy access;
	private final AuditLog audit;

	OrgService(JdbcClient jdbc, TenantSession tenantSession, AccessPolicy access, AuditLog audit) {
		this.jdbc = jdbc;
		this.tenantSession = tenantSession;
		this.access = access;
		this.audit = audit;
	}

	@Transactional
	BusinessView upsertBusiness(UUID id, String name, String gstMode, String gstin, String stateCode) {
		tenantSession.bindCurrentTenant();
		access.require(Permission.SETTINGS_MANAGE);
		var tenant = TenantContext.require().value();
		String before = jdbc.sql("SELECT gst_mode FROM business WHERE id = :id").param("id", id)
				.query(String.class).optional().orElse(null);
		try {
			jdbc.sql("""
					INSERT INTO business (id, tenant_id, name, gst_mode, gstin, state_code)
					VALUES (:id, :tenant, :name, :mode, :gstin, :state)
					ON CONFLICT (tenant_id, id) DO UPDATE SET name = EXCLUDED.name, gst_mode = EXCLUDED.gst_mode,
					       gstin = EXCLUDED.gstin, state_code = EXCLUDED.state_code
					""").param("id", id).param("tenant", tenant).param("name", name).param("mode", gstMode)
					.param("gstin", gstin).param("state", stateCode).update();
		}
		catch (DataIntegrityViolationException ex) {
			throw ApiException.conflict("id_conflict", "Business id is not available");
		}
		if (before == null || !before.equals(gstMode)) {
			audit.record(AuditLog.Entry.of("business.gst_mode_set", "business", id, null)
					.withDetails(Map.of("from", String.valueOf(before), "to", gstMode)));
		}
		return new BusinessView(id, name, gstMode, gstin, stateCode);
	}

	@Transactional
	StoreView upsertStore(UUID id, UUID businessId, String name) {
		tenantSession.bindCurrentTenant();
		access.require(Permission.SETTINGS_MANAGE);
		var tenant = TenantContext.require().value();
		int written;
		try {
			written = jdbc.sql("""
					INSERT INTO store (id, tenant_id, business_id, name) VALUES (:id, :tenant, :business, :name)
					ON CONFLICT (tenant_id, id) DO UPDATE SET name = EXCLUDED.name
					WHERE store.business_id = EXCLUDED.business_id
					""").param("id", id).param("tenant", tenant).param("business", businessId).param("name", name)
					.update();
		}
		catch (DataIntegrityViolationException ex) {
			throw ApiException.unprocessable("unknown_business", "Business does not exist for this tenant");
		}
		if (written == 0) {
			throw ApiException.conflict("store_business_immutable", "A store cannot move to another business");
		}
		return new StoreView(id, businessId, name);
	}
}
