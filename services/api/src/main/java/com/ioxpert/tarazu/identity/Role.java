package com.ioxpert.tarazu.identity;

import java.util.Arrays;
import java.util.Optional;

/** The seven staff roles. {@link #wire()} is the stored/API spelling. */
public enum Role {
	OWNER, MANAGER, CASHIER, PURCHASER, ACCOUNTANT, SALES_REP, DELIVERY_AGENT;

	public String wire() {
		return name().toLowerCase();
	}

	public static Optional<Role> fromWire(String value) {
		return Arrays.stream(values()).filter(r -> r.wire().equals(value)).findFirst();
	}
}
