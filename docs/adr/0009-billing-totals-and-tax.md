# ADR 0009: Billing totals, tax, returns, cash shifts and the product master

Status: accepted (17 Oct 2026)

## Context
The counter computes every bill offline and the server only audits it (an invoice that already happened is applied and
flagged, never rejected). Both sides therefore need one set of exact integer rules, so a correct bill never raises a
false `total_mismatch` and a wrong one is always caught. Money is bigint paise, quantity is milli-units of the product's
BASE unit (1000 = one base unit), price is paise per base unit, tax rates are basis points. No floats on a money path.

## Decision
### Discounts and totals
- Every discount, line-level or bill-level, ends up as a per-line `discountPaise`, so tax is always computed on the
  discounted value. A bill-level discount is prorated over the line net amounts by largest remainder (the sum is exact).
- The invoice header `discountPaise` is written as 0. The server equation `total = subtotal + tax - discount + roundOff`
  stays valid because the lines already carry the discount. (The server still reads a non-zero header discount for old
  data and other clients.)
- gross = round(qtyMilli x unitPrice / 1000); net = gross - discount. Rounding is half-up on integers.
- Tax-inclusive price (the default, MRP style): tax = round(net x r / (10000 + r)), taxable = net - tax.
  Tax-exclusive: tax = round(net x r / 10000), lineTotal = net + tax.
- `subtotalPaise` = sum of taxable values, `taxPaise` = sum of line tax, `lineTotalPaise` = taxable + tax.
  The server checks `sum(lineTotal) = subtotal + tax` and `subtotal + tax - discount + roundOff = total`.
- Cash rounding: the payable total is rounded to the nearest rupee; `roundOffPaise` = rounded total - exact total
  (-50..+50) and is a separate line on the invoice, never folded into tax.

### Which tax rate
Fallback order for a line: (1) the server tax rule, longest `hsn_prefix` match with the latest `effective_from` on or
before the bill date (same rule as `TaxRules.resolve`, synced to the device as the global `tax_rule` table);
(2) the product's own `taxRateBp`; (3) 0. The source is recorded on the line. The server flags `tax_rate_mismatch` only
when a rule exists and differs from the rate charged (regular GST, tax invoice).

### GST mode
`regular` issues a `tax_invoice`; `composition` charges no tax and issues a `bill_of_supply`; `non_gst` charges no tax and
issues a `retail_invoice`. Violations are flagged (`composition_requires_bill_of_supply`, `composition_tax_charged`,
`tax_invoice_without_gst_registration`), not rejected.

### Returns
A return is a `credit_note`, never an edit of the invoice. Typed lines carry `invoiceLineNo`, `qtyMilli`, `taxRateBp`,
`taxPaise`, `lineTotalPaise`. Tax is reversed at the rate that was INVOICED, not today's rate, and each line total is
prorated from the original line total with the last unit taking the remainder, so a full return reverses the invoice
exactly. The server cross-checks and flags (never rejects): `credit_note_total_mismatch` (total <> sum of lines),
`credit_note_invalid_line` (unknown invoice line or non-positive quantity), `return_exceeds_sold` (cumulative returned
quantity of an invoice line, across all credit notes, above the invoiced quantity), `credit_exceeds_invoice`
(cumulative value) and `approval_required`. The refund is a `payment` with direction `out`, or a khata credit entry.

### Cash shifts and variance
`shift` opens a drawer on a device with the counted float; `shift_close` closes it once (a second close for the same
shift is rejected `shift_already_closed`). Expected cash is recomputed on the SERVER as
`opening + sum(cash payments in) - sum(cash payments out)` over payments of the shift's device whose `occurred_at` is in
`[opened_at, closed_at]`. The row stores the server's `expected_cash_paise`, the device's figure
(`client_expected_cash_paise`) and `variance_paise = declared - expected` as plain columns (append-only, never
recomputed). A close is never rejected for money: `cash_variance` is flagged whenever declared <> expected and
`shift_expected_mismatch` when device and server disagree (typically payments not yet synced); `shift.closed` is audited.
Card, UPI and credit-to-khata sales never enter the drawer.

### Product master
`master_product` (barcode primary key, name, local name, brand, category, HSN, MRP, unit, UOM) is platform-owned reference
data served by `GET /v1/catalogue/master/{barcode}` to pre-fill the add-item form. It is the SECOND global table beside
`tax_rule` (ADR 0003): no `tenant_id`, `FORCE ROW LEVEL SECURITY` with a read-all policy, written by ops through the
migration/admin role, `SELECT` only for the API role. Rule 3 (every table has `tenant_id`) is therefore relaxed for
exactly these tables, and `SchemaGuardIT` lists them by name so a third one cannot appear unnoticed. No merchant data is
ever written into it (rule 10).

### Smaller decisions in the same slice
- Product barcodes are not unique: a second active product with the same barcode is applied and flagged
  `duplicate_barcode`; the flag closes when the barcode changes or one holder is deactivated.
- A `customer` price (`price_version.price_type = 'customer'`, `party_id` required, forbidden for every other type) is an
  effective-dated negotiated rate per base unit, resolved by `price_as_of_party`.
- The merchant UPI address (`business.upi_vpa`) is owner-only to write and audited.

## Consequences
- The client and `InvoiceHandler` share one definition of the arithmetic; a property test on each side should assert the
  two equations on random baskets.
- Header discount 0 loses the "bill discount" figure as a header field; reports derive it as the sum of line discounts.
- A shift close can show a variance only because a payment had not synced yet; the owner sees both figures in the flag
  and the flag stays visible until resolved.
- Rounding to the rupee is a policy for cash; a future per-merchant option (no rounding, nearest 50 paise) needs a field,
  not a code change.

## Open questions
- Expected cash for devices that share one drawer, and shifts that span midnight or were never closed.
- Whether UPI/card refunds above a limit also need owner approval.
- Whether `tax_rate_mismatch` should apply to composition and non-GST merchants who record an HSN.
- Cess: `tax_rule.cess_bp` is synced but not yet applied to line totals.
- Source of the master data (licensed catalogue, crowd-sourced from consenting merchants) and its update cadence.

## Addendum: unapproved discount band (server)
The counter lets a cashier give up to `policy.maxCashierDiscountBp` (default 5% of gross, editable in Settings) without
a PIN. The server now flags `approval_required` for a discount only above `tarazu.billing.max-unapproved-discount-bp`
(default 500) or for a back-dated bill. Before this change any discount without an approval was flagged, so every
in-policy cashier discount raised a false review item. The policy is still device-local; syncing it as a tenant setting
is an open question in the PR.
