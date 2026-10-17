package com.ioxpert.tarazu.syncgateway;

import java.util.UUID;

/** One validated client operation, as handed to an {@link EntityOperationHandler}. */
public record Operation(UUID operationId, UUID tenantId, UUID storeId, UUID deviceId, UUID actorUserId, long localSeq,
		Hlc hlc, String idempotencyKey, String entityType, UUID entityId, String opType, int schemaVersion,
		Payload payload) {

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
