package com.ioxpert.tarazu.syncgateway;

import java.util.List;

/**
 * accepted = newly stored this call (any outcome); duplicates = already stored, ignored.
 * results acknowledges every operation id in the request, in order, so the device can drop it from its queue.
 */
public record UploadResponse(int accepted, int duplicates, int rejected, int deferred, int flagged,
		List<OperationResult> results) {

	/**
	 * status: applied | flagged (applied, needs review) | deferred (stored, waiting for a parent entity) |
	 * rejected (stored, not applied; see code) | duplicate (seen before; originalStatus is its current status).
	 */
	public record OperationResult(java.util.UUID operationId, String status, String originalStatus, String code,
			String message) {
	}
}
