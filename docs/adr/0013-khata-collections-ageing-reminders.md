# ADR 0013: Khata: collections, ageing, credit limit advice and consented reminders

Status: accepted (17 Oct 2026)

## Context
Credit sales already create a `khata_entry` debit (ADR 0010). The shopkeeper now needs to see who owes what, take
payments against that, and remind customers, offline, without breaking the append-only ledger rules.

## Decision
- **The ledger is the lines.** `khata_entry` is now part of the read model (sync rules + local schema), so a statement is
  a plain query and the running balance is computed from the lines. `khata_balance` stays the projection; a property
  test asserts balance = sum of lines. Every writer of a khata line goes through `khataEntryEffects`, which updates
  the balance and the statement row together (id = the op's entity id so the server row replaces it after sync).
- **A collection is two events in one local transaction:** a `payment` (direction in, linked to the customer, no
  invoice) and a `khata_entry` credit (`refType: payment`, `refId` = the payment). Cash also lands in the open shift's
  cash total (`recordCashMovement`, ADR 0010). A request id makes a double tap one payment. Paying more than owed is
  allowed and shows as an advance (negative balance).
- **No invoice allocation.** Payments reduce the customer's balance, not a particular bill. Ageing matches payments
  to the OLDEST open debt (FIFO), computed on read from the lines, so it can never disagree with the balance.
  Per-invoice settlement is a later slice if merchants need it.
- **Old balances** from a paper khata are a `khata_entry` debit with `refType: opening_balance`, never an edit.
- **Credit limit is advice.** The counter warns (text + icon) before a credit sale that crosses the limit and never
  blocks; the server mirrors it with a state-based `credit_limit_exceeded` review flag that closes when the balance is
  back under the limit. A sale that already happened is never rejected (ADR 0002).
- **Reminders need the customer's yes.** WhatsApp reminders are a consent purpose (`whatsapp_reminders`). The cashier
  records the customer's verbal yes (nothing pre-ticked); it is saved in the local `consent_outbox` first and flushed to
  `POST /v1/consent/events` when online (event id = idempotency key). Until the server has it, the device's own record
  answers "may I remind?". Withdrawal is as easy as granting. The shopkeeper sends each message with a tap (wa.me,
  queued offline) from their own phone; nothing is sent automatically.
- **Not in this slice:** write-offs / discounts on old balances (a credit that is not money needs an owner approval
  and a reason), per-bill settlement, statements as PDF, automatic reminder schedules.

## Consequences
- The consent record lives on the device until it syncs; consent given on another counter is not visible offline.
- Reminder text is generated from templates in `khata/reminder.ts` (English, Hindi); other languages follow the i18n
  keys when added.
