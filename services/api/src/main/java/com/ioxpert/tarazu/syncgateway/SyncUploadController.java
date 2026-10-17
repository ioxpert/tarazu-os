package com.ioxpert.tarazu.syncgateway;

import jakarta.validation.Valid;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.RestControllerAdvice;

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

	@RestControllerAdvice(assignableTypes = SyncUploadController.class)
	static class Errors {

		/** Unknown store/device for this tenant (composite FKs also block cross-tenant references). */
		@ExceptionHandler(DataIntegrityViolationException.class)
		ProblemDetail integrity(DataIntegrityViolationException ex) {
			return ProblemDetail.forStatusAndDetail(HttpStatus.UNPROCESSABLE_ENTITY,
					"Operation references an unknown store or device for this tenant");
		}
	}
}
