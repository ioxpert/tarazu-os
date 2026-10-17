package com.ioxpert.tarazu.syncgateway;

/** The operation payload is structurally wrong. The operation is rejected (kept in the log, not applied). */
public class InvalidPayloadException extends RuntimeException {

	public InvalidPayloadException(String message) {
		super(message);
	}
}
