# ADR 0006: Decisions on the foundation's open questions

Status: accepted (17 Oct 2026). Chosen for extensibility and the PRD; revisit when the named follow-up lands.

1. **PowerSync replication role**: no `BYPASSRLS`. A dedicated `powersync_repl` role gets `SELECT` plus a role-specific
   `FOR SELECT TO powersync_repl USING (true)` policy on the synced tables only (see `infra/powersync/README.md`). Narrower than a
   bypass, and a new synced table is an explicit ops step.
2. **Provisioning**: until OTP onboarding (next identity PR), ops provision tenant, business, store, owner and the first
   device (`infra/postgres/dev-seed.sql` is the local recipe). No unauthenticated sign-up endpoint is added; `/v1/**` stays fail-closed.
3. **Offline PIN checks**: devices will verify owner/manager approvals locally against a synced salted PBKDF2 verifier (never the
   PIN), only for users holding those roles, and only after the owner opts in. The server keeps checking the named approver is an
   active owner and audits it. Implemented with the onboarding/staff UI session; nothing syncs today.
4. **Revoked device**: sync stops, data stays on the device, the UI says "Action required". No remote wipe in the MVP. Unsent
   operations are not accepted after revocation; recovery is an owner-initiated export on the device (later UI session).
5. **Rejected finalised sales** (e.g. reused invoice number after a reinstall): the raw operation stays in `operation_log` with
   its reject code; an ops/admin re-apply tool (renumber under an audited override) is a follow-up, not automatic.
6. **Tax content**: owned by ops/CA, loaded with the admin role from the official notification (`notification_ref`
   required in practice); nothing is seeded in migrations.
7. **Consent**: the purpose list and `policy_version` wording are provisional pending legal review; the ledger is
   append-only so wording changes never rewrite history. Retention follows the legal review.
8. **Outbox**: when the integrations module needs one it gets its own `outbox_event` table with `tenant_id` and RLS; Spring Modulith's
   `event_publication` table is not used (it has no tenant column).
9. **Party merge / barcodes**: effective khata balance across merged parties (a view) and duplicate-barcode flags land with the
   khata and inventory UI sessions; the data needed (`merged_into`, `party_merge`) is already recorded.
10. **Limits**: 24 h clock-skew clamp and 3-day stuck-deferred flag stay. The 100k scale job runs on every PR for now; move it to
    nightly if it becomes the long pole.
11. **Device token storage**: `localStorage` for now (dev harness); the device-registration UI moves it to a non-extractable
    store. Tokens are revocable server-side meanwhile.
12. **Throughput**: about 500 ops/s on one Postgres is enough for Phase 1; set-based processing is the planned next step if measured otherwise.
