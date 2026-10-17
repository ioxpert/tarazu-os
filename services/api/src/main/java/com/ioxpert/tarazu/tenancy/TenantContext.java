package com.ioxpert.tarazu.tenancy;

/**
 * Per-request tenant holder. Set by {@link TenantFilter}, cleared in its finally block.
 * Virtual threads are one-per-request, so a ThreadLocal is safe here.
 */
public final class TenantContext {

	private static final ThreadLocal<TenantId> CURRENT = new ThreadLocal<>();

	private TenantContext() {
	}

	static void set(TenantId tenant) {
		CURRENT.set(tenant);
	}

	static void clear() {
		CURRENT.remove();
	}

	public static TenantId require() {
		TenantId tenant = CURRENT.get();
		if (tenant == null) {
			throw new IllegalStateException("No tenant bound to this request");
		}
		return tenant;
	}
}
