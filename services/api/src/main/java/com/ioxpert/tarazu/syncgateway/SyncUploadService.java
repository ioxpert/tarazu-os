package com.ioxpert.tarazu.syncgateway;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;
import java.util.function.Supplier;
import java.util.stream.Collectors;

import com.ioxpert.tarazu.consent.TenantSettings;
import com.ioxpert.tarazu.identity.DeviceDirectory;
import com.ioxpert.tarazu.syncgateway.UploadResponse.OperationResult;
import com.ioxpert.tarazu.tenancy.ApiException;
import com.ioxpert.tarazu.tenancy.Principal;
import com.ioxpert.tarazu.tenancy.TenantContext;
import com.ioxpert.tarazu.tenancy.TenantSession;
import com.ioxpert.tarazu.tenancy.UuidV7;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.ConcurrencyFailureException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.json.JsonMapper;

/**
 * One upload batch = one transaction. Whole-request problems (unknown store/device, revoked device, local-only
 * tenant, malformed ids) fail the request before anything is stored. Per-operation problems never do: they
 * are acknowledged as rejected/deferred/flagged and the batch carries on.
 *
 * <p>Deadlocks and serialisation failures between concurrent batches are retried here: the batch is idempotent,
 * so re-running it is safe. After commit, parked (deferred) operations whose parent has arrived are woken.
 */
@Service
class SyncUploadService {

	private static final Logger log = LoggerFactory.getLogger(SyncUploadService.class);
	private static final int ATTEMPTS = 12;
	private static final int MAX_SWEEPS = 5;

	private record Outcome(UploadResponse response, boolean sweep) {
	}

	private final TenantSession tenantSession;
	private final DeviceDirectory devices;
	private final TenantSettings settings;
	private final OperationProcessor processor;
	private final JsonMapper json;
	private final TransactionTemplate tx;

	SyncUploadService(TenantSession tenantSession, DeviceDirectory devices, TenantSettings settings,
			OperationProcessor processor, JsonMapper json, PlatformTransactionManager tm) {
		this.tenantSession = tenantSession;
		this.devices = devices;
		this.settings = settings;
		this.processor = processor;
		this.json = json;
		this.tx = new TransactionTemplate(tm);
	}

	UploadResponse upload(UploadRequest request) {
		Outcome outcome = retrying(() -> tx.execute(status -> process(request)));
		if (outcome.sweep()) {
			sweepAfterCommit();
		}
		return outcome.response();
	}

	private Outcome process(UploadRequest request) {
		tenantSession.bindCurrentTenant();
		Principal principal = TenantContext.principal();
		UUID tenantId = principal.tenant().value();

		if (settings.isLocalOnly()) {
			throw ApiException.forbidden("local_only_mode", "This merchant is in local-only mode; sync is disabled");
		}
		validateBatch(request, principal);

		int n = request.operations().size();
		record Prepared(int index, Operation op, String declaredHlc, String payloadJson, String order) {
		}
		java.time.Instant received = java.time.Instant.now();
		List<Prepared> prepared = new ArrayList<>(n);
		for (int i = 0; i < n; i++) {
			OperationDto dto = request.operations().get(i);
			Hlc declared;
			try {
				declared = Hlc.parse(dto.hlc());
			}
			catch (IllegalArgumentException ex) {
				throw ApiException.badRequest("invalid_hlc", "Operation " + dto.operationId() + " has an impossible HLC: " + dto.hlc());
			}
			String payloadJson = clean(json.writeValueAsString(dto.payload()));
			Operation op = new Operation(dto.operationId(), tenantId, dto.storeId(), dto.deviceId(), dto.actorUserId(),
					dto.localSeq(), declared.effectiveAt(received), clean(dto.idempotencyKey()), clean(dto.entityType()), dto.entityId(),
					dto.opType(), dto.schemaVersion(), new Payload(json.readTree(payloadJson)), declared.isSkewedAt(received));
			prepared.add(new Prepared(i, op, dto.hlc(), payloadJson, processor.lockOrder(op, i)));
		}
		// Apply in lock order (see EntityOperationHandler.lockTier), report in request order.
		prepared.sort(Comparator.comparing(Prepared::order));
		OperationResult[] ordered = new OperationResult[n];
		OperationProcessor.Batch batch = new OperationProcessor.Batch();
		Set<UUID> fresh = processor.storeAll(prepared.stream().map(Prepared::op).toList(),
				prepared.stream().map(Prepared::declaredHlc).toList(), prepared.stream().map(Prepared::payloadJson).toList());
		Map<UUID, OperationResult> known = processor
				.duplicateResults(prepared.stream().map(Prepared::op).filter(o -> !fresh.contains(o.operationId())).toList());
		Set<UUID> applied = new java.util.HashSet<>();
		for (Prepared p : prepared) {
			UUID id = p.op().operationId();
			if (fresh.contains(id) && applied.add(id)) {
				ordered[p.index()] = processor.apply(p.op(), batch);
			}
			else {
				// a second copy of the same operation id inside one batch is a duplicate, not a second operation
				ordered[p.index()] = known.getOrDefault(id, new OperationResult(id, "duplicate", "applied", null, null));
			}
		}
		processor.drainDeferred(batch);
		// a deferred op may have been applied by the drain: report the status as of the end of the batch
		List<OperationResult> results = refreshStatuses(Arrays.asList(ordered));

		request.operations().stream().map(OperationDto::deviceId).distinct().forEach(devices::markSeen);
		// any batch that did real work may have parked, registered, or left earlier parked work to wake
		boolean sweep = Arrays.stream(ordered).anyMatch(r -> !"duplicate".equals(r.status()));
		return new Outcome(summarise(results), sweep);
	}

	/**
	 * Wakes deferred operations in their own transaction after the upload committed. Failure here never fails the
	 * upload (the operations are safely stored); the next upload's sweep picks up whatever this one missed.
	 */
	private void sweepAfterCommit() {
		try {
			for (int round = 0; round < MAX_SWEEPS; round++) {
				int applied = retrying(() -> tx.execute(status -> {
					tenantSession.bindCurrentTenant();
					return processor.sweepDeferred(new OperationProcessor.Batch());
				}));
				if (applied == 0) {
					return;
				}
			}
		}
		catch (RuntimeException ex) {
			log.warn("Post-commit sweep of deferred operations failed; it will be retried by the next upload", ex);
		}
	}

	/** Postgres text and jsonb cannot hold NUL; keep the rest of the operation rather than failing the batch. */
	private static String clean(String value) {
		return value == null ? null : value.replace("\\u0000", "\uFFFD").replace('\u0000', '\uFFFD');
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

	/**
	 * Two devices updating the same rows in different order can deadlock. Batches are idempotent, so the loser is
	 * simply re-run: replaying already-stored operations is a no-op.
	 */
	static <T> T retrying(Supplier<T> action) {
		for (int attempt = 1;; attempt++) {
			try {
				return action.get();
			}
			catch (ConcurrencyFailureException ex) {
				if (attempt == ATTEMPTS) {
					throw ex;
				}
				try {
					Thread.sleep(ThreadLocalRandom.current().nextLong(5, 20L + 15L * attempt));
				}
				catch (InterruptedException ie) {
					Thread.currentThread().interrupt();
					throw ex;
				}
			}
		}
	}
}
