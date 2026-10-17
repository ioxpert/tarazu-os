package com.ioxpert.tarazu.syncgateway;

import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/v1/sync")
class SyncUploadController {

	private final SyncUploadService service;

	SyncUploadController(SyncUploadService service) {
		this.service = service;
	}

	@PostMapping("/upload")
	UploadResponse upload(@Valid @RequestBody UploadRequest request) {
		return service.upload(request);
	}
}
