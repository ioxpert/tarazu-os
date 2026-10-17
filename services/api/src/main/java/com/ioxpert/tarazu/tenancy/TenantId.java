package com.ioxpert.tarazu.tenancy;

import java.util.UUID;

/** Identifies the merchant account every request acts for. */
public record TenantId(UUID value) {
}
