package com.ioxpert.tarazu.tenancy;

/**
 * Per-request principal holder. Set by {@link TenantFilter}, cleared in its finally block.
 * Virtual threads are one-per-request, so a ThreadLocal is safe here.
 */
public final class TenantContext {

	private static final ThreadLocal<Principal> CURRENT = new ThreadLocal<>();

	private TenantContext() {
	}

	static void set(Principal principal) {
		CURRENT.set(principal);
	}

	static void clear() {
		CURRENT.remove();
	}

	public static Principal principal() {
		Principal principal = CURRENT.get();
		if (principal == null) {
			throw new IllegalStateException("No principal bound to this request");
		}
		return principal;
	}

	public static TenantId require() {
		return principal().tenant();
	}
}
