package com.ioxpert.tarazu.consent;

import java.time.Instant;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;

import com.ioxpert.tarazu.tenancy.UuidV7;
import com.ioxpert.tarazu.tenancy.ApiException;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/v1/consent")
class ConsentController {

	record PurposeView(String id, String description, boolean thirdParty) {
	}

	/** No defaults anywhere: every field must be chosen by the caller. */
	record EventRequest(@NotNull UUID operationId, @NotBlank @Size(max = 128) String idempotencyKey,
			@NotNull @Pattern(regexp = "party|user") String subjectType, @NotNull UUID subjectId,
			@NotBlank String purpose, @NotNull @Pattern(regexp = "grant|withdraw") String action,
			@NotBlank @Size(max = 64) String policyVersion,
			@NotNull @Pattern(regexp = "in_app|paper|verbal|whatsapp|sms") String channel, @NotNull Instant occurredAt) {
	}

	record SharingRequest(@NotNull UUID operationId, @NotBlank @Size(max = 128) String idempotencyKey,
			@NotNull @Pattern(regexp = "party|user") String subjectType, @NotNull UUID subjectId,
			@NotBlank String purpose, @NotBlank @Size(max = 200) String recipient,
			@NotEmpty List<@NotBlank String> dataCategories, @NotNull Instant sharedAt) {
	}

	record SubjectConsent(String subjectType, UUID subjectId, List<ConsentService.EventView> current,
			List<ConsentService.EventView> history) {
	}

	record ModeRequest(@NotNull Boolean localOnly, @NotBlank @Size(max = 500) String reason) {
	}

	private final ConsentService service;

	ConsentController(ConsentService service) {
		this.service = service;
	}

	@GetMapping("/purposes")
	List<PurposeView> purposes() {
		return Arrays.stream(ConsentPurpose.values())
				.map(p -> new PurposeView(p.wire(), p.description(), p.sharesWithThirdParty())).toList();
	}

	@PostMapping("/events")
	ConsentService.EventView record(@Valid @RequestBody EventRequest body) {
		requireV7(body.operationId());
		return service.record(body.operationId(), body.idempotencyKey(), body.subjectType(), body.subjectId(), body.purpose(),
				body.action(), body.policyVersion(), body.channel(), body.occurredAt());
	}

	@GetMapping("/subjects/{subjectType}/{subjectId}")
	SubjectConsent subject(@PathVariable @Pattern(regexp = "party|user") String subjectType, @PathVariable UUID subjectId) {
		return new SubjectConsent(subjectType, subjectId, service.current(subjectType, subjectId),
				service.history(subjectType, subjectId));
	}

	@PostMapping("/sharing-log")
	ConsentService.SharingView logSharing(@Valid @RequestBody SharingRequest body) {
		requireV7(body.operationId());
		return service.logSharing(body.operationId(), body.idempotencyKey(), body.subjectType(), body.subjectId(),
				body.purpose(), body.recipient(), body.dataCategories(), body.sharedAt());
	}

	@GetMapping("/sharing-log")
	List<ConsentService.SharingView> sharingLog(@RequestParam(required = false) @Pattern(regexp = "party|user") String subjectType,
			@RequestParam(required = false) UUID subjectId) {
		return service.sharingLog(subjectType, subjectId);
	}

	@GetMapping("/mode")
	ConsentService.Mode mode() {
		return service.mode();
	}

	@PutMapping("/mode")
	ConsentService.Mode setMode(@Valid @RequestBody ModeRequest body) {
		return service.setMode(body.localOnly(), body.reason());
	}

	private static void requireV7(UUID id) {
		if (!UuidV7.isV7(id)) {
			throw ApiException.badRequest("invalid_operation_id", "operationId must be a UUIDv7");
		}
	}
}
