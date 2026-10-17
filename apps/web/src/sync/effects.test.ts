import { describe, expect, it } from 'vitest'
import { adjustKhataBalance, adjustStockBalance } from './effects'
import { makeTestDb } from './testDb'

describe('local effects', () => {
  it('keeps stock as a running sum and flags oversold below zero (two counters selling the last 3 units)', async () => {
    const { sqlite, db } = await makeTestDb()
    await db.writeTransaction(async (tx) => {
      const run = async (delta: number) => {
        const e = adjustStockBalance('t', 's', 'p', delta)
        await tx.execute(e.sql, e.params)
      }
      await run(3000)
      await run(-3000)
      expect(sqlite.prepare('SELECT qty_milli, oversold, movement_count FROM stock_balance').get()).toEqual({ qty_milli: 0, oversold: 0, movement_count: 2 })
      await run(-3000)
    })
    expect(sqlite.prepare('SELECT qty_milli, oversold, movement_count FROM stock_balance').get()).toEqual({ qty_milli: -3000, oversold: 1, movement_count: 3 })
  })

  it('keeps khata as debits minus credits', async () => {
    const { sqlite, db } = await makeTestDb()
    await db.writeTransaction(async (tx) => {
      for (const delta of [50_000, -20_000]) {
        const e = adjustKhataBalance('t', 'party', delta)
        await tx.execute(e.sql, e.params)
      }
    })
    expect(sqlite.prepare('SELECT balance_paise, entry_count FROM khata_balance').get()).toEqual({ balance_paise: 30_000, entry_count: 2 })
  })
})
