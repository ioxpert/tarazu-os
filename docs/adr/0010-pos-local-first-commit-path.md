# ADR 0010: POS commit path, local state and screen architecture

Status: accepted (17 Oct 2026)

## Context
Rule 1: a completed sale never waits for the cloud or an AI service. The counter must bill on a 2 GB Android Chrome
PWA and a Windows PC with no network, restart offline, and keep first-load JS under 250 KB gzip.

## Decision
- **One transaction per business event.** `OpLogWriter.writeAllWith` builds the ops inside the SQLite write
  transaction: next invoice number, op_log rows (invoice, one stock_movement per line, one payment per non-credit
  tender, one khata_entry for the credit part) and their optimistic read-model rows commit together or not at all.
  The number counter (`device_state seq:<series>`) lives in the same transaction, so numbers are gapless per series
  and a failed commit consumes none. A client `requestId` (`device_state sale_req:<id>`) makes a double tap return the
  first invoice instead of a second one.
- **Series.** `<first 8 hex of device id, upper>-<financial year>` (credit notes add `CN`). Device-scoped, so two
  counters never collide and numbers are never renumbered after sync.
- **Drafts stay local.** The bill being built is an in-memory store (undo stack of 30); held bills are rows in the
  local-only `held_bill` table. Only a finalised invoice becomes an operation.
- **Settings are device state.** Merchant profile, discount policy, printer and language are JSON in `device_state`.
  The server fills business name, GST mode, GSTIN and UPI ID when the device is online (`GET /v1/identity/me`).
- **Offline approvals** use cached owner PIN verifiers (ADR 0008); the approval travels on the invoice or credit note.
- **Catalogue in memory.** The whole catalogue (tens of thousands of rows at most) is loaded into a phonetic search
  index at start and patched after each sale (only the sold products are re-read). Lookup does not touch SQLite.
- **Shift cash** is tracked per device in `device_state shift_cash:<id>` inside the same transaction as each cash
  payment, because the synced `payment` table has no device column. Any future code that writes a cash payment must
  call `recordCashMovement`.
- **Bundle.** Home, i18n (English) and the router are the only eager code (~106 KB gz first load). Every other screen,
  the Hindi bundle, starter packs, printing, QR, camera scanning and PowerSync are lazy chunks, precached by the
  service worker. Hash routing, no router dependency.
- **Receipts** are stored whole in `device_state last_receipt` after the sale commits, so printing and sharing work
  after a reload. Printing is never in the commit path.

## Consequences
- Re-installing a device resets `seq:<series>`; the server then rejects reused numbers (`duplicate_invoice_number`).
  A server-side resume point is needed before device re-registration ships (open question).
- Only the last receipt is reprintable from the receipt screen; reprint-by-invoice from history is a later slice.
- The browser perf suite (`npm run e2e`) measures commit and search on real SQLite WASM; unit tests use `node:sqlite`.
