import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { formatQty, formatQtyNumber, formatRupees, groupIndian, parseRupeesToPaise } from './numfmt'

describe('formatRupees', () => {
  it('uses Indian grouping with paise', () => {
    expect(formatRupees(123456750)).toBe('₹12,34,567.50')
    expect(formatRupees(0)).toBe('₹0.00')
    expect(formatRupees(5)).toBe('₹0.05')
    expect(formatRupees(99999)).toBe('₹999.99')
    expect(formatRupees(100000)).toBe('₹1,000.00')
    expect(formatRupees(10000000)).toBe('₹1,00,000.00')
    expect(formatRupees(1000000000)).toBe('₹1,00,00,000.00')
  })
  it('supports a different symbol, auto paise and negatives', () => {
    expect(formatRupees(123456750, { symbol: 'Rs ' })).toBe('Rs 12,34,567.50')
    expect(formatRupees(250000, { paise: 'auto' })).toBe('₹2,500')
    expect(formatRupees(250050, { paise: 'auto' })).toBe('₹2,500.50')
    expect(formatRupees(-123400)).toBe('-₹1,234.00')
    expect(formatRupees(1, { symbol: '' })).toBe('0.01')
  })
  it('refuses non-integers', () => {
    expect(() => formatRupees(1.5)).toThrow()
  })
})

describe('groupIndian property', () => {
  const group = (n: number) => groupIndian(String(n))
  it('removing commas gives the digits back, last group is 3 digits, others 2', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), (n) => {
        const g = group(n)
        expect(g.replace(/,/g, '')).toBe(String(n))
        const parts = g.split(',')
        if (parts.length > 1) {
          expect(parts[parts.length - 1]).toHaveLength(3)
          parts.slice(1, -1).forEach((p) => expect(p).toHaveLength(2))
          expect(parts[0].length).toBeGreaterThanOrEqual(1)
          expect(parts[0].length).toBeLessThanOrEqual(2)
        } else {
          expect(g.length).toBeLessThanOrEqual(3)
        }
      }),
      { numRuns: 2000 },
    )
  })
  it('formatRupees then parseRupeesToPaise round-trips', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 9_000_000_000_000_000 }), (p) => {
        expect(parseRupeesToPaise(formatRupees(p))).toBe(p)
        expect(parseRupeesToPaise(formatRupees(p, { symbol: 'Rs ' }))).toBe(p)
        expect(parseRupeesToPaise(formatRupees(p, { symbol: '', paise: 'auto' }))).toBe(p)
      }),
      { numRuns: 2000 },
    )
  })
})

describe('parseRupeesToPaise (strict)', () => {
  it('accepts clean amounts', () => {
    expect(parseRupeesToPaise('12')).toBe(1200)
    expect(parseRupeesToPaise('12.5')).toBe(1250)
    expect(parseRupeesToPaise('12.50')).toBe(1250)
    expect(parseRupeesToPaise('0.05')).toBe(5)
    expect(parseRupeesToPaise(' ₹1,234.00 ')).toBe(123400)
    expect(parseRupeesToPaise('Rs 12,34,567.50')).toBe(123456750)
    expect(parseRupeesToPaise('1,234,567')).toBe(123456700)
  })
  it('rejects everything else', () => {
    for (const bad of ['', ' ', '.5', '5.', '-5', '+5', '1.234', '1,2', '12,34', '1e3', 'abc', '1 000', '₹', '1..2', '0x10', '1,234,56', '99999999999999999999'])
      expect(parseRupeesToPaise(bad), bad).toBeNull()
  })
})

describe('formatQty', () => {
  it('trims zeros and keeps up to 3 decimals', () => {
    expect(formatQtyNumber(1500)).toBe('1.5')
    expect(formatQtyNumber(12000)).toBe('12')
    expect(formatQtyNumber(250)).toBe('0.25')
    expect(formatQtyNumber(1)).toBe('0.001')
    expect(formatQtyNumber(1234567000)).toBe('12,34,567')
    expect(formatQty(1500, 'kg')).toBe('1.5 kg')
    expect(formatQty(12000, 'piece')).toBe('12 pc')
    expect(formatQty(500, 'litre')).toBe('0.5 L')
    expect(formatQty(2500, 'quintal')).toBe('2.5 qtl')
  })
})
