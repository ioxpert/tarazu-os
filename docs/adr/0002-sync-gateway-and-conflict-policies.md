# ADR 0002: Sync gateway, operation log and per-entity conflict policies

Status: accepted (17 Oct 2026)

## Context
Devices are the transaction plane and may be offline for weeks (the PRD requires 30 days or 100,000 unsynced
operations). Two counters can sell the same last units; a device clock can be wrong; the same batch can arrive twice,
late, or before the parent it refers to. A completed sale must never be lost or blocked, and money data must stay
reconstructible.

## Decision
**One write path.** Devices send operations (envelope: UUIDv7 `operationId`, store/device/actor ids, `localSeq`, HLC,
`idempotencyKey`, `schemaVersion`, `entityType`/`entityId`/`opType`, `payload`) to `POST /v1/sync/upload`.
`syncgateway` stores every operation in the immutable `operation_log` (one statement per batch), then applies it
through the `EntityOperationHandler` owned by the entity's module. Every operation id is acknowledged:

| status | meaning | device action |
|---|---|---|
| `applied` | applied | none |
| `flagged` | applied, a human should look (a review flag was raised) | surface "action required" |
| `deferred` | stored, waiting for a parent entity that has not arrived; applied automatically when it does | none |
| `rejected` | stored raw, not applied (invalid payload, immutable document, duplicate number, ...) | surface "action required" |
| `duplicate` | already known (same operation id or idempotency key); `originalStatus` says what became of it | none |

Policy violations on something that already happened on a device (missing owner approval, wrong tax rate, totals
that do not add, wrong document type for the GST mode, actor without the role) are **applied and flagged, never
rejected**: rejecting a completed sale loses money data. Only structural problems reject. A rejected operation stays
in `operation_log`, so it can be re-applied after a server fix. An unexpected handler exception rejects that one
operation (`internal_error`, logged at ERROR) instead of wedging the device's queue; transient database failures
(deadlock, outage) roll the whole batch back and the device retries it unchanged.

**Batching and atomicity.** One request is one transaction; each operation applies inside a savepoint. Whole-request
problems (400 ids, 403 revoked or local-only, 422 unknown device, 413) store nothing. Deadlocks are retried server
side (batches are idempotent). Hot-row handlers (stock, khata) apply after the rest in a global lock order so
concurrent batches cannot deadlock each other; everything else keeps client order.

**Out-of-order arrival.** Handlers declare parents with `ctx.require(type, id)` against `entity_registry`. A missing
parent parks the operation as `deferred`. Parked operations wake when the parent registers in the same batch and,
because two concurrent requests can race (child parks while parent commits), again in a post-commit sweep. Whichever
request commits later is guaranteed to see the other's committed rows.

**Entity ids are tenant-scoped** (`PRIMARY KEY (tenant_id, id)`, all FKs composite), so another tenant reusing an id
can neither collide with nor probe a row. `operation_log` is keyed `(tenant_id, operation_id)` for the same reason.

**Clock skew.** The log keeps the device's HLC. For merging, an HLC more than 24 h ahead of the server is clamped to
the arrival time and flagged `clock_skew`, so a dead-battery phone cannot pin fields to 2099.

**Conflict policy per entity** (the gateway rejects `update`/`void` where the policy says append-only):

| entity | policy |
|---|---|
| `product` | mutable; merged **field by field** by HLC (`field_clock`); `void` deactivates, never deletes |
| `party` | like product; a phone/GSTIN held by another party is flagged `party_identity_conflict`, never rejected or auto-merged |
| `party_merge` | recorded decision with provenance (snapshots of both parties, device, HLC, actor); first merge wins, a conflicting later one is stored `applied=false` and flagged |
| `price_version` | effective-dated, append-only; `price_as_of()` picks the row in force (latest `effective_from`, then HLC) |
| `stock_movement` | append-only signed deltas; `stock_balance` is a trigger-maintained projection, never last-writer-wins; negative stock allowed, `oversold` generated column plus one open `oversold` flag per (store, product) that closes itself when stock recovers |
| `khata_entry`, `payment` | append-only events; `khata_balance` is a projection (sum of debits minus credits) |
| `invoice`, `purchase_receipt`, `credit_note` | immutable once finalised (device-scoped number series; `(series, number)` unique, a reused number is the one hard rejection); correction = credit note with mandatory reason |
| `order` / `order_transition` | state machine; transitions are append-only; an illegal one from the current state is recorded `applied=false` and flagged `order_transition_conflict`, not auto-applied |

Projections are written only by `SECURITY DEFINER` triggers (the API role has no write grant on them) and
`verify_projections()` recomputes them from the events; the tests assert it is always empty (mismatch 0, target <0.01%).

Quantities are integer milli-units and money integer paise; floats in a payload are rejected.

## Consequences
- Handlers are the extension point: a new entity is a handler + migration + a line in this table; `SchemaGuardIT` fails
  the build if the migration forgets `tenant_id`, FORCE RLS, composite FKs or the append-only trigger.
- Flags are a review queue (`GET /v1/sync/flags`, resolve with a note, audited). Resolved `oversold` flags are history of
  transient dips and depend on arrival order; open flags and balances do not.
- Measured (single Postgres 16, dev box): about 500 to 1,000 operations/s through the full path, a 100,500-operation
  backlog uploads in 2 to 3 minutes and its complete replay (all duplicates) in about 25 s. Set-based processing is the next step if
  this becomes the bottleneck.
- Actor claims are device-asserted (see ADR 0004), so permission checks on synced operations detect and flag, they do not prevent.
