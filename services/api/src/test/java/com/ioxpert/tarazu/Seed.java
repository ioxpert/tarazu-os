package com.ioxpert.tarazu;

import java.util.UUID;

/** A seeded merchant: one tenant, business, store, a registered device and an owner user. */
public record Seed(UUID tenant, UUID business, UUID store, UUID device, UUID owner) {
}
