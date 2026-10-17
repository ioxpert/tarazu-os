import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { priceCart, prorate } from './calc'
import { line } from './testKit'
import type { CartLine, Discount, GstMode, PricedBill } from './types'

const RUNS = { numRuns: 1500 }
const CTX = { gstMode: 'regular' as GstMode, rounding: 'nearest_rupee' as const, onDate: '2026-10-17' }

const discountArb: fc.Arbitrary<Discount | null> = fc.oneof(
  fc.constant(null),
  fc.record({ kind: fc.constant('percent' as const), bp: fc.integer({ min: 0, max: 10000 }) }),
  fc.record({ kind: fc.constant('amount' as const), paise: fc.integer({ min: 0, max: 5_000_000 }) }),
)
const rateArb = fc.oneof(fc.constantFrom(0, 0, 500, 1200, 1800, 2800), fc.integer({ min: 0, max: 10000 }))
const lineArb: fc.Arbitrary<CartLine> = fc
  .record({
    qtyMilli: fc.integer({ min: 1, max: 5_000_000 }),
    unitPricePaise: fc.integer({ min: 0, max: 5_000_000 }),
    taxRateBp: rateArb,
    taxInclusive: fc.boolean(),
    discount: discountArb,
  })
  .map((o) => line(o))
const cartArb = fc.record({
  lines: fc.array(lineArb, { minLength: 1, maxLength: 12 }),
  billDiscount: discountArb,
})
const modeArb = fc.constantFrom<GstMode>('regular', 'composition', 'non_gst')

/** The two equations InvoiceHandler.review checks, re-implemented independently of calc.ts. */
function serverEquations(b: PricedBill): { lineSumOk: boolean; lineTaxOk: boolean; headerOk: boolean } {
  const lineSum = b.lines.reduce((a, l) => a + l.lineTotalPaise, 0)
  const lineTax = b.lines.reduce((a, l) => a + l.taxPaise, 0)
  const discountHeader = 0 // ADR 0009
  return {
    lineSumOk: lineSum === b.subtotalPaise + b.taxPaise,
    lineTaxOk: lineTax === b.taxPaise,
    headerOk: b.subtotalPaise + b.taxPaise - discountHeader + b.roundOffPaise === b.totalPaise,
  }
}

describe('priceCart properties', () => {
  it('(1) sum(lineTotal) == subtotal + tax', () => {
    fc.assert(
      fc.property(cartArb, modeArb, (cart, gstMode) => {
        const b = priceCart(cart, { ...CTX, gstMode })
        expect(b.lines.reduce((a, l) => a + l.lineTotalPaise, 0)).toBe(b.subtotalPaise + b.taxPaise)
      }),
      RUNS,
    )
  })

  it('(2) subtotal + tax + roundOff == total, |roundOff| <= 50, total % 100 == 0 under nearest_rupee', () => {
    fc.assert(
      fc.property(cartArb, modeArb, (cart, gstMode) => {
        const b = priceCart(cart, { ...CTX, gstMode })
        expect(b.subtotalPaise + b.taxPaise + b.roundOffPaise).toBe(b.totalPaise)
        expect(Math.abs(b.roundOffPaise)).toBeLessThanOrEqual(50)
        expect(b.totalPaise % 100).toBe(0)
        expect(b.totalPaise).toBeGreaterThanOrEqual(0)
      }),
      RUNS,
    )
  })

  it('rounding none leaves the exact total', () => {
    fc.assert(
      fc.property(cartArb, (cart) => {
        const b = priceCart(cart, { ...CTX, rounding: 'none' })
        expect(b.roundOffPaise).toBe(0)
        expect(b.totalPaise).toBe(b.subtotalPaise + b.taxPaise)
      }),
      RUNS,
    )
  })

  it('(3) discounts prorate exactly and never make a line negative', () => {
    fc.assert(
      fc.property(cartArb, (cart) => {
        const b = priceCart(cart, CTX)
        for (const l of b.lines) {
          expect(l.discountPaise).toBeGreaterThanOrEqual(0)
          expect(l.discountPaise).toBeLessThanOrEqual(l.grossPaise)
          expect(l.lineTotalPaise).toBeGreaterThanOrEqual(0)
          expect(l.taxablePaise).toBeGreaterThanOrEqual(0)
        }
        // total discount == sum of line discounts + the bill discount the cashier asked for (capped at what is left)
        const lineOnly = priceCart({ lines: cart.lines, billDiscount: null }, CTX)
        const net = lineOnly.lines.reduce((a, l) => a + l.grossPaise - l.discountPaise, 0)
        const asked =
          cart.billDiscount === null
            ? 0
            : cart.billDiscount.kind === 'amount'
              ? Math.min(cart.billDiscount.paise, net)
              : Math.round((net * cart.billDiscount.bp) / 10000 - 1e-9) // approx, checked within 1 below
        expect(b.discountPaise - lineOnly.discountPaise).toBeGreaterThanOrEqual(0)
        if (cart.billDiscount?.kind === 'amount') expect(b.discountPaise - lineOnly.discountPaise).toBe(asked)
        if (cart.billDiscount?.kind === 'percent') {
          expect(Math.abs(b.discountPaise - lineOnly.discountPaise - asked)).toBeLessThanOrEqual(1)
        }
      }),
      RUNS,
    )
  })

  it('prorate: parts sum exactly, never exceed their weight, deterministic', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 1_000_000 }), { minLength: 1, maxLength: 15 }), fc.nat(1_000_000), (w, a) => {
        const total = w.reduce((x, y) => x + y, 0)
        const amount = Math.min(a, total)
        const parts = prorate(amount, w)
        expect(parts.reduce((x, y) => x + y, 0)).toBe(amount)
        parts.forEach((p, i) => {
          expect(p).toBeGreaterThanOrEqual(0)
          expect(p).toBeLessThanOrEqual(w[i])
        })
        expect(prorate(amount, w)).toEqual(parts)
      }),
      RUNS,
    )
  })

  it('(4) inclusive: taxable + tax == net for every line and tax in [0, net]', () => {
    fc.assert(
      fc.property(
        fc.array(lineArb.map((l) => ({ ...l, taxInclusive: true })), { minLength: 1, maxLength: 10 }),
        discountArb,
        (lines, billDiscount) => {
          const b = priceCart({ lines, billDiscount }, CTX)
          for (const l of b.lines) {
            const net = l.grossPaise - l.discountPaise
            expect(l.taxablePaise + l.taxPaise).toBe(net)
            expect(l.lineTotalPaise).toBe(net)
            expect(l.taxPaise).toBeGreaterThanOrEqual(0)
            expect(l.taxPaise).toBeLessThanOrEqual(net)
          }
        },
      ),
      RUNS,
    )
  })

  it('exclusive: lineTotal == net + tax and taxable == net', () => {
    fc.assert(
      fc.property(fc.array(lineArb.map((l) => ({ ...l, taxInclusive: false })), { minLength: 1, maxLength: 10 }), (lines) => {
        const b = priceCart({ lines, billDiscount: null }, CTX)
        for (const l of b.lines) {
          expect(l.taxablePaise).toBe(l.grossPaise - l.discountPaise)
          expect(l.lineTotalPaise).toBe(l.taxablePaise + l.taxPaise)
        }
      }),
      RUNS,
    )
  })

  it('(5) zero-rate lines and non-GST / composition bills have no tax', () => {
    fc.assert(
      fc.property(cartArb, fc.constantFrom<GstMode>('composition', 'non_gst'), (cart, gstMode) => {
        const b = priceCart(cart, { ...CTX, gstMode })
        expect(b.taxPaise).toBe(0)
        expect(b.taxBreakup).toEqual([])
        expect(b.docType).toBe(gstMode === 'composition' ? 'bill_of_supply' : 'retail_invoice')
        b.lines.forEach((l) => expect([l.taxPaise, l.taxRateBp]).toEqual([0, 0]))
      }),
      RUNS,
    )
    fc.assert(
      fc.property(fc.array(lineArb.map((l) => ({ ...l, taxRateBp: 0 })), { minLength: 1, maxLength: 8 }), (lines) => {
        expect(priceCart({ lines, billDiscount: null }, CTX).taxPaise).toBe(0)
      }),
      RUNS,
    )
  })

  it('(6) satisfies BOTH server equations for every mode', () => {
    fc.assert(
      fc.property(cartArb, modeArb, fc.constantFrom('nearest_rupee' as const, 'none' as const), (cart, gstMode, rounding) => {
        const b = priceCart(cart, { ...CTX, gstMode, rounding })
        expect(serverEquations(b)).toEqual({ lineSumOk: true, lineTaxOk: true, headerOk: true })
      }),
      RUNS,
    )
  })

  it('(7) line order does not change the totals (exact without a bill discount, within 1 paise per line with one)', () => {
    fc.assert(
      fc.property(cartArb, fc.integer(), (cart, seed) => {
        const rotated = { ...cart, lines: [...cart.lines.slice(seed % cart.lines.length === 0 ? 0 : Math.abs(seed) % cart.lines.length), ...cart.lines.slice(0, Math.abs(seed) % cart.lines.length)] }
        const reversed = { ...cart, lines: [...cart.lines].reverse() }
        const a = priceCart(cart, CTX)
        for (const other of [rotated, reversed]) {
          const b = priceCart(other, CTX)
          if (cart.billDiscount === null) {
            expect([b.subtotalPaise, b.taxPaise, b.totalPaise]).toEqual([a.subtotalPaise, a.taxPaise, a.totalPaise])
          } else {
            expect(Math.abs(b.subtotalPaise + b.taxPaise - (a.subtotalPaise + a.taxPaise))).toBeLessThanOrEqual(cart.lines.length)
          }
        }
      }),
      RUNS,
    )
  })

  it('(8) zero / negative / fractional quantities and negative prices are refused', () => {
    for (const qtyMilli of [0, -1, 1.5, NaN, Infinity]) {
      expect(() => priceCart({ lines: [line({ qtyMilli, unitPricePaise: 100 })], billDiscount: null }, CTX)).toThrow(/invalid_quantity/)
    }
    expect(() => priceCart({ lines: [line({ qtyMilli: 1000, unitPricePaise: -1 })], billDiscount: null }, CTX)).toThrow(/invalid_price/)
    expect(() => priceCart({ lines: [line({ qtyMilli: 1000, unitPricePaise: 100, taxRateBp: 10001 })], billDiscount: null }, CTX)).toThrow(
      /invalid_tax_rate/,
    )
    expect(() => priceCart({ lines: [line({ qtyMilli: 1000, unitPricePaise: 100, discount: { kind: 'amount', paise: -5 } })], billDiscount: null }, CTX)).toThrow(
      /invalid_discount/,
    )
    expect(() => priceCart({ lines: [line({ qtyMilli: 1000, unitPricePaise: 100 })], billDiscount: { kind: 'percent', bp: 10001 } }, CTX)).toThrow(
      /invalid_discount/,
    )
  })
})

describe('priceCart examples', () => {
  it('prices a tax-inclusive 18% line like a MRP-style bill', () => {
    // 2 x Rs 118 inclusive of 18% GST: net 23600, tax = 23600*1800/11800 = 3600
    const b = priceCart({ lines: [line({ qtyMilli: 2000, unitPricePaise: 11800, taxRateBp: 1800 })], billDiscount: null }, CTX)
    expect(b.lines[0]).toMatchObject({ grossPaise: 23600, taxPaise: 3600, taxablePaise: 20000, lineTotalPaise: 23600 })
    expect(b).toMatchObject({ subtotalPaise: 20000, taxPaise: 3600, roundOffPaise: 0, totalPaise: 23600, docType: 'tax_invoice' })
    expect(b.taxBreakup).toEqual([{ rateBp: 1800, taxablePaise: 20000, taxPaise: 3600, cgstPaise: 1800, sgstPaise: 1800 }])
  })

  it('exclusive price adds tax on top and rounds to the rupee', () => {
    // 1 x Rs 99.99 + 5% = 9999 + 500 = 10499 -> 10500, roundOff +1
    const b = priceCart({ lines: [line({ qtyMilli: 1000, unitPricePaise: 9999, taxRateBp: 500, taxInclusive: false })], billDiscount: null }, CTX)
    expect(b).toMatchObject({ subtotalPaise: 9999, taxPaise: 500, roundOffPaise: 1, totalPaise: 10500 })
  })

  it('splits a bill discount over lines by largest remainder, and tax follows the discounted value', () => {
    const lines = [
      line({ qtyMilli: 1000, unitPricePaise: 1000 }),
      line({ qtyMilli: 1000, unitPricePaise: 1000 }),
      line({ qtyMilli: 1000, unitPricePaise: 1000 }),
    ]
    const b = priceCart({ lines, billDiscount: { kind: 'amount', paise: 100 } }, CTX)
    expect(b.lines.map((l) => l.discountPaise).sort()).toEqual([33, 33, 34])
    expect(b.discountPaise).toBe(100)
    expect(b.subtotalPaise).toBe(2900)
  })

  it('a rule from the tax table overrides the line rate on the bill date; no rule keeps the line rate', () => {
    const rules = [
      { hsnPrefix: '1006', rateBp: 500, cessBp: 0, effectiveFrom: '2020-01-01' },
      { hsnPrefix: '1006', rateBp: 1200, cessBp: 0, effectiveFrom: '2026-12-01' },
    ]
    const l = line({ qtyMilli: 1000, unitPricePaise: 10500, hsn: '10061010', taxRateBp: 1800 })
    expect(priceCart({ lines: [l], billDiscount: null }, { ...CTX, rules }).lines[0].taxRateBp).toBe(500)
    expect(priceCart({ lines: [l], billDiscount: null }, { ...CTX, rules, onDate: '2026-12-02' }).lines[0].taxRateBp).toBe(1200)
    expect(priceCart({ lines: [{ ...l, hsn: '99' }], billDiscount: null }, { ...CTX, rules }).lines[0].taxRateBp).toBe(1800)
  })

  it('empty cart prices to zero', () => {
    expect(priceCart({ lines: [], billDiscount: null }, CTX)).toMatchObject({ totalPaise: 0, subtotalPaise: 0, lines: [] })
  })
})
