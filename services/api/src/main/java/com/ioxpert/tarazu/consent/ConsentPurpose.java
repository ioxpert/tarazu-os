package com.ioxpert.tarazu.consent;

import java.util.Arrays;
import java.util.Optional;

/**
 * Closed list of purposes consent can be given for. Each is separate: granting one never implies another and
 * nothing is pre-selected. Legal wording lives with the policy_version the client shows; the list itself is an
 * open question for legal review (see the PR description).
 */
public enum ConsentPurpose {
	SERVICE_IMPROVEMENT("service_improvement", "Use anonymised usage to improve the product", false),
	MARKETING_MESSAGES("marketing_messages", "Send offers and promotions", false),
	WHATSAPP_REMINDERS("whatsapp_reminders", "Send payment reminders and bills on WhatsApp", false),
	AI_FEATURES("ai_features", "Process this person's data with AI assistants", false),
	CREDIT_ASSESSMENT("credit_assessment", "Use transaction history to assess credit", true),
	THIRD_PARTY_SHARING("third_party_sharing", "Share data with named third parties", true);

	private final String wire;
	private final String description;
	private final boolean sharesWithThirdParty;

	ConsentPurpose(String wire, String description, boolean sharesWithThirdParty) {
		this.wire = wire;
		this.description = description;
		this.sharesWithThirdParty = sharesWithThirdParty;
	}

	public String wire() {
		return wire;
	}

	public String description() {
		return description;
	}

	public boolean sharesWithThirdParty() {
		return sharesWithThirdParty;
	}

	public static Optional<ConsentPurpose> fromWire(String value) {
		return Arrays.stream(values()).filter(p -> p.wire.equals(value)).findFirst();
	}
}
