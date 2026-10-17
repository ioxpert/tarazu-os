# ADR 0008: Offline owner approval with cached PBKDF2 verifiers

Status: accepted (17 Oct 2026)

## Context
A cashier discount above policy, a return/void and a back-dated bill need the owner's say-so (ADR 0004 sets the staff PIN
model). The counter is often offline, and rule 1 says a sale never waits for the cloud. The owner stands at the counter,
types a PIN on the cashier's device, and the sale must complete right then. The server can only learn about the approval
later, when the operation syncs, so the PIN has to be verifiable on the device.

## Decision
- `GET /v1/identity/approvers` (device credential, no staff PIN) returns, for the device's store, every ACTIVE user with
  the `owner` role (tenant-wide, or scoped to this store or its business) who has a PIN set:
  `{userId, displayName, pinSalt, pinHash, iterations}`.
- Verifier format: PBKDF2-HMAC-SHA256, 32-byte derived key, PIN = UTF-8 bytes of the digits, per-user random 16-byte salt,
  `iterations` taken from the row (600,000 in production, lower only in tests), salt and hash as standard base64. It is
  the same hash the server already stores for `POST /users/{id}/pin/verify`, so no second secret exists. The web client
  checks with WebCrypto `crypto.subtle.deriveBits`; the Java IT recomputes the hash with `javax.crypto` to pin the format.
- The endpoint is refused (403 `device_credential_required`) for any request that is not a registered, non-revoked
  device: the dev tenant header, a browser session and a tenant-level principal never receive verifiers. A revoked device
  is rejected by the authenticator (401) like on every `/v1` route.
- The device caches the list in the local `approver` table (never synced) and refreshes it whenever it is online. A
  verified approval travels on the operation as `approval: {approverUserId, reason}`. The PIN never leaves the device.
- The server cannot re-verify a PIN, so it checks what it can: the approver is an active owner and a reason exists
  (`Approvals.valid`). Otherwise the document is applied and flagged `approval_required` (rule: evidence of a sale that
  already happened is never rejected).

## Consequences
- Brute force: a 4-digit PIN has 10,000 values. Anyone who obtains a verifier (a stolen, unlocked device or its stolen
  token) can recover the PIN offline in minutes at most (10,000 candidates x 600,000 iterations); PBKDF2 only slows that by a constant factor.
  Online guessing is throttled by the five-attempt lockout, offline guessing is not. Mitigations: PBKDF2 cost, `4 to 8`
  digit PINs with 6+ recommended for owners, owner approvals are audited and flagged when the approver is not an owner,
  and device revocation takes effect at the next sync.
- Device-token theft: a stolen token returns the verifiers of the store's owners, so the thief can learn the owner PIN
  offline and approve discounts or voids on the cashier's own device; it cannot act as the owner on owner-only routes
  (those need `X-Staff-Id` and `X-Staff-Pin`, throttled online). Impact is bounded to the store, is visible in the audit
  trail and flags, and ends with revocation plus an owner PIN reset.
- A PIN reset or a disabled owner reaches an offline device only on its next refresh; until then the old PIN still works
  there. Approvals made in that window are valid at the time they were made, and the server's `isActiveOwner` check flags
  the ones whose approver is no longer an active owner.

## Alternatives rejected
- Online-only approval: breaks rule 1 and the counter in a power cut or a bad network, which is when the owner is most
  likely to be standing there.
- Signed one-time approval codes (the owner's phone shows a code): needs a second device, an online owner or a
  pre-shared clock-synced secret; a lost phone is a new account-recovery problem, and it is no better against a stolen
  device that holds the shared secret.
- Per-device approval key (the server mints a key per device, the owner PIN unlocks it): moves the secret into device
  storage that the thief already holds, and adds key rotation and revocation protocol without removing the brute-force
  surface of a short PIN.

## Open questions
- Longer owner PINs (6+ digits) or an alphanumeric passphrase, enforced when an owner PIN is set?
- Should every `approvers` fetch be audited (device, time) to make token theft visible? It is not today.
- Refresh policy: on every sync, daily, or on app start; and a maximum age after which a cached verifier is not trusted.
- Should the lockout counter also exist on the device (five wrong owner PINs lock approval for 15 minutes locally)?
- Do managers get approval rights for small amounts (a tiered policy) once staff login exists?

## Update (hardening decided)
- Owner PINs need at least 6 digits (`422 owner_pin_too_short`); other roles keep 4 to 8. A PIN set while the user was not an owner is not re-checked when
  the owner role is granted later: the owner should set a new PIN then (the hash cannot reveal its length).
- Every `GET /v1/identity/approvers` is audited (`approvers.fetched`, with the device), so a stolen device token pulling verifiers shows up.
- Device lockout: five wrong owner PINs lock approval on that device for 15 minutes (`verifyOwnerPinGuarded`, counter in the local-only `device_state`).
- A cached verifier set older than 30 days is not trusted (`approvers_stale`); the UI asks the cashier to connect once.
- Still open: refresh cadence (today: whenever online), longer-than-6-digit or passphrase owners, a manager tier for small amounts.
