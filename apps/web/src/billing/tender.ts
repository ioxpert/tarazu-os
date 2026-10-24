import { assertSafeCardReference } from './card'
import { BillingError } from './errors'
import type { Tender } from './types'

export interface Payment {
  mode: 'cash' | 'upi' | 'card'
  /** Amount APPLIED to the bill (change is never a payment). */
  amountPaise: number
  reference: string | null
}

export interface Settlement {
  payments: Payment[]
  creditPaise: number
  changeDuePaise: number
  /** Cash handed over by the customer (before change). */
  cashTenderedPaise: number
}

/**
 * Validate tenders against the amount due and split them into payments, a credit part and change.
 *  - amounts are non-negative integers; zero tenders are ignored; a card reference must not be a card number
 *  - sum(tenders) must reach the total ('tender_short'); an excess is CHANGE and can only be given back out of cash
 *    ('tender_excess' if it is more than the cash tendered), so UPI / card / credit can never be over-tendered
 *  - credit needs a named customer ('credit_needs_customer')
 *  - one payment per upi/card tender, one cash payment of (cash tendered - change), one credit amount
 */
export function settleTenders(totalPaise: number, tenders: readonly Tender[], hasParty: boolean): Settlement {
  let cash = 0
  let credit = 0
  let sum = 0
  const payments: Payment[] = []
  for (const t of tenders) {
    if (!Number.isSafeInteger(t.amountPaise) || t.amountPaise < 0) throw new BillingError('invalid_tender')
    if (!['cash', 'upi', 'card', 'credit'].includes(t.mode)) throw new BillingError('invalid_tender')
    const reference = t.mode === 'card' ? assertSafeCardReference(t.reference) : (t.reference?.trim() || null)
    if (t.amountPaise === 0) continue
    sum += t.amountPaise
    if (t.mode === 'cash') cash += t.amountPaise
    else if (t.mode === 'credit') credit += t.amountPaise
    else payments.push({ mode: t.mode, amountPaise: t.amountPaise, reference })
  }
  if (sum < totalPaise) throw new BillingError('tender_short')
  if (credit > 0 && !hasParty) throw new BillingError('credit_needs_customer')
  const change = sum - totalPaise
  if (change > cash) throw new BillingError('tender_excess')
  const appliedCash = cash - change
  if (appliedCash > 0) payments.unshift({ mode: 'cash', amountPaise: appliedCash, reference: null })
  return { payments, creditPaise: credit, changeDuePaise: change, cashTenderedPaise: cash }
}

/**
 * Cash amounts a customer is likely to hand over for `duePaise`, smallest first: the next 10, 50, 100 and 500 rupees
 * above the amount due, then the next 2000 note, without repeats. Never includes the exact amount (that has its own
 * button) and never suggests less than is due.
 */
export function cashSuggestions(duePaise: number): number[] {
  if (!Number.isInteger(duePaise) || duePaise <= 0) return []
  const out: number[] = []
  for (const step of [1_000, 5_000, 10_000, 50_000, 200_000]) {
    const next = Math.ceil(duePaise / step) * step
    const amount = next === duePaise ? next + step : next
    if (!out.includes(amount)) out.push(amount)
  }
  return out.slice(0, 4)
}
