import { describe, expect, it } from 'vitest'
import { OpLogWriter } from '../sync/oplog'
import { makeSchemaDb } from '../sync/schemaDb'
import { priceCart } from './calc'
import { commitSale } from './commit'
import { defaultProfile } from './settings'
import { line } from './testKit'
import type { CartLine, MerchantProfile } from './types'

const IDENTITY = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  storeId: '11111111-1111-4111-8111-111111111111',
  deviceId: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
}

/**
 * Budget: a sale commits in < 300 ms (median AND P95). This measures our code (pricing, number allocation, 13 ops with
 * effects) against REAL SQLite (node:sqlite, in memory) on makeSchemaDb. It does NOT include PowerSync's worker
 * round-trip / IndexedDB or OPFS persistence: that real number is measured separately in the Playwright suite.
 */
describe('commitSale performance', () => {
  it('100 sales of 10 lines: median and P95 under 300 ms', async () => {
    const { db } = await makeSchemaDb()
    const writer = new OpLogWriter(db, { deviceId: IDENTITY.deviceId, storeId: IDENTITY.storeId })
    const profile: MerchantProfile = { ...defaultProfile(), gstMode: 'regular', gstin: '27ABCDE1234F1Z5' }
    const times: number[] = []
    for (let s = 0; s < 100; s++) {
      const lines: CartLine[] = Array.from({ length: 10 }, (_, i) =>
        line({ productId: `22222222-2222-4222-8222-2222222222${String(i).padStart(2, '0')}`, qtyMilli: 1000 + i * 250, unitPricePaise: 1999 + i * 100, taxRateBp: [0, 500, 1200, 1800][i % 4] }),
      )
      const t0 = performance.now()
      const bill = priceCart({ lines, billDiscount: { kind: 'percent', bp: 200 } }, { gstMode: 'regular', rounding: 'nearest_rupee', onDate: '2026-10-17' })
      await commitSale(writer, db, {
        requestId: `perf-${s}`, bill, lines, party: null, tenders: [{ mode: 'cash', amountPaise: bill.totalPaise }], profile,
        identity: IDENTITY, actorUserId: null, now: Date.now(),
      })
      times.push(performance.now() - t0)
    }
    times.sort((a, b) => a - b)
    const median = times[49]
    const p95 = times[94]
    console.info(`commitSale 10 lines: median ${median.toFixed(2)} ms, P95 ${p95.toFixed(2)} ms, max ${times[99].toFixed(2)} ms`)
    expect(median).toBeLessThan(300)
    expect(p95).toBeLessThan(300)
  })
})
