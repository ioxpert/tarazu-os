package com.ioxpert.tarazu.syncgateway;

import java.util.List;
import java.util.UUID;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;

/** Owner/manager review and recovery of rejected operations (ADR 0013). */
@RestController
@RequestMapping("/v1/sync/rejections")
class RejectionController {

	record ReapplyRequest(JsonNode payloadPatch, @NotBlank @Size(max = 500) String reason) {
	}

	private final RejectionService service;

	RejectionController(RejectionService service) {
		this.service = service;
	}

	@GetMapping
	List<RejectionService.RejectionView> list(@RequestParam(defaultValue = "50") int limit) {
		return service.list(limit);
	}

	@PostMapping("/{operationId}/reapply")
	UploadResponse.OperationResult reapply(@PathVariable UUID operationId, @Valid @RequestBody ReapplyRequest body) {
		return service.reapply(operationId, body.payloadPatch(), body.reason());
	}
}
