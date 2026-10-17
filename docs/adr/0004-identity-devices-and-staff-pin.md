# ADR 0004: Device credentials, staff PIN and audit

Status: accepted (17 Oct 2026)

## Context
Hierarchy is tenant > business > store > device > user with seven roles. Owner OTP login and device-bound JWTs were
deferred, but `/v1/**` must already fail closed and a revoked device must stop at its next sync.

## Decision
- **Device credential**: `Authorization: Bearer tzd.<tenantId>.<deviceId>.<secret>`, issued once at registration
  (`PUT /v1/identity/devices/{id}`, idempotent on the client-chosen id; a replay never shows the secret again). Only
  SHA-256 of the 256-bit secret is stored. The tenant id inside the token lets the API bind RLS before it looks the device
  up (no RLS bypass function). Revocation (`status = revoked`, with reason, audited) is checked on every request, so it
  bites at the next sync or credentials refresh; the dev-header path refuses a revoked device at upload too.
- **Staff**: `X-Staff-Id` + `X-Staff-Pin` on a device request identify the acting user. PIN = 4 to 8 digits, PBKDF2-HMAC-SHA256
  (600,000 iterations, per-user salt, JDK only), 5 misses lock it for 15 minutes, failed attempts are counted even though
  the request fails. A PIN is a convenience gate, not a primary credential: a leaked hash of a 4-digit PIN is brute-forceable
  whatever the KDF, which is why this is paired with device tokens and lockout.
- **Roles and permissions** are a static matrix (`RolePermissions`). Only an owner grants or removes `owner`; the last
  active owner cannot be removed or disabled (serialised with an advisory lock), and only an owner may change an owner's PIN, status or roles.
  Known gap: management permissions are tenant-wide; a store-scoped manager is not yet confined to their store. Discounts, voids and backdating are not permissions: they need an owner-PIN
  **approval** (`approval: {approverUserId, reason}` in the document; PIN checked on the device, the server verifies the
  approver is an active owner and records it in the audit log). Missing or invalid approval flags the document, it does not reject it (ADR 0002).
- **Actor on synced operations is device-asserted.** `actor_user_id` has no foreign key in `operation_log` or
  `audit_log`: an unknown claim is stored as sent and flagged `unknown_actor`.
- **Audit log** (`audit_log`): actor, device, action, entity, reason, details, timestamp; append-only by trigger; one row per
  (operation, action) so replays never double-log. Finalised documents have no DELETE grant and an append-only trigger.
- **Dev header** `X-Tenant-Id` (and `X-Staff-Id` without a PIN) exists only when `tarazu.auth.dev-header-enabled=true`.
  The authenticator bean is not created otherwise; `FailClosedIT` walks every mapped `/v1` endpoint with the flag off.

## Consequences
- Tenants, the first business/store/owner and the first device must be provisioned by ops until the OTP onboarding PR.
- Offline PIN checks (owner approving a discount with no network) need a verifier on the device; that is deliberately not
  decided here (see open questions).
- The 8 MiB body cap checks Content-Length only; chunked bodies must be capped at the reverse proxy.
- Brute-forcing a PIN online is throttled per user, which also lets an attacker lock a staff member out; rate limiting at
  the edge is the mitigation.
