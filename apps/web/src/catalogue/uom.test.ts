import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  buildChain, describeChain, formatQtyMilli, fromBaseMilli, isValidUom, looseSpec, mulDivRound, parseQtyMilli,
  specFromRows, toBaseMilli, uomIssues, unitPriceFor, UomError, UNITS,
} from './uom'
import type { UomSpec } from './types'

const CASE_SPEC: UomSpec = buildChain([{ unit: 'case', per: 24 }, { unit: 'packet', per: 12 }, { unit: 'piece' }])

describe('validation', () => {
  it('accepts the contract example and loose specs', () => {
    expect(isValidUom({ base: 'piece', units: [{ unit: 'packet', qtyMilli: 12000 }, { unit: 'case', qtyMilli: 288000 }] })).toBe(true)
    expect(isValidUom(looseSpec('kg'))).toBe(true)
    expect(isValidUom(looseSpec('litre'))).toBe(true)
  })
  it('rejects bad specs with a code', () => {
    expect(uomIssues({ base: 'furlong', units: [] })).toContain('bad_base')
    expect(uomIssues({ base: 'piece', units: [{ unit: 'piece', qtyMilli: 5 }] })).toContain('unit_equals_base')
    expect(uomIssues({ base: 'piece', units: [{ unit: 'box', qtyMilli: 5 }, { unit: 'box', qtyMilli: 6 }] })).toContain('duplicate_unit')
    expect(uomIssues({ base: 'piece', units: [{ unit: 'box', qtyMilli: 0 }] })).toContain('bad_qty')
    expect(uomIssues({ base: 'piece', units: [{ unit: 'box', qtyMilli: 1.5 }] })).toContain('bad_qty')
    expect(uomIssues({ base: 'piece', units: [{ unit: 'xx', qtyMilli: 1 }] })).toContain('bad_unit')
    const nine = UNITS.filter((u) => u !== 'piece').slice(0, 9).map((unit) => ({ unit, qtyMilli: 2 }))
    expect(uomIssues({ base: 'piece', units: nine })).toContain('too_many_units')
    expect(uomIssues(null)).not.toEqual([])
  })
})

describe('chains', () => {
  it('builds "1 case = 24 packets = 288 pieces"', () => {
    expect(CASE_SPEC).toEqual({ base: 'piece', units: [{ unit: 'packet', qtyMilli: 12000 }, { unit: 'case', qtyMilli: 288000 }] })
    expect(toBaseMilli(CASE_SPEC, 'case', '1')).toBe(288000)
    expect(toBaseMilli(CASE_SPEC, 'packet', '2')).toBe(24000)
    expect(toBaseMilli(CASE_SPEC, 'piece', 3)).toBe(3000)
  })
  it('describes largest first with per-next multipliers', () => {
    expect(describeChain(CASE_SPEC).map((r) => [r.unit, r.perNext, r.inBase, r.isBase])).toEqual([
      ['case', 24, '288', false], ['packet', 12, '12', false], ['piece', null, '1', true],
    ])
    expect(describeChain(looseSpec('kg')).map((r) => [r.unit, r.perNext, r.inBase])).toEqual([['kg', 1000, '1'], ['g', null, '0.001']])
  })
  it('rejects broken chains', () => {
    expect(() => buildChain([])).toThrow(UomError)
    expect(() => buildChain([{ unit: 'case' }, { unit: 'piece' }])).toThrow(UomError)
    expect(() => buildChain([{ unit: 'case', per: 0 }, { unit: 'piece' }])).toThrow(UomError)
    expect(() => buildChain([{ unit: 'piece', per: 2 }, { unit: 'piece' }])).toThrow(UomError)
  })
  it('round-trips through editor rows', () => {
    expect(specFromRows(describeChain(CASE_SPEC))).toEqual({ base: 'piece', units: [{ unit: 'case', qtyMilli: 288000 }, { unit: 'packet', qtyMilli: 12000 }] })
  })
  it('product of per-levels equals the case size (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 50 }), { minLength: 1, maxLength: 4 }), (pers) => {
        const units = ['case', 'carton', 'box', 'packet'] as const
        const levels = pers.map((per, i) => ({ unit: units[i], per }))
        const spec = buildChain([...levels, { unit: 'piece' }])
        const product = pers.reduce((a, b) => a * b, 1)
        expect(toBaseMilli(spec, units[0], '1')).toBe(product * 1000)
      }),
    )
  })
})

describe('decimal quantities', () => {
  it('parses typed strings without floats', () => {
    expect(parseQtyMilli('0.25')).toBe(250)
    expect(parseQtyMilli('.5')).toBe(null)
    expect(parseQtyMilli('1,5')).toBe(1500)
    expect(parseQtyMilli(' 12 ')).toBe(12000)
    expect(parseQtyMilli('0.0005')).toBe(1)
    expect(parseQtyMilli('0.0004')).toBe(0)
    expect(parseQtyMilli('1e3')).toBe(null)
    expect(parseQtyMilli('-1')).toBe(null)
    expect(parseQtyMilli('abc')).toBe(null)
  })
  it('format/parse round trip (property)', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 1e12 }), (n) => parseQtyMilli(formatQtyMilli(n)) === n))
  })
  it('loose items: 250 g and 0.25 kg are the same quantity', () => {
    const kg = looseSpec('kg')
    expect(toBaseMilli(kg, 'kg', '0.25')).toBe(250)
    expect(toBaseMilli(kg, 'g', '250')).toBe(250)
    expect(toBaseMilli(looseSpec('litre'), 'ml', '500')).toBe(500)
    expect(fromBaseMilli(kg, 'g', 250)).toBe(250000)
    expect(() => toBaseMilli(kg, 'packet', '1')).toThrow(UomError)
    expect(() => toBaseMilli(kg, 'kg', 'x')).toThrow(UomError)
    expect(() => toBaseMilli(kg, 'kg', 1e21)).toThrow(UomError)
  })
  it('round trips whenever the quantity is exactly representable (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100_000 }), fc.integer({ min: 1, max: 1000 }), (n, packet) => {
        const spec: UomSpec = { base: 'piece', units: [{ unit: 'packet', qtyMilli: packet * 1000 }] }
        const base = toBaseMilli(spec, 'packet', String(n))
        expect(base).toBe(n * packet * 1000)
        expect(fromBaseMilli(spec, 'packet', base)).toBe(n * 1000)
      }),
    )
    fc.assert(fc.property(fc.integer({ min: 0, max: 5_000_000 }), (g) => fromBaseMilli(looseSpec('kg'), 'g', toBaseMilli(looseSpec('kg'), 'g', String(g))) === g * 1000))
  })
})

describe('prices', () => {
  it('unit price of a non-base unit is round-half-up(base * milli / 1000)', () => {
    expect(unitPriceFor(CASE_SPEC, 'packet', 5)).toBe(60)
    expect(unitPriceFor(CASE_SPEC, 'case', 5)).toBe(1440)
    expect(unitPriceFor(looseSpec('kg'), 'g', 6000)).toBe(6) // Rs 60/kg = 6 paise/g
    expect(unitPriceFor(looseSpec('kg'), 'g', 6500)).toBe(7) // 6.5 -> 7 (half up)
    expect(unitPriceFor(looseSpec('kg'), 'g', 6499)).toBe(6)
  })
  it('mulDivRound is exact and half-up for large safe values (property)', () => {
    fc.assert(
      fc.property(fc.nat({ max: 2 ** 40 }), fc.nat({ max: 2 ** 12 }), fc.integer({ min: 1, max: 1_000_000 }), (a, b, d) => {
        const got = BigInt(mulDivRound(a, b, d))
        const exact = BigInt(a) * BigInt(b)
        const D = BigInt(d)
        // got = floor((2*a*b + d) / (2d)): the doubled remainder decides
        expect(got * D * 2n).toBeLessThanOrEqual(exact * 2n + D)
        expect((got + 1n) * D * 2n).toBeGreaterThan(exact * 2n + D)
      }),
    )
  })
  it('throws instead of silently losing precision', () => {
    expect(() => mulDivRound(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 1)).toThrow(UomError)
    expect(() => mulDivRound(1.5, 2, 1)).toThrow(UomError)
  })
})
