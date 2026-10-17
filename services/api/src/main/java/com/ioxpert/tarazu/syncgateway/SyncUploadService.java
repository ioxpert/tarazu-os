package com.ioxpert.tarazu.syncgateway;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

import com.ioxpert.tarazu.consent.TenantSettings;
import com.ioxpert.tarazu.identity.DeviceDirectory;
import com.ioxpert.tarazu.syncgateway.UploadResponse.OperationResult;
import com.ioxpert.tarazu.tenancy.ApiException;
import com.ioxpert.tarazu.tenancy.Principal;
import com.ioxpert.tarazu.tenancy.TenantContext;
import com.ioxpert.tarazu.tenancy.TenantSession;
import com.ioxpert.tarazu.tenancy.UuidV7;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.json.JsonMapper;

/**
 * One upload batch = one transaction. Whole-request problems (unknown store/device, revoked device, local-only
 * tenant, malformed ids) fail the request before anything is stored. Per-operation problems never do: they
 * are acknowledged as rejected/deferred/flagged and the batch carries on.
 */
@Service
class SyncUploadService {

	private final TenantSession tenantSession;
	private final DeviceDirectory devices;
	private final TenantSettings settings;
	private final OperationProcessor processor;
	private final JsonMapper json;

	SyncUploadService(TenantSession tenantSession, DeviceDirectory devices, TenantSettings settings,
			OperationProcessor processor, JsonMapper json) {
		this.tenantSession = tenantSession;
		this.devices = devices;
		this.settings = settings;
		this.processor = processor;
		this.json = json;
	}

	@Transactional
	UploadResponse upload(UploadRequest request) {
		tenantSession.bindCurrentTenant();
		Principal principal = TenantContext.principal();
		UUID tenantId = principal.tenant().value();

		if (settings.isLocalOnly()) {
			throw ApiException.forbidden("local_only_mode", "This merchant is in local-only mode; sync is disabled");
		}
		validateBatch(request, principal);

		List<OperationResult> results = new ArrayList<>(request.operations().size());
		OperationProcessor.Batch batch = new OperationProcessor.Batch();
		for (OperationDto dto : request.operations()) {
			Operation op = new Operation(dto.operationId(), tenantId, dto.storeId(), dto.deviceId(), dto.actorUserId(),
					dto.localSeq(), Hlc.parse(dto.hlc()), dto.idempotencyKey(), dto.entityType(), dto.entityId(),
					dto.opType(), dto.schemaVersion(), new Payload(json.valueToTree(dto.payload())));
			results.add(processor.process(op, json.writeValueAsString(dto.payload()), batch));
		}
		processor.drainDeferred(batch);
		// a deferred op may have been applied by the drain: report the status as of the end of the batch
		results = refreshStatuses(results);

		request.operations().stream().map(OperationDto::deviceId).distinct().forEach(devices::markSeen);
		return summarise(results);
	}

	private void validateBatch(UploadRequest request, Principal principal) {
		Set<UUID> deviceIds = request.operations().stream().map(OperationDto::deviceId).collect(Collectors.toSet());
		for (OperationDto op : request.operations()) {
			if (!UuidV7.isV7(op.operationId())) {
				throw ApiException.badRequest("invalid_operation_id", "operationId must be a UUIDv7: " + op.operationId());
			}
		}
		if (principal.deviceId() != null) {
			for (OperationDto op : request.operations()) {
				if (!principal.deviceId().equals(op.deviceId()) || !principal.storeId().equals(op.storeId())) {
					throw ApiException.forbidden("device_mismatch", "Operation does not belong to the authenticated device");
				}
			}
		}
		Map<UUID, DeviceDirectory.DeviceInfo> known = devices.find(deviceIds);
		for (OperationDto op : request.operations()) {
			DeviceDirectory.DeviceInfo device = known.get(op.deviceId());
			if (device == null || !device.storeId().equals(op.storeId())) {
				throw ApiException.unprocessable("unknown_device",
						"Operation references an unknown store or device for this tenant");
			}
			if (device.state() == DeviceDirectory.State.REVOKED) {
				throw ApiException.forbidden("device_revoked",
						"This device has been revoked by the owner; sync is no longer permitted");
			}
		}
	}

	private List<OperationResult> refreshStatuses(List<OperationResult> results) {
		List<OperationResult> refreshed = new ArrayList<>(results.size());
		for (OperationResult r : results) {
			refreshed.add("deferred".equals(r.status()) ? processor.currentResult(r.operationId()).orElse(r) : r);
		}
		return refreshed;
	}

	private static UploadResponse summarise(List<OperationResult> results) {
		int duplicates = 0;
		int rejected = 0;
		int deferred = 0;
		int flagged = 0;
		for (OperationResult r : results) {
			switch (r.status()) {
				case "duplicate" -> duplicates++;
				case "rejected" -> rejected++;
				case "deferred" -> deferred++;
				case "flagged" -> flagged++;
				default -> {
				}
			}
		}
		return new UploadResponse(results.size() - duplicates, duplicates, rejected, deferred, flagged, results);
	}
}
