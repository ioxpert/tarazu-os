package com.ioxpert.tarazu.syncgateway;

import java.util.Set;

import com.ioxpert.tarazu.identity.Permission;

/**
 * Applies operations of one entity type, under that entity's conflict policy. Implemented by the module that
 * owns the entity; the gateway discovers handlers as beans. Runs inside the upload transaction with the tenant
 * bound, so a handler uses its own JdbcClient and RLS applies.
 */
public interface EntityOperationHandler {

	String entityType();

	/** Highest payload schema version this handler understands. Newer ops are rejected (and kept in the log). */
	default int maxSchemaVersion() {
		return 1;
	}

	/** Any one of these makes the actor's role legitimate for this op. Empty = no check. Violations are flagged. */
	default Set<Permission> permissions(Operation op) {
		return Set.of();
	}

	HandlerResult handle(Operation op, OperationContext ctx);
}
