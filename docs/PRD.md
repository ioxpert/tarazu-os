# Tarazu OS: product requirements

The living PRD (v1.1, web-first) is maintained as a Claude Doc:
https://claude.ai/code/artifact/55bc8dba-c6b3-460f-9fb8-14755bdda194

Export a snapshot to this file at each phase gate so code review can reference a fixed version.

## Decisions that shape the code (from the PRD)
- Local-first: the device database is the system of record; Postgres in India is the merge point.
- Web first (React PWA on Chrome/Edge: Windows counters and Android), Capacitor Android/iOS apps later from the same code.
- One Java 21 / Spring Boot modular monolith, one OpenAPI contract, self-hosted PowerSync for sync.
- Phase 1 (weeks 0-10): counter MVP for kirana and convenience stores. Phase 2: wholesaler module. Phase 3: channels and finance groundwork.
- Phase 1 exit includes a PWA hardware matrix (USB scanner, 80 mm and Bluetooth printers, camera scan) and a 30-day offline soak.

## Phase 1 foundation: binding decisions (from the foundation brief; the live PRD wins if it differs)
- **Sync**: device is the transaction plane (SQLite WASM via PowerSync Web SDK on OPFS in a SharedWorker), India cloud is the sync/control plane. A sale never waits for the cloud or AI. PowerSync bucket key = merchant id; transactional outbox in Postgres.
- **Operation log fields on every synced write**: UUIDv7 `operation_id`, tenant/store/device ids, local sequence, HLC timestamp, idempotency key, schema version. The server validates, is idempotent and acknowledges operation ids.
- **Conflict policy per entity**: sales invoice and purchase receipt are immutable after finalisation (corrections via return/credit note; device-scoped number series). Payment, khata entry and stock movement are append-only events (stock and balance are projections, never last-writer-wins). Product name is field-level latest. Prices/schemes are effective-dated. Party merge keeps provenance (phone/GSTIN conflicts are flagged for review). Orders are state machines with append-only transitions (a conflicting later transition is flagged, not auto-applied). Two offline counters selling the last 3 units both persist; stock shows -3 with an "oversold" flag. See ADR 0002.
- **Sync states shown to the merchant**: "saved on this device" / "backed up" / "action required". Must support at least 30 days or 100,000 unsynced operations.
- **Identity**: tenant > business > store > device > user; roles owner, manager, cashier, purchaser, accountant, sales rep, delivery agent; PIN per staff; owner PIN for voids, discounts and backdating; device revoke effective at next sync; audit log (actor, reason, timestamp); no hard delete of finalised documents. See ADR 0004.
- **Consent**: purpose-specific, nothing pre-selected, withdrawal, third-party sharing log; local-only mode.
- **GST**: GST/non-GST mode; server-controlled, effective-dated rule tables (HSN, rates, thresholds) so rate changes need no app release; composition merchants get a bill of supply. See ADR 0003.
- **NFRs**: invoice commit P95 < 300 ms locally; lookup P95 < 100 ms; P95 convergence < 60 s; zero duplicate invoices; projection mismatch < 0.01%; first-load JS <= 250 KB gzipped (SQLite WASM and voice lazy-loaded).
