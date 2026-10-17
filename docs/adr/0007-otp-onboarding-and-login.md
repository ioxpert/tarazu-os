# ADR 0007: OTP onboarding and login (email, phone or both, per deployment)

Status: accepted (17 Oct 2026). Amends locked rules 3 and 6 in CLAUDE.md (one tiny public surface, one global lookup).

## Context
Owners must be able to create their own account and sign in without ops. The deployment decides whether proof of an email, a phone,
either, or both is required. Until now tenants were provisioned by hand (ADR 0004, ADR 0006).

## Decision
- **Configurable mode**: `tarazu.auth.otp.mode` = `EMAIL | PHONE | EITHER | BOTH`. EMAIL/PHONE allow only that channel. EITHER: the owner
  gives email, phone or both and every contact given is verified. BOTH: both are required and both verified. Login works on any
  enabled channel the account has. `GET /v1/auth/otp/config` tells the client what to render.
- **Flow**: `signup/start` sends a 6-digit code per required contact (nothing durable is created), `signup/verify` checks one contact
  at a time and, when the last is verified, creates tenant, business, a first store ("Main"), the owner user and role, registers the
  contacts, audits `tenant.onboarded` and returns an owner session. `login/start` + `login/verify` give a session. Staff added by the
  owner (`PUT /v1/identity/users/{id}` with phone and/or email) sign in the same way with their own roles.
- **Codes**: 10 minute TTL, stored only as `HMAC(pepper, tenant|challenge|code)`, 5 wrong tries then locked, a resend replaces the old
  code, resend cooldown 60 s, at most 5 requests per contact per hour (counted globally). Failed attempts are committed even though the
  request fails. Unknown login contacts get the same 202 and token shape (no account enumeration). Signup of an existing contact is
  409 `contact_in_use`: a deliberate, rate-limited trade-off for usability.
- **Sessions**: opaque `tzs.<tenant>.<session>.<secret>` bearer (SHA-256 stored), 30 days, revoked by logout or by disabling the user,
  carrying the user's roles, so management calls need no staff headers. Devices keep their own token (ADR 0004).
- **Senders**: `OtpSender` SPI; production SMS (DLT-registered template) and email providers plug in later. With no sender for an
  enabled channel, or no pepper, the endpoints answer 503; there is no default secret. `tarazu.auth.otp.dev-log-codes=true` logs codes (dev only).
- **Rule 6 amendment**: exactly six `/v1/auth/...` paths are reachable without a credential (`PublicPaths`, exact match, so encoded or
  `;`-parameterised forms stay authenticated). Each takes only an opaque single-purpose token; `FailClosedIT` proves every other `/v1` endpoint is 401.
- **Rule 3 amendment**: login must find a tenant from a contact before any tenant is known. `contact_directory` (and `otp_throttle`) hold
  only keyed hashes, have no tenant_id and **no privileges for the API role**; the only access is four `SECURITY DEFINER` functions with a
  pinned search_path (`contact_register` and `contact_release` only act on the bound tenant, `contact_lookup` is the one cross-tenant read,
  returning a tenant and user id). `SchemaGuardIT` enforces both properties. A signup's rows use a tenant id minted up front (no FK to
  `tenant` yet), so RLS binds from the first row and the id becomes the tenant's.
- One contact belongs to exactly one account. Multi-business owners (one person, several tenants) are a later extension of the directory key.

## Consequences
- Operators set `OTP_PEPPER` (at least 16 random chars; rotating it invalidates logins until contacts are re-registered) and `OTP_MODE`.
- Email deliverability and SMS DLT templates are external work; nothing here sends real messages yet.
- OTP is weaker than device-bound keys against SIM-swap; the device token + staff PIN layers remain for counters.
