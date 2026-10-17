# Web sync client (apps/web/src/sync)

How the PWA records and uploads work. Server counterpart: `POST /v1/sync/upload` in `packages/contract/openapi.yaml`.

## One write path
Billing, stock and khata code never write business tables directly. It calls `OpLogWriter.write/writeAll`, which in
**one local SQLite transaction** allocates `local_seq` and an HLC from `device_state`, inserts the `op_log` row(s)
(UUIDv7 operation id, idempotency key `deviceId:localSeq`, schema version 1) and runs optional **local effects**
(`effects.ts`: stock and khata balances) so the counter shows the right numbers at once. The sale never waits for the network.

## Upload
`op_log` is an insert-only PowerSync table, so each row lands in the `ps_crud` queue. `TarazuConnector.uploadData`
drains it in batches of at most 500, POSTs them, and completes the batch once the server has acknowledged every
operation id (applied, flagged, deferred, rejected or duplicate). CRUD for other tables is the optimistic local
effect: completed without sending. Rejected and flagged results are copied into the local-only `op_issue` table.

| Server answer | Connector does |
|---|---|
| 200 | complete batch; copy rejected/flagged into `op_issue` |
| network error, 5xx, 429, 408 | throw; PowerSync retries with backoff; nothing completed |
| 401 `device_revoked` / `invalid_token`, 403 `device_revoked` | block: stop sync, keep data, state = Action required |
| other 4xx (e.g. 403 `local_only_mode`) | throw; shown as an upload problem (Action required); cleared on the next success |

## Sync status (3 states)
`deriveSyncState` (pure) turns the `syncStore` snapshot into **Saved on this device** (unsent ops, never synced, or
offline) / **Backed up** (queue empty, synced) / **Action required** (revoked or invalid device, refused upload, open
rejected/flagged ops). `SyncStatusBadge` reads only the store, so it does not load PowerSync.

## Bundle
`@powersync/web` and the SQLite WASM live in lazy chunks (`sync/runtime`, `dev/SyncHarness`); the app only imports the
runtime when a device config exists. `npm run size` fails if first-load JS exceeds 250 KB gzipped (currently ~70 KB).
WASM builds are cached on first use (not precached).

## Tools
- Dev harness: `#/dev/sync` (dev server, or build with `VITE_ENABLE_DEV_HARNESS=true`).
- `npm run smoke`: real wa-sqlite/OPFS stack in Chromium with no backend (needs `playwright`); asserts the queue
  counts, persistence across reload and commit P95 < 300 ms.
- PowerSync service config: `infra/powersync/` (draft, not exercised in CI).
