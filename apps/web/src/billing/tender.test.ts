import { describe, expect, it } from 'vitest'
import { cashSuggestions } from './tender'

describe('cashSuggestions', () => {
  it('offers the next round amounts above what is due, smallest first', () => {
    expect(cashSuggestions(7_500)).toEqual([8_000, 10_000, 50_000, 200_000]) // ₹75 -> 80, 100, 500, 2000
    expect(cashSuggestions(41_300)).toEqual([42_000, 45_000, 50_000, 200_000]) // ₹413 -> 420, 450, 500, 2000
  })

  it('never repeats an amount, never suggests less than due and skips past an exact multiple', () => {
    expect(cashSuggestions(10_000)).toEqual([11_000, 15_000, 20_000, 50_000]) // ₹100 due: 110, 150, 200, 500, not ₹100 again
    expect(cashSuggestions(50_000)).toEqual([51_000, 55_000, 60_000, 100_000])
    for (const due of [1, 99, 100, 999, 12_345, 199_999, 1_000_000]) {
      const s = cashSuggestions(due)
      expect(new Set(s).size).toBe(s.length)
      expect(s.every((a) => a > due)).toBe(true)
      expect([...s].sort((a, b) => a - b)).toEqual(s)
      expect(s.length).toBeLessThanOrEqual(4)
    }
  })

  it('suggests nothing when nothing is due', () => {
    expect(cashSuggestions(0)).toEqual([])
    expect(cashSuggestions(-5)).toEqual([])
    expect(cashSuggestions(1.5)).toEqual([])
  })
})
