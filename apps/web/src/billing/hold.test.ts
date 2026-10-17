import { describe, expect, it } from 'vitest'
import { makeSchemaDb } from '../sync/schemaDb'
import { discardHeld, holdBill, listHeld, resumeHeld } from './hold'
import { line } from './testKit'
import type { Cart } from './types'

const cart = (): Cart => ({ lines: [line({ lineId: 'L1', qtyMilli: 2000, unitPricePaise: 500 })], billDiscount: { kind: 'percent', bp: 250 }, partyId: null })

describe('held bills', () => {
  it('holds, lists oldest first, resumes (deleting) and discards; never creates ops', async () => {
    const { sqlite, db } = await makeSchemaDb()
    const a = await holdBill(db, cart(), 'Table 1', 1000, 1_000)
    const b = await holdBill(db, { ...cart(), partyId: 'p' }, 'Table 2', 2000, 2_000)
    const held = await listHeld(db)
    expect(held.map((h) => [h.label, h.totalPaise])).toEqual([['Table 1', 1000], ['Table 2', 2000]])
    expect(held[0].cart).toEqual(cart())
    expect(await resumeHeld(db, a)).toEqual(cart())
    expect((await listHeld(db)).map((h) => h.id)).toEqual([b])
    await discardHeld(db, b)
    expect(await listHeld(db)).toEqual([])
    await expect(resumeHeld(db, a)).rejects.toThrow(/held_bill_not_found/)
    expect(sqlite.prepare('SELECT count(*) AS n FROM op_log').all()).toEqual([{ n: 0 }])
  })
  it('refuses an empty cart', async () => {
    const { db } = await makeSchemaDb()
    await expect(holdBill(db, { lines: [], billDiscount: null, partyId: null }, 'x')).rejects.toThrow(/empty_cart/)
  })
})
