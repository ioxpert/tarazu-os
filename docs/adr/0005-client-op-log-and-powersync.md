# ADR 0005: Client op log and PowerSync wiring

Status: accepted (17 Oct 2026)

## Context
The device database is the system of record. Business events must be recorded in one local transaction, uploaded
exactly once in effect, and survive a 30-day outage or 100,000 queued operations, while PowerSync streams the server's
read model back down.

## Decision
- **One upload channel.** `op_log` is an *insert-only* PowerSync table (its rows are not stored locally; PowerSync queues
  them in `ps_crud`). The connector drains that queue in 500-operation batches to `POST /v1/sync/upload`. Writes to read-model
  tables are optimistic local effects: PowerSync queues them too, and `uploadData` completes and discards them unsent.
- **`OpLogWriter`** is the only way billing/khata/stock code records an event: one `writeTransaction` allocates
  `localSeq` and HLC from `device_state`, inserts the op(s) (`operationId` UUIDv7, `idempotencyKey = deviceId:localSeq`)
  and runs the optimistic effects, atomically. Payloads are typed from the OpenAPI schemas.
- **Retries**: network/5xx/429 throw (PowerSync backs off, nothing completed); server acknowledgements are final, so a
  batch is completed once the request succeeds, and `rejected`/`flagged` results are copied to the local `op_issue`
  table. `401 device_revoked/invalid_token` stops sync and shows "Action required"; local data is kept (never wiped silently).
- **Three visible states**: "Saved on this device" (unsent operations, never synced, or offline), "Backed up" (queue empty,
  recent contact), "Action required" (revoked/unauthorised, upload refused, or rejected/flagged operations).
- **Lazy loading**: PowerSync and SQLite WASM are separate chunks loaded by `getSyncRuntime()`; first-load JS is checked
  by `npm run size` (limit 250 KB gzipped).
- **Sync rules** bucket by `merchant_id` (tenant id) from the JWT minted by `GET /v1/sync/credentials` (HS256, 5 minute TTL).

## Consequences
- The PowerSync service and its sync rules are drafts, not exercised in CI (`infra/powersync`). The replication role needs
  `BYPASSRLS` (or a role-specific SELECT policy) because every table has FORCE RLS: a security exception to sign off.
- Optimistic effects use `INSERT OR REPLACE` because PowerSync tables are views without `ON CONFLICT` upserts.
