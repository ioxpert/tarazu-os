# ADR 0014: Purchase entry, stock-in, supplier payable and stock count

Status: accepted (17 Oct 2026)

## Decision
- **One local transaction per bill received** (`purchase/commit.ts`): the `purchase_receipt` (next number of this device's
  `<device>-PR-<FY>` series, gapless like invoices, ADR 0010), one `stock_movement` (reason `purchase`) per line, a new
  `price_version` of type `purchase` for each product whose cost changed, a `payment` (direction out) for money handed
  over now, and a `khata_entry` credit on the supplier for what is still owed. A request id makes a double tap one receipt.
- **Units.** Lines are stored in the product's BASE unit (qty in milli-units, cost per base unit, tax-inclusive), like
  sales. The screen lets the shopkeeper type "2 cartons at ₹960 per carton"; it converts through the product's UOM chain.
- **Supplier payable reuses the khata ledger** instead of a second ledger: a supplier is a `party` of type `supplier`
  and the balance sign says who owes: positive = they owe you (customers), negative = you owe them. Buying on credit is a
  credit entry, paying the supplier a payment out plus a debit entry. No new table or migration. Customer lists show
  customers/both, supplier lists suppliers/both.
- **Cost is the last purchase price**, not a weighted average. Margin hints compare selling price with that cost and warn
  (text + icon) when a product sells below cost. Weighted-average cost and batch/expiry need their own design.
- **A bill that does not add up is flagged, never refused** (`purchase_total_mismatch`): the goods are already on the
  shelf (ADR 0002). Lines must point at known products (an unknown product defers the receipt like any other document).
- **Stock count** (`purchase/stockCount.ts`) writes only the DIFFERENCE between the typed quantity and the books as one
  movement (`adjustment`, or `damage` for lost stock). The books' quantity is read inside the transaction. Stock is never
  overwritten and a matching count writes nothing.
- **Cash** paid to a supplier leaves the open shift (`recordCashMovement`, ADR 0010).

## Not in this slice
Purchase returns to the supplier (a new document, `purchase_return` movements), purchase orders, GST input-credit
reporting (tax is not split on purchases yet), batch/expiry, editing a saved receipt (a mistake is a correcting
movement or a return), supplier statements as PDF, reorder levels and suggestions.
