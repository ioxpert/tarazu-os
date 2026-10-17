package com.ioxpert.tarazu.syncgateway;

import java.util.UUID;

/** A referenced entity has not reached the server yet. The operation is parked as deferred and retried when it does. */
public class MissingDependencyException extends RuntimeException {

	private final String entityType;
	private final UUID entityId;

	public MissingDependencyException(String entityType, UUID entityId) {
		super("Waiting for " + entityType + " " + entityId);
		this.entityType = entityType;
		this.entityId = entityId;
	}

	public String entityType() {
		return entityType;
	}

	public UUID entityId() {
		return entityId;
	}
}
