package com.ioxpert.tarazu.identity;

import java.time.Instant;
import java.util.UUID;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/** Device pairing (docs/adr/0015). {@code /v1/pairing/redeem} is public (see PublicPaths); the owner call needs DEVICE_MANAGE. */
@RestController
class PairingController {

	record PairingRequest(@NotNull UUID storeId, @Size(max = 100) String label) {
	}

	record PairingCreated(String code, Instant expiresAt, UUID storeId, String label) {
	}

	record RedeemRequest(@NotBlank @Size(max = 32) String code, @NotNull UUID deviceId,
			@NotNull @Pattern(regexp = "[A-Za-z0-9_-]{43}") String secret) {
	}

	record Paired(UUID tenantId, UUID deviceId, UUID storeId, String label, String token) {
	}

	private final PairingService service;

	PairingController(PairingService service) {
		this.service = service;
	}

	@PostMapping("/v1/identity/device-pairings")
	ResponseEntity<PairingCreated> create(@Valid @RequestBody PairingRequest body) {
		var c = service.create(body.storeId(), body.label());
		return ResponseEntity.status(HttpStatus.CREATED).body(new PairingCreated(c.code(), c.expiresAt(), c.storeId(), c.label()));
	}

	@PostMapping("/v1/pairing/redeem")
	ResponseEntity<Paired> redeem(@Valid @RequestBody RedeemRequest body) {
		var r = service.redeem(body.code(), body.deviceId(), body.secret());
		return ResponseEntity.status(r.created() ? HttpStatus.CREATED : HttpStatus.OK)
				.body(new Paired(r.tenantId(), r.deviceId(), r.storeId(), r.label(), r.token()));
	}
}
