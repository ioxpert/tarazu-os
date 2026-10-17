package com.ioxpert.tarazu.syncgateway;

/** accepted = newly stored; duplicates = already stored (same idempotency key or operation id). */
public record UploadResponse(int accepted, int duplicates) {
}
