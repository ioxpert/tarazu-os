import type { Cart, CartLine, Discount, DocType, GstMode, PricedBill, PricedLine, TaxBreakupRow } from './types'
import { BillingError } from './errors'
import { assertSafe, divRoundHalfUp, mulDiv } from './money'
import { resolveTaxRule, type TaxRule } from './tax'

export interface PricingContext {
  gstMode: GstMode
  rounding: 'nearest_rupee' | 'none'
  /** Synced tax rules. When given, a line whose HSN resolves on `onDate` uses the rule rate (so a back-dated bill gets
   *  the rate in force on its date); otherwise the line's own taxRateBp is used. */
  rules?: readonly TaxRule[]
  /** Invoice date, 'YYYY-MM-DD' (IST). */
  onDate: string
}

export const DOC_TYPE_BY_MODE: Record<GstMode, DocType> = {
  regular: 'tax_invoice',
  composition: 'bill_of_supply',
  non_gst: 'retail_invoice',
}

/** Paise value of a discount against a base amount, never above the base. */
export function discountPaiseOf(discount: Discount | null, basePaise: number): number {
  if (discount === null) return 0
  if (discount.kind === 'percent') {
    if (!Number.isInteger(discount.bp) || discount.bp < 0 || discount.bp > 10000) throw new BillingError('invalid_discount')
    return mulDiv(basePaise, discount.bp, 10000)
  }
  if (!Number.isSafeInteger(discount.paise) || discount.paise < 0) throw new BillingError('invalid_discount')
  return Math.min(discount.paise, basePaise)
}

/**
 * Split `amount` over `weights` so the parts sum EXACTLY to amount (largest remainder). Part i never exceeds
 * weights[i] when amount <= sum(weights). Ties: bigger weight first, then lower index. BigInt keeps the products exact.
 */
export function prorate(amount: number, weights: readonly number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0)
  if (amount === 0 || total === 0) return weights.map(() => 0)
  const A = BigInt(amount)
  const T = BigInt(total)
  const parts = weights.map((w) => (A * BigInt(w)) / T)
  const rems = weights.map((w) => (A * BigInt(w)) % T)
  let left = Number(A - parts.reduce((a, b) => a + b, 0n))
  const order = weights
    .map((_, i) => i)
    .sort((i, j) => (rems[i] === rems[j] ? weights[j] - weights[i] || i - j : rems[i] > rems[j] ? -1 : 1))
  const out = parts.map(Number)
  for (const i of order) {
    if (left === 0) break
    if (rems[i] === 0n) break
    out[i] += 1
    left--
  }
  return out
}

function checkLine(l: CartLine): void {
  if (!Number.isSafeInteger(l.qtyMilli) || l.qtyMilli <= 0) throw new BillingError('invalid_quantity', l.lineId)
  if (!Number.isSafeInteger(l.unitPricePaise) || l.unitPricePaise < 0) throw new BillingError('invalid_price', l.lineId)
  if (!Number.isInteger(l.taxRateBp) || l.taxRateBp < 0 || l.taxRateBp > 10000) throw new BillingError('invalid_tax_rate', l.lineId)
}

/**
 * Price a cart. Pure and integer-only. Order of operations per line:
 *   gross = round(qty * price / 1000); lineDisc = line discount (<= gross); bill discount prorated over the line nets
 *   (largest remainder, sums exactly); net = gross - lineDisc - share;
 *   inclusive: tax = round(net * r / (10000 + r)), taxable = net - tax, lineTotal = net
 *   exclusive: tax = round(net * r / 10000), taxable = net, lineTotal = net + tax.
 * composition / non_gst merchants charge 0 tax. Header: subtotal = sum(taxable), tax = sum(tax),
 * roundOff to the nearest rupee (-50..+50), total = subtotal + tax + roundOff. Invariants (property-tested):
 * sum(lineTotal) = subtotal + tax and subtotal + tax + roundOff = total (ADR 0009: header discount is 0).
 * An empty cart prices to zero; a non-positive / fractional quantity or negative price throws a BillingError.
 */
export function priceCart(cart: Pick<Cart, 'lines' | 'billDiscount'>, ctx: PricingContext): PricedBill {
  const taxed = ctx.gstMode === 'regular'
  const grosses: number[] = []
  const lineDiscs: number[] = []
  const nets: number[] = []
  for (const l of cart.lines) {
    checkLine(l)
    const gross = mulDiv(l.qtyMilli, l.unitPricePaise, 1000)
    const disc = discountPaiseOf(l.discount, gross)
    grosses.push(gross)
    lineDiscs.push(disc)
    nets.push(gross - disc)
  }
  const netSum = assertSafe(nets.reduce((a, b) => a + b, 0), 'bill total')
  const billDisc = discountPaiseOf(cart.billDiscount, netSum)
  const shares = prorate(billDisc, nets)

  const lines: PricedLine[] = cart.lines.map((l, i) => {
    const discountPaise = lineDiscs[i] + shares[i]
    const net = grosses[i] - discountPaise
    let rateBp = 0
    if (taxed) {
      const rule = ctx.rules ? resolveTaxRule(ctx.rules, l.hsn, ctx.onDate) : null
      rateBp = rule ? rule.rateBp : l.taxRateBp
    }
    let taxPaise: number
    let taxablePaise: number
    let lineTotalPaise: number
    if (rateBp === 0) {
      taxPaise = 0
      taxablePaise = net
      lineTotalPaise = net
    } else if (l.taxInclusive) {
      taxPaise = mulDiv(net, rateBp, 10000 + rateBp)
      taxablePaise = net - taxPaise
      lineTotalPaise = net
    } else {
      taxPaise = mulDiv(net, rateBp, 10000)
      taxablePaise = net
      lineTotalPaise = net + taxPaise
    }
    return {
      lineNo: i + 1,
      productId: l.productId,
      hsn: l.hsn,
      qtyMilli: l.qtyMilli,
      unitPricePaise: l.unitPricePaise,
      grossPaise: grosses[i],
      discountPaise,
      taxRateBp: rateBp,
      taxPaise,
      taxablePaise,
      lineTotalPaise,
    }
  })

  const subtotalPaise = assertSafe(lines.reduce((a, l) => a + l.taxablePaise, 0), 'subtotal')
  const taxPaise = assertSafe(lines.reduce((a, l) => a + l.taxPaise, 0), 'tax')
  const exact = subtotalPaise + taxPaise
  const roundOffPaise = ctx.rounding === 'nearest_rupee' ? divRoundHalfUp(exact, 100) * 100 - exact : 0

  return {
    docType: DOC_TYPE_BY_MODE[ctx.gstMode],
    lines,
    subtotalPaise,
    taxPaise,
    discountPaise: lines.reduce((a, l) => a + l.discountPaise, 0),
    roundOffPaise,
    totalPaise: exact + roundOffPaise,
    taxBreakup: taxed ? taxBreakup(lines) : [],
  }
}

export function taxBreakup(lines: readonly PricedLine[]): TaxBreakupRow[] {
  const byRate = new Map<number, TaxBreakupRow>()
  for (const l of lines) {
    const row = byRate.get(l.taxRateBp) ?? { rateBp: l.taxRateBp, taxablePaise: 0, taxPaise: 0, cgstPaise: 0, sgstPaise: 0 }
    row.taxablePaise += l.taxablePaise
    row.taxPaise += l.taxPaise
    byRate.set(l.taxRateBp, row)
  }
  return [...byRate.values()]
    .sort((a, b) => a.rateBp - b.rateBp)
    .map((r) => ({ ...r, cgstPaise: Math.floor(r.taxPaise / 2), sgstPaise: r.taxPaise - Math.floor(r.taxPaise / 2) }))
}
