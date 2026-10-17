package com.ioxpert.tarazu.identity;

/** What a role may do. Synced-operation handlers declare which permissions make an operation legitimate. */
public enum Permission {
	DEVICE_MANAGE,
	USER_MANAGE,
	SETTINGS_MANAGE,
	AUDIT_READ,
	CONSENT_RECORD,
	RECORD_SALE,
	ISSUE_CREDIT_NOTE,
	RECORD_PURCHASE,
	MANAGE_CATALOGUE,
	MANAGE_PARTY,
	RECORD_PAYMENT,
	ADJUST_STOCK,
	MANAGE_ORDERS,
	RESOLVE_FLAGS
}
