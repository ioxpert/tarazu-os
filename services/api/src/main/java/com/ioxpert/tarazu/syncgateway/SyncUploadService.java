package com.ioxpert.tarazu.syncgateway;

import com.ioxpert.tarazu.tenancy.TenantContext;
import com.ioxpert.tarazu.tenancy.TenantSession;
import tools.jackson.databind.json.JsonMapper;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Receives batches from a device's PowerSync upload queue. Idempotent: replaying a batch is safe.
 * The whole batch is one transaction, so a rejected row rolls the batch back and the client
 * retries it unchanged.
 */
@Service
class SyncUploadService {

	private static final String INSERT = """
			INSERT INTO operation_log (operation_id, tenant_id, store_id, device_id, local_seq, hlc,
			                           idempotency_key, entity_type, entity_id, op_type, schema_version, payload)
			VALUES (:operationId, :tenantId, :storeId, :deviceId, :localSeq, :hlc,
			        :idempotencyKey, :entityType, :entityId, :opType, :schemaVersion, CAST(:payload AS jsonb))
			ON CONFLICT DO NOTHING
			""";

	private final JdbcClient jdbc;
	private final TenantSession tenantSession;
	private final JsonMapper json;

	SyncUploadService(JdbcClient jdbc, TenantSession tenantSession, JsonMapper json) {
		this.jdbc = jdbc;
		this.tenantSession = tenantSession;
		this.json = json;
	}

	@Transactional
	UploadResponse upload(UploadRequest request) {
		tenantSession.bindCurrentTenant();
		var tenantId = TenantContext.require().value();
		int accepted = 0;
		int duplicates = 0;
		for (OperationDto op : request.operations()) {
			int inserted = jdbc.sql(INSERT)
					.param("operationId", op.operationId())
					.param("tenantId", tenantId)
					.param("storeId", op.storeId())
					.param("deviceId", op.deviceId())
					.param("localSeq", op.localSeq())
					.param("hlc", op.hlc())
					.param("idempotencyKey", op.idempotencyKey())
					.param("entityType", op.entityType())
					.param("entityId", op.entityId())
					.param("opType", op.opType())
					.param("schemaVersion", op.schemaVersion())
					.param("payload", json.writeValueAsString(op.payload()))
					.update();
			if (inserted == 1) {
				accepted++;
			}
			else {
				duplicates++;
			}
		}
		return new UploadResponse(accepted, duplicates);
	}
}
