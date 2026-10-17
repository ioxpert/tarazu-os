package com.ioxpert.tarazu.tenancy;

import java.util.Optional;

import jakarta.servlet.http.HttpServletRequest;

/**
 * Turns a request into a {@link Principal}. Implementations live next to the credentials they check
 * (identity). Return empty when the request carries no credential this authenticator understands;
 * throw {@link ApiException} (401) when it carries one that is invalid or revoked.
 */
public interface RequestAuthenticator {

	Optional<Principal> authenticate(HttpServletRequest request);
}
