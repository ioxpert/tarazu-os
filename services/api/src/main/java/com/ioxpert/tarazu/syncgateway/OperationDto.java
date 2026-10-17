package com.ioxpert.tarazu.syncgateway;

import java.util.Map;
import java.util.UUID;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.PositiveOrZero;
import jakarta.validation.constraints.Size;

/** One client-side write, as recorded in the device outbox (PowerSync ps_crud). */
public record OperationDto(
		@NotNull UUID operationId,
		@NotNull UUID storeId,
		@NotNull UUID deviceId,
		UUID actorUserId,
		@PositiveOrZero long localSeq,
		@NotBlank @Pattern(regexp = Hlc.REGEX) String hlc,
		@NotBlank @Size(max = 128) String idempotencyKey,
		@NotBlank @Size(max = 64) String entityType,
		@NotNull UUID entityId,
		@NotNull @Pattern(regexp = "create|update|void") String opType,
		@Positive int schemaVersion,
		@NotNull Map<String, Object> payload) {
}
