import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { ageing, type AgeEntry } from './ageing'

const d = (day: number) => new Date(Date.UTC(2026, 0, day)).toISOString()
const NOW = new Date(Date.UTC(2026, 5, 1))

describe('ageing', () => {
  it('matches payments to the oldest debt first', () => {
    const a = ageing(
      [
        { direction: 'debit', amountPaise: 500, occurredAt: d(1) },
        { direction: 'debit', amountPaise: 300, occurredAt: d(10) },
        { direction: 'credit', amountPaise: 600, occurredAt: d(15) },
      ],
      NOW,
    )
    expect(a.open).toEqual([{ occurredAt: d(10), remainingPaise: 200 }])
    expect(a.owedPaise).toBe(200)
    expect(a.oldestDays).toBe(Math.floor((NOW.getTime() - Date.parse(d(10))) / 86_400_000))
  })

  it('an advance settles the next bill first', () => {
    const a = ageing(
      [
        { direction: 'credit', amountPaise: 1000, occurredAt: d(1) },
        { direction: 'debit', amountPaise: 400, occurredAt: d(2) },
      ],
      NOW,
    )
    expect(a.owedPaise).toBe(0)
    expect(a.advancePaise).toBe(600)
    expect(a.oldestDays).toBe(0)
  })

  it('buckets by age', () => {
    const asOf = new Date(Date.UTC(2026, 2, 1))
    const a = ageing(
      [
        { direction: 'debit', amountPaise: 100, occurredAt: new Date(Date.UTC(2026, 1, 20)).toISOString() }, // 9 days
        { direction: 'debit', amountPaise: 200, occurredAt: new Date(Date.UTC(2026, 0, 20)).toISOString() }, // 40 days
        { direction: 'debit', amountPaise: 400, occurredAt: new Date(Date.UTC(2025, 11, 1)).toISOString() }, // 90 days
      ],
      asOf,
    )
    expect(a.buckets).toEqual({ upTo30: 100, from31To60: 200, over60: 400 })
  })

  it('owed - advance is always the khata balance, whatever the order and amounts (property)', () => {
    const entry = fc.record({
      direction: fc.constantFrom('debit' as const, 'credit' as const),
      amountPaise: fc.integer({ min: 1, max: 1_000_000 }),
      day: fc.integer({ min: 1, max: 120 }),
    })
    fc.assert(
      fc.property(fc.array(entry, { maxLength: 40 }), (raw) => {
        const entries: AgeEntry[] = raw.map((r, i) => ({ direction: r.direction, amountPaise: r.amountPaise, occurredAt: d(r.day), id: String(i).padStart(3, '0') }))
        const balance = entries.reduce((a, e) => a + (e.direction === 'debit' ? e.amountPaise : -e.amountPaise), 0)
        const a = ageing(entries, NOW)
        expect(a.owedPaise - a.advancePaise).toBe(balance)
        expect(a.owedPaise === 0 || a.advancePaise === 0).toBe(true)
        expect(a.buckets.upTo30 + a.buckets.from31To60 + a.buckets.over60).toBe(a.owedPaise)
        expect(a.open.every((o) => o.remainingPaise > 0)).toBe(true)
      }),
      { numRuns: 500 },
    )
  })
})
