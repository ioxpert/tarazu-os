# Phase 1 gap slices: specs

Six small vertical slices, in build order. Each is one PR with tests, CI green. Source: the feature comparison against standard
kirana/retail billing software. Slices 1 to 4 read data already on the device and need no new tables, no OpenAPI change and no
server work. That keeps them inside locked rules 1 (sales never wait for the cloud), 2 (append-only) and 7 (one contract).

Shared constraints for every slice:
- Reads run against the local SQLite (`StateReader`), never the network. Screens work fully offline.
- Money is integer paise, quantity is milli-units, dates are IST for display and UTC for storage.
- No new write path unless the slice says so. A new write path means an `EntityOperationHandler`, a migration with
  `tarazu_enable_tenant_rls()` + `tarazu_make_append_only()`, an `openapi.yaml` schema and an ADR 0002 policy row.
- Screens are lazy chunks. First-load JS stays at or under 250 KB gzipped (`npm run size`).
- Strings go through `i18n/` in all four languages (en, hi, gu, pa).

---

## Slice 1: Invoice history and reprint

**Problem.** Only the last receipt is reprintable (ADR 0010). A customer who loses a bill, or a dispute the next day, has no answer.

**Scope**
- New route `#/history`, linked from Home.
- List invoices and credit notes newest first, grouped by day. Row: number, time, party name or "Walk-in", total, tender mode,
  a "returned" badge when a credit note references it.
- Filters: date range (today / yesterday / 7 days / custom), party, tender mode, doc type. Search by invoice number or party phone.
- Detail view: lines, tax breakup, payments, linked credit notes.
- Actions on detail: Print, Share (existing `print/share.ts`), Start return (jumps to `Returns` with the invoice preselected).
- Reprint rebuilds the receipt from `invoice` + `invoice_line` + `payment` and marks it "DUPLICATE COPY" in the header. It
  never rewrites `device_state last_receipt`.

**Data.** `invoice` (index `invoice_date_idx`), `invoice_line`, `payment`, `credit_note`, `party`. All synced, so another counter's
invoices appear after sync. Paginate 50 per page by `(invoice_date, series, number)` keyset, not offset.

**Out of scope.** Editing or cancelling an invoice (rule 2: corrections are credit notes). Server-side history API.

**Acceptance**
- Reprint of an invoice from 30 days ago matches the original receipt except the duplicate marker.
- List of 100k invoices opens first page in under 100 ms (NFR lookup P95).
- Works offline and in local-only mode.
- Test: seed invoices with returns and mixed tenders, assert the list, filters, keyset paging and the reprint layout snapshot.

---

## Slice 2: Reports and home dashboard

**Problem.** There is no sales, profit or stock report and no summary on Home. Owners cannot answer "how did today go".

**Scope**
- Home tiles for today: sales total, bill count, cash/UPI/card/credit split, khata outstanding, low-stock count.
- New route `#/reports` with these reports, each with a date range (today / week / month / custom) and an export button (slice 4):
  1. **Daily sales**: per day total, discount, tax, returns, net.
  2. **Item-wise sales**: qty, revenue, average price, margin where cost is known.
  3. **Profit**: revenue minus cost of goods sold. Cost = last purchase cost (the purchase slice already keeps last-cost for margin).
     Show a "cost missing" count rather than guessing.
  4. **Stock**: on-hand, value at cost, low-stock and negative (oversold) items.
  5. **Day book**: invoices, payments, khata collections, purchases and expenses-free cash movement in time order.
- Net sales always subtract credit notes in the same range, so a return appears on the day it was made.

**Data.** Computed on device from `invoice`, `invoice_line`, `credit_note`, `payment`, `stock_balance`, `khata_balance`.
Prefer SQL aggregates over loading rows into JS. If any report exceeds the 100 ms target on 100k invoices, add a local
summary table maintained inside the commit transaction, not a server table.

**Out of scope.** Charts beyond one sales-trend sparkline, multi-store consolidation, scheduled email reports.

**Acceptance**
- Totals reconcile: day book total equals daily sales + collections within one paise, checked by a property test (as for purchases).
- A returned item reduces net sales, item-wise revenue and profit consistently.
- Reports render with no network.
- Test: fixtures with mixed GST modes, discounts, returns, credit sales and missing cost.

---

## Slice 3: GST summary and HSN export

**Problem.** Accountants need GSTR-1 style data. Merchants currently send screenshots.

**Scope**
- Route `#/reports/gst` with a period picker (month, quarter).
- Sections:
  - **B2C summary** by rate: taxable, CGST, SGST, IGST, cess.
  - **B2B invoices** (party has a GSTIN): per invoice rows with place of supply.
  - **HSN summary**: HSN, description, UoM, qty, taxable, tax by rate.
  - **Credit notes** (reductions) shown separately and netted in totals.
  - **Bill of supply / non-GST** sales shown as a separate non-taxable line.
- Export as CSV and Excel in the layout the common GST offline tools accept, plus a printable PDF.
- Intra vs inter-state split uses business `stateCode` and the customer's state; unknown customer state is treated as intra-state
  and counted in a "assumed" note.

**Data.** `invoice`, `invoice_line`, `credit_note.lines`, `party` (GSTIN, state), `business` (GST mode, state), tax rules (ADR 0003).

**Prerequisite decision (ADR).** Cess is synced but not applied to line totals (ADR 0009). Either apply cess in billing first, or
this report states cess as not collected. Recommend a small billing slice for cess before this one ships to regular-GST merchants.

**Out of scope.** Filing, e-invoice IRN, e-way bills, GSTR-2/3B reconciliation, ITC. Those are Phase 2/3.

**Acceptance**
- Report totals equal the sum of invoices minus credit notes for the period, in paise, with rounding shown as its own line.
- A composition merchant sees bill-of-supply totals only, with no tax columns.
- HSN missing on a line lands in an "HSN missing" bucket with a count and a link to fix the item.
- Test: golden CSV fixtures for regular, composition and non-GST merchants.

---

## Slice 4: Data export and local backup

**Problem.** No way to export data or take a backup. ADR 0006 already promises an owner-initiated export on the device after revocation.

**Scope**
- Settings > Data: **Export** and **Backup now**.
- Export (owner PIN): CSV bundle (zip) of items, parties, invoices, invoice lines, payments, khata entries, stock movements,
  purchases. Also the shared export button used by slices 2 and 3 (CSV and Excel).
- Backup: a single file of the device database (op-log plus state) saved through the File System Access API where available,
  else a download. Include schema version and a checksum.
- Restore is read-only verification in this slice: "this file is valid, schema N, M operations". Actual restore into a live device is
  deferred, because replaying an op-log must keep operation ids and idempotency keys intact (rule 5).
- Every export and backup is written to `audit_log` via an op-log event so the owner can see who exported and when.

**Out of scope.** Cloud backup, scheduled backup, restore into a running device, PII redaction options.

**Acceptance**
- Export gated by owner PIN, including offline (ADR 0008 verifier).
- Exported invoice totals equal what the screen shows.
- A 100k-operation device exports without freezing the UI (stream in chunks, run in a worker).
- Test: round trip of the checksum and schema version; a corrupted file is rejected.

---

## Slice 5: Per-invoice khata settlement

**Problem.** A customer pays against "the balance". Merchants need to know which invoices are still open, and customers dispute
specific bills. ADR 0013 lists this as a later slice.

**Scope**
- In the khata statement, show each credit invoice as open, partly paid or paid, with the amount still due.
- **Collect** gains an optional "apply to" selector: oldest first (default, FIFO), or choose invoices.
- Settlement is a **new append-only link**, never an edit of the invoice or the khata entry. The `payment` table already has a
  nullable `invoice_id`; for one payment across several invoices add a `payment_allocation` table
  `(tenant_id, id, payment_id, invoice_id, amount_paise)`.
- Balance stays `sum(debit) - sum(credit)`; allocation only explains it. Unallocated money stays as "advance on account".
- Ageing (`ageing.ts`) switches from oldest-debit estimate to true per-invoice ageing once allocations exist, and falls back for
  history with none.

**Write path (rule: Syncing a new entity).**
- `EntityOperationHandler` in `ledger/`; migration with RLS and append-only; `openapi.yaml` schema `PaymentAllocation`;
  ADR 0002 policy row: append-only event, reject only structural problems (allocation over the payment amount), flag
  over-allocation to an invoice as `over_allocated`, do not reject it.
- Composite FKs `(tenant_id, payment_id)` and `(tenant_id, invoice_id)`.

**Out of scope.** Reversing an allocation (use a new correcting entry), discounts on settlement, interest.

**Acceptance**
- Sum of allocations for a payment never exceeds the payment amount on the device; the server flags if two offline counters
  collide.
- Two counters collecting against the same invoice offline both persist and flag `over_allocated` (ADR 0002 spirit).
- Existing customers with no allocations behave exactly as before.
- Tests against real Postgres for RLS and idempotent replay; device tests for FIFO and chosen-invoice allocation.

---

## Slice 6: Batch and expiry tracking (opt-in per item)

**Problem.** Pharmacy, dairy and packaged food need batch number, expiry and FEFO picking. Standard in competitors.

**Scope**
- Item flag `trackBatches` (default off, so kirana flow is unchanged).
- Purchase entry captures batch number, expiry, MRP and cost per line. Stock-in creates a batch row.
- Billing picks the earliest-expiry batch with stock (FEFO), cashier may override. Invoice line records the batch.
- Warnings: expired batch blocked unless owner approval (same approval path as discounts); near-expiry (configurable days) shown on
  Stock and on the dashboard.
- Stock screen shows per-batch quantity; item detail shows the batch ledger.

**Write path.** New `product_batch` and `stock_movement.batch_id` (nullable), `invoice_line.batch_id` (nullable). Migrations with
RLS, append-only movements, composite FKs. Conflict policy: stock stays a projection, so two counters can oversell a batch; that is
flagged `oversold`, not rejected.

**Out of scope.** Serial numbers, batch recalls, supplier batch returns, expiry-based pricing.

**Acceptance**
- With `trackBatches` off, behavior and performance are unchanged (commit P95 under 300 ms).
- Selling across two batches splits the line or lines correctly and the stock projection matches movements.
- Expired batch sale without approval is flagged, with approval it is audited.
- Tests: FEFO selection, projection mismatch under 0.01% property test, real-Postgres RLS.

---

## Open questions
1. Cess: apply in billing first (recommended) or report it as not collected?
2. Backup format: raw SQLite file or a versioned op-log dump? The op-log dump is safer for future restore.
3. Dashboard: is "profit" shown by default, or only to owner/accountant roles? Cashiers probably should not see cost. **Decided:** the counter has no role check, so cost and profit (and stock value at cost) open behind the owner PIN, as in ADR 0008. They ship in a follow-up change; this one has no cost data.
4. Do reports need store-level filtering now, given management permissions are tenant-wide (ADR 0004 known gap)?
