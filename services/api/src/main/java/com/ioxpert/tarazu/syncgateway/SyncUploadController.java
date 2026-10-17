package com.ioxpert.tarazu.syncgateway;

import java.util.concurrent.ThreadLocalRandom;
import java.util.function.Supplier;

import jakarta.validation.Valid;
import org.springframework.dao.ConcurrencyFailureException;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/v1/sync")
class SyncUploadController {

	private static final int ATTEMPTS = 6;

	private final SyncUploadService service;

	SyncUploadController(SyncUploadService service) {
		this.service = service;
	}

	@PostMapping("/upload")
	UploadResponse upload(@Valid @RequestBody UploadRequest request) {
		return retrying(() -> service.upload(request));
	}

	/**
	 * Two devices updating the same rows in different order can deadlock. The batch is idempotent, so the loser
	 * is simply re-run: replaying already-stored operations is a no-op.
	 */
	static <T> T retrying(Supplier<T> action) {
		for (int attempt = 1;; attempt++) {
			try {
				return action.get();
			}
			catch (ConcurrencyFailureException ex) {
				if (attempt == ATTEMPTS) {
					throw ex;
				}
				try {
					Thread.sleep(ThreadLocalRandom.current().nextLong(5, 25L * attempt));
				}
				catch (InterruptedException ie) {
					Thread.currentThread().interrupt();
					throw ex;
				}
			}
		}
	}
}
