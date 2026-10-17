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

	/**
	 * Whether other operations can depend on entities of this type (ctx.require). Pure events nobody references
	 * (stock movements, khata entries, payments, ...) return false and skip registry bookkeeping, which is the
	 * bulk of all traffic. The safe default is true.
	 */
	default boolean registersEntity() {
		return true;
	}

	/**
	 * Lock-ordering hint for hot-row handlers. Operations of handlers returning a tier of 0 or more are applied
	 * after all the others, sorted by (lockTier, lockKey, localSeq), so concurrent batches that touch the same hot
	 * rows (stock of one product, one party's khata) take row locks in one global order and cannot deadlock each
	 * other. Everything else keeps the client's order, which matters for "first wins" rules (invoice numbers) and
	 * state machines (order transitions). Order never affects the final projections: they are sums.
	 */
	default int lockTier() {
		return -1;
	}

	default String lockKey(Operation op) {
		return op.entityId().toString();
	}

	HandlerResult handle(Operation op, OperationContext ctx);
}
