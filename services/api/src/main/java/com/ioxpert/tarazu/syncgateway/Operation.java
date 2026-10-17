package com.ioxpert.tarazu.syncgateway;

import java.util.UUID;

/**
 * One validated client operation, as handed to an {@link EntityOperationHandler}. {@code hlc} is the clock to merge
 * with (clamped if the device clock ran far ahead, see {@link Hlc#effectiveAt}); the operation log keeps what the
 * device sent. {@code clockSkewed} says it was clamped.
 */
public record Operation(UUID operationId, UUID tenantId, UUID storeId, UUID deviceId, UUID actorUserId, long localSeq,
		Hlc hlc, String idempotencyKey, String entityType, UUID entityId, String opType, int schemaVersion,
		Payload payload, boolean clockSkewed) {

	public boolean isCreate() {
		return "create".equals(opType);
	}

	public boolean isUpdate() {
		return "update".equals(opType);
	}

	public boolean isVoid() {
		return "void".equals(opType);
	}
}
