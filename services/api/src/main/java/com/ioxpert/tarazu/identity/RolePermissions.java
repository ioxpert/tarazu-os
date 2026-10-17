package com.ioxpert.tarazu.identity;

import static com.ioxpert.tarazu.identity.Permission.*;

import java.util.EnumSet;
import java.util.Map;
import java.util.Set;

/** The role matrix. Discounts, voids and backdating are not permissions: they need an owner PIN approval. */
final class RolePermissions {

	private static final Map<Role, Set<Permission>> MATRIX = Map.of(
			Role.OWNER, EnumSet.allOf(Permission.class),
			Role.MANAGER, EnumSet.complementOf(EnumSet.of(SETTINGS_MANAGE)),
			Role.CASHIER, EnumSet.of(RECORD_SALE, RECORD_PAYMENT, MANAGE_PARTY, CONSENT_RECORD),
			Role.PURCHASER, EnumSet.of(RECORD_PURCHASE, MANAGE_CATALOGUE, ADJUST_STOCK, MANAGE_PARTY),
			Role.ACCOUNTANT, EnumSet.of(AUDIT_READ, RECORD_PAYMENT, ISSUE_CREDIT_NOTE),
			Role.SALES_REP, EnumSet.of(MANAGE_ORDERS, MANAGE_PARTY, CONSENT_RECORD),
			Role.DELIVERY_AGENT, EnumSet.of(MANAGE_ORDERS, RECORD_PAYMENT));

	private RolePermissions() {
	}

	static Set<Permission> of(Role role) {
		return MATRIX.get(role);
	}
}
