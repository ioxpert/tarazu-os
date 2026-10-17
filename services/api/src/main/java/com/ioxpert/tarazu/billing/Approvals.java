package com.ioxpert.tarazu.billing;

import java.util.UUID;

import com.ioxpert.tarazu.syncgateway.OperationContext;
import com.ioxpert.tarazu.syncgateway.Payload;
import tools.jackson.databind.JsonNode;

/**
 * Owner-PIN approval carried with a document: {@code approval: {approverUserId, reason}}. The PIN was checked on
 * the device (offline); the server can only check that the named approver is an active owner and that a reason
 * was given. A missing or invalid approval never rejects a finalised document, it raises a review flag.
 */
final class Approvals {

	private Approvals() {
	}

	static boolean valid(OperationContext ctx, Payload payload) {
		JsonNode approval = payload.optObject("approval");
		if (approval == null) {
			return false;
		}
		Payload a = new Payload(approval);
		UUID approver = a.optUuid("approverUserId").orElse(null);
		return approver != null && a.optText("reason").isPresent() && ctx.isActiveOwner(approver);
	}

	static String reason(Payload payload) {
		JsonNode approval = payload.optObject("approval");
		return approval == null ? null : new Payload(approval).optText("reason").orElse(null);
	}

	static String json(Payload payload, tools.jackson.databind.json.JsonMapper mapper) {
		JsonNode approval = payload.optObject("approval");
		return approval == null ? null : mapper.writeValueAsString(approval);
	}
}
