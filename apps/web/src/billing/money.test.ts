import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { divRoundHalfUp, mulDiv } from './money'

describe('divRoundHalfUp', () => {
  it('rounds halves up (away from zero)', () => {
    expect(divRoundHalfUp(5, 2)).toBe(3)
    expect(divRoundHalfUp(4, 3)).toBe(1)
    expect(divRoundHalfUp(1, 3)).toBe(0)
    expect(divRoundHalfUp(0, 7)).toBe(0)
    expect(divRoundHalfUp(-5, 2)).toBe(-3)
  })
  it('matches BigInt reference for any safe integers', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), (n, d) => {
        const N = BigInt(n)
        const D = BigInt(d)
        const expected = (N * 2n + D) / (2n * D)
        expect(BigInt(divRoundHalfUp(n, d))).toBe(expected)
      }),
      { numRuns: 3000 },
    )
  })
  it('refuses unsafe / bad input', () => {
    expect(() => divRoundHalfUp(2 ** 53, 1)).toThrow(/amount_overflow/)
    expect(() => divRoundHalfUp(1, 0)).toThrow(/amount_overflow/)
    expect(() => divRoundHalfUp(1.5, 1)).toThrow(/amount_overflow/)
  })
})

describe('mulDiv', () => {
  it('equals the BigInt reference including products beyond 2^53', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 40 }), fc.integer({ min: 0, max: 2 ** 40 }), fc.integer({ min: 1, max: 2 ** 40 }), (a, b, d) => {
        const expected = (BigInt(a) * BigInt(b) * 2n + BigInt(d)) / (2n * BigInt(d))
        if (expected > BigInt(Number.MAX_SAFE_INTEGER)) expect(() => mulDiv(a, b, d)).toThrow()
        else expect(BigInt(mulDiv(a, b, d))).toBe(expected)
      }),
      { numRuns: 3000 },
    )
  })
  it('throws when the RESULT is not safe', () => {
    expect(() => mulDiv(2 ** 52, 8, 1)).toThrow(/amount_overflow/)
  })
})
