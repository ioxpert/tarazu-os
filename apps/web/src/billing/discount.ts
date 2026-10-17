import type { BillingPolicy } from './policy'
import type { PricedBill } from './types'

export interface DiscountEvaluation {
  /** Line discounts plus the prorated bill discount, paise. */
  totalDiscountPaise: number
  /** totalDiscount as basis points of the bill gross, rounded half-up (display). */
  percentBp: number
  /** True when the discount is strictly above policy.maxCashierDiscountBp of the bill gross (exact integer compare). */
  needsApproval: boolean
}

/** Bill gross = sum of qty x price before any discount. Discount at exactly the limit needs no approval. */
export function evaluateDiscount(bill: Pick<PricedBill, 'lines'>, policy: Pick<BillingPolicy, 'maxCashierDiscountBp'>): DiscountEvaluation {
  const gross = bill.lines.reduce((a, l) => a + l.grossPaise, 0)
  const discount = bill.lines.reduce((a, l) => a + l.discountPaise, 0)
  if (discount <= 0 || gross <= 0) return { totalDiscountPaise: Math.max(discount, 0), percentBp: 0, needsApproval: false }
  const d = BigInt(discount)
  const g = BigInt(gross)
  return {
    totalDiscountPaise: discount,
    percentBp: Number((d * 10000n * 2n + g) / (g * 2n)),
    needsApproval: d * 10000n > BigInt(policy.maxCashierDiscountBp) * g,
  }
}

/** True when the invoice date is before today's IST date and the policy asks for approval of back-dated bills. */
export function needsBackdateApproval(invoiceDate: string, todayIst: string, policy: Pick<BillingPolicy, 'requireApprovalBackdate'>): boolean {
  return policy.requireApprovalBackdate && invoiceDate < todayIst
}
