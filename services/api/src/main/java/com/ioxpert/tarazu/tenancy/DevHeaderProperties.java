package com.ioxpert.tarazu.tenancy;

/** Name of the dev-only switch. The dev headers exist only behind {@code tarazu.auth.dev-header-enabled=true}. */
public final class DevHeaderProperties {

	public static final String ENABLED = "tarazu.auth.dev-header-enabled";
	public static final String TENANT_HEADER = "X-Tenant-Id";
	public static final String STAFF_HEADER = "X-Staff-Id";

	private DevHeaderProperties() {
	}
}
