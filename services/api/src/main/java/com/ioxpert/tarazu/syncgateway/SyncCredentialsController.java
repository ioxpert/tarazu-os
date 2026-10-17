package com.ioxpert.tarazu.syncgateway;

import com.ioxpert.tarazu.tenancy.TenantContext;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/v1/sync")
class SyncCredentialsController {

	private final SyncTokenService tokens;

	SyncCredentialsController(SyncTokenService tokens) {
		this.tokens = tokens;
	}

	/** PowerSync connector fetchCredentials(). A revoked device is already refused by the authenticator. */
	@GetMapping("/credentials")
	SyncTokenService.Credentials credentials() {
		return tokens.issue(TenantContext.principal());
	}
}
