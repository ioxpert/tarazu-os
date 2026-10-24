import { describe, expect, it } from 'vitest'
import { OpLogWriter } from '../sync/oplog'
import { makeSchemaDb } from '../sync/schemaDb'
import { priceCart } from './calc'
import { commitSale, type CommitSaleInput } from './commit'
import fc from 'fast-check'
import { collectPayment } from '../khata/collect'
import { commitPurchase } from '../purchase/commit'
import { dailySales, dayBook, itemSales, position, presetRange, profitReport, stockReport, stockValue, summary } from './reports'
import { commitReturn } from './returns'
import { defaultProfile } from './settings'
import { line } from './testKit'
import type { CartLine, MerchantProfile, Tender } from './types'

const IDENTITY = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  storeId: '11111111-1111-4111-8111-111111111111',
  deviceId: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
}
const P1 = '22222222-2222-4222-8222-222222222221'
const P2 = '22222222-2222-4222-8222-222222222222'
const PARTY = { id: '33333333-3333-4333-8333-333333333333', name: 'Ramesh' }
const T0 = Date.parse('2026-10-17T10:00:00.000Z') // 15:30 IST on the 17th
const DAY = 86_400_000
const regular: MerchantProfile = { ...defaultProfile(), businessName: 'Sharma Store', gstMode: 'regular', gstin: '27ABCDE1234F1Z5' }
let seq = 0

async function world() {
  const { sqlite, db } = await makeSchemaDb()
  sqlite.exec(`INSERT INTO product (id, tenant_id, name, unit) VALUES ('${P1}', '${IDENTITY.tenantId}', 'Rice', 'kg'), ('${P2}', '${IDENTITY.tenantId}', 'Soap', 'piece')`)
  sqlite.exec(`INSERT INTO party (id, tenant_id, name, phone, party_type, active) VALUES ('${PARTY.id}', '${IDENTITY.tenantId}', 'Ramesh', '9876543210', 'customer', 1)`)
  let now = T0
  const writer = new OpLogWriter(db, { deviceId: IDENTITY.deviceId, storeId: IDENTITY.storeId }, () => now)
  return { db, writer, at: (ms: number) => (now = ms) }
}
type World = Awaited<ReturnType<typeof world>>

async function sell(w: World, at: number, lines: CartLine[], tenders: Tender[], party: CommitSaleInput['party'] = null) {
  w.at(at)
  const bill = priceCart({ lines, billDiscount: null }, { gstMode: 'regular', rounding: 'nearest_rupee', onDate: '2026-10-17' })
  return commitSale(w.writer, w.db, { requestId: `s${++seq}`, bill, lines, party, tenders, profile: regular, identity: IDENTITY, actorUserId: null, now: at })
}
const rice = () => line({ productId: P1, name: 'Rice', qtyMilli: 3000, unitPricePaise: 11800, taxRateBp: 1800, unit: 'kg' })
const soap = () => line({ productId: P2, name: 'Soap', qtyMilli: 2000, unitPricePaise: 5000, taxRateBp: 500 })

/** Oct 17: rice for cash. Oct 18 (IST): soap on khata, soap by card at 00:05 IST, and 1 kg of the rice returned. */
async function fixture() {
  const w = await world()
  const a = await sell(w, T0, [rice()], [{ mode: 'cash', amountPaise: 35400 }])
  await sell(w, T0 + DAY, [soap()], [{ mode: 'credit', amountPaise: 10000 }], PARTY)
  await sell(w, Date.parse('2026-10-17T18:35:00.000Z'), [soap()], [{ mode: 'card', amountPaise: 10000 }])
  w.at(T0 + DAY + 60_000)
  await commitReturn(w.writer, w.db, {
    requestId: `r${++seq}`, invoiceId: a.invoiceId, selections: [{ lineNo: 1, qtyMilli: 1000 }], reason: 'damaged',
    refunds: [{ kind: 'cash', amountPaise: 11800 }], profile: regular, identity: IDENTITY, actorUserId: null, now: T0 + DAY + 60_000,
  })
  return w
}
const BOTH = { fromDate: '2026-10-17', toDate: '2026-10-18' }

describe('presetRange', () => {
  it('uses the IST day, a rolling week and the month so far', () => {
    const now = Date.parse('2026-10-17T20:00:00.000Z') // already the 18th in IST
    expect(presetRange('today', now)).toEqual({ fromDate: '2026-10-18', toDate: '2026-10-18' })
    expect(presetRange('week', now)).toEqual({ fromDate: '2026-10-12', toDate: '2026-10-18' })
    expect(presetRange('month', now)).toEqual({ fromDate: '2026-10-01', toDate: '2026-10-18' })
  })
})

describe('dailySales', () => {
  it('splits by IST day and takes a return off the day it was made', async () => {
    const w = await fixture()
    expect(await dailySales(w.db, BOTH)).toEqual([
      expect.objectContaining({ date: '2026-10-17', bills: 1, salesPaise: 35400, returnsPaise: 0, netPaise: 35400 }),
      expect.objectContaining({ date: '2026-10-18', bills: 2, salesPaise: 20000, returnsPaise: 11800, netPaise: 8200 }),
    ])
    expect(await dailySales(w.db, { fromDate: '2026-10-18', toDate: '2026-10-18' })).toHaveLength(1)
    expect(await dailySales(w.db, { fromDate: '2026-11-01', toDate: '2026-11-02' })).toEqual([])
  })
})

describe('itemSales', () => {
  it('nets returns off quantity and revenue, best seller first', async () => {
    const w = await fixture()
    expect(await itemSales(w.db, BOTH)).toEqual([
      expect.objectContaining({ productId: P1, name: 'Rice', qtyMilli: 3000, revenuePaise: 35400, returnedQtyMilli: 1000, returnedPaise: 11800, netQtyMilli: 2000, netPaise: 23600, avgPricePaise: 11800 }),
      expect.objectContaining({ productId: P2, name: 'Soap', qtyMilli: 4000, netPaise: 20000, avgPricePaise: 5000 }),
    ])
  })

  it('shows a product that was only returned in the range', async () => {
    const w = await fixture()
    const rows = await itemSales(w.db, { fromDate: '2026-10-18', toDate: '2026-10-18' })
    const r = rows.find((x) => x.productId === P1)!
    expect(r).toMatchObject({ name: 'Rice', qtyMilli: 0, returnedQtyMilli: 1000, netPaise: -11800, avgPricePaise: 0 })
  })
})

describe('summary and position', () => {
  it('adds up the range, splits it by mode and keeps credit apart', async () => {
    const w = await fixture()
    const s = await summary(w.db, BOTH)
    expect(s).toMatchObject({ bills: 3, salesPaise: 55400, returnsPaise: 11800, netPaise: 43600, creditPaise: 10000 })
    // what came in by mode plus what is owed accounts for every paisa sold, less the cash handed back
    expect(s.byMode.cash + s.byMode.upi + s.byMode.card + s.creditPaise).toBe(s.netPaise)
    expect(s.byMode).toMatchObject({ card: 10000, upi: 0 })
    expect(await summary(w.db, { fromDate: '2026-11-01', toDate: '2026-11-01' })).toMatchObject({ bills: 0, salesPaise: 0, netPaise: 0, creditPaise: 0 })
  })

  it('reports what customers owe and items sold below zero stock', async () => {
    const w = await fixture()
    const p = await position(w.db)
    expect(p.khataOutstandingPaise).toBe(10000)
    expect(p.oversoldItems).toBe(2) // nothing was stocked in the fixture
  })
})

describe('stockReport', () => {
  it('lists oversold first, then out of stock, and counts each', async () => {
    const w = await world()
    const sid = IDENTITY.storeId
    for (const [pid, qty] of [[P1, 5000], [P2, -2000]] as const) {
      await w.db.execute(`INSERT INTO stock_balance (id, tenant_id, store_id, product_id, qty_milli, oversold, movement_count) VALUES (?, ?, ?, ?, ?, ?, 1)`, [`${sid}:${pid}`, IDENTITY.tenantId, sid, pid, qty, qty < 0 ? 1 : 0])
    }
    const r = await stockReport(w.db)
    expect(r.rows.map((x) => [x.name, x.qtyMilli])).toEqual([['Soap', -2000], ['Rice', 5000]])
    expect(r).toMatchObject({ oversold: 1, outOfStock: 0, inStock: 1 })
  })

  it('adds a product held in two stores and skips an inactive one', async () => {
    const w = await world()
    await w.db.execute(`UPDATE product SET active = 0 WHERE id = ?`, [P2])
    for (const [store, pid, qty] of [['s1', P1, 1000], ['s2', P1, 0], ['s1', P2, 9000]] as const) {
      await w.db.execute(`INSERT INTO stock_balance (id, tenant_id, store_id, product_id, qty_milli, oversold, movement_count) VALUES (?, ?, ?, ?, ?, 0, 1)`, [`${store}:${pid}`, IDENTITY.tenantId, store, pid, qty])
    }
    const r = await stockReport(w.db)
    expect(r.rows).toEqual([{ productId: P1, name: 'Rice', unit: 'kg', qtyMilli: 1000 }])
  })
})

describe('dayBook', () => {
  it('lists each event once, in time order, and keeps bill tenders out of the collections', async () => {
    const w = await fixture()
    w.at(T0 + DAY + 120_000)
    await collectPayment(w.writer, { requestId: 'c1', partyId: PARTY.id, amountPaise: 4000, mode: 'upi', identity: IDENTITY, actorUserId: null, now: T0 + DAY + 120_000 })
    const b = await dayBook(w.db, BOTH)
    expect(b.entries.map((e) => e.kind)).toEqual(['sale', 'sale', 'sale', 'return', 'collection'])
    expect(b.entries.map((e) => e.at)).toEqual([...b.entries.map((e) => e.at)].sort())
    expect(b).toMatchObject({ salesPaise: 55400, returnsPaise: 11800, collectionsPaise: 4000, takingsPaise: 47600 })
  })

  it('takings equal daily net sales plus collections, and the entries add up to the payments (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ day: fc.integer({ min: 0, max: 2 }), qty: fc.integer({ min: 1, max: 5 }), mode: fc.constantFrom('cash', 'upi', 'credit'), collect: fc.integer({ min: 0, max: 5000 }) }), { minLength: 1, maxLength: 8 }),
        async (ops) => {
          const w = await world()
          let collected = 0
          for (const [n, o] of ops.entries()) {
            const at = T0 + o.day * DAY + n * 1000
            const total = priceCart({ lines: [{ ...soap(), qtyMilli: o.qty * 1000 }], billDiscount: null }, { gstMode: 'regular', rounding: 'nearest_rupee', onDate: '2026-10-17' }).totalPaise
            await sell(w, at, [{ ...soap(), qtyMilli: o.qty * 1000 }], [{ mode: o.mode, amountPaise: total }], o.mode === 'credit' ? PARTY : null)
            if (o.collect > 0) {
              await collectPayment(w.writer, { requestId: `pc${++seq}`, partyId: PARTY.id, amountPaise: o.collect, mode: 'cash', identity: IDENTITY, actorUserId: null, now: at + 500 })
              collected += o.collect
            }
          }
          const range = { fromDate: '2026-10-17', toDate: '2026-10-19' }
          const days = await dailySales(w.db, range)
          const b = await dayBook(w.db, range)
          expect(b.collectionsPaise).toBe(collected)
          expect(b.takingsPaise).toBe(days.reduce((a, d) => a + d.netPaise, 0) + collected)
          // every payment is either a bill tender (inside a sale row) or a collection/supplier row: nothing counted twice
          const tendered = b.moneyInPaise - b.collectionsPaise
          const [t] = await w.db.getAll<{ s: number | null }>(`SELECT SUM(amount_paise) AS s FROM payment WHERE invoice_id IS NOT NULL AND direction = 'in'`)
          expect(tendered).toBe(Number(t?.s ?? 0))
        },
      ),
      { numRuns: 15 },
    )
  })

  it('shows a supplier purchase and the money paid out for it', async () => {
    const w = await world()
    await commitPurchase(w.writer, w.db, {
      requestId: 'b1', supplier: null, payments: [{ mode: 'cash', amountPaise: 5000 }], identity: IDENTITY, actorUserId: null, now: T0,
      lines: [{ productId: P1, qtyMilli: 10_000, unitCostPaise: 500 }],
    })
    const b = await dayBook(w.db, { fromDate: '2026-10-17', toDate: '2026-10-17' })
    expect(b.purchasesPaise).toBe(5000)
    expect(b.moneyOutPaise).toBe(5000)
  })
})

const costOf = (w: World, productId: string, unitCostPaise: number, now: number, qtyMilli = 1000) =>
  commitPurchase(w.writer, w.db, { requestId: `cost${++seq}`, supplier: null, payments: [{ mode: 'cash', amountPaise: Math.round((qtyMilli * unitCostPaise) / 1000) }], identity: IDENTITY, actorUserId: null, now, lines: [{ productId, qtyMilli, unitCostPaise }] })

describe('profitReport', () => {
  it('uses the cost in effect on the bill, takes a return back at that cost, and leaves unknown cost out', async () => {
    const w = await fixture()
    // rice was bought at 50/kg the day before it sold, and the price went up to 60 afterwards: old bills keep 50
    await costOf(w, P1, 5000, T0 - DAY)
    await costOf(w, P1, 6000, T0 + 3 * DAY)
    const p = await profitReport(w.db, BOTH)
    const rice = p.items.find((i) => i.productId === P1)!
    // sold 3 kg for 354.00 (cost 150.00), returned 1 kg for 118.00 (cost 50.00)
    expect(rice).toMatchObject({ netQtyMilli: 2000, revenuePaise: 23600, costPaise: 10000, profitPaise: 13600, marginBp: 5763, costMissingPaise: 0 })
    // soap never had a purchase price: its 2 x 100.00 is counted as missing, not as pure profit
    expect(p.items.find((i) => i.productId === P2)).toMatchObject({ revenuePaise: 0, costPaise: 0, marginBp: null, costMissingPaise: 20000 })
    expect(p).toMatchObject({ revenuePaise: 23600, costPaise: 10000, profitPaise: 13600, costMissingPaise: 20000, costMissingItems: 1 })
    expect(p.items[0].productId).toBe(P1)
  })

  it('profit plus cost equals known revenue for any mix of costs (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.option(fc.integer({ min: 1, max: 20_000 })), fc.integer({ min: 1, max: 6 }), async (cost, qty) => {
        const w = await world()
        if (cost !== null) await costOf(w, P2, cost, T0 - DAY)
        await sell(w, T0, [{ ...soap(), qtyMilli: qty * 1000 }], [{ mode: 'cash', amountPaise: 1_000_000 }])
        const p = await profitReport(w.db, { fromDate: '2026-10-17', toDate: '2026-10-17' })
        expect(p.profitPaise + p.costPaise).toBe(p.revenuePaise)
        expect(p.revenuePaise + p.costMissingPaise).toBe(qty * 5000)
        expect(p.costMissingItems).toBe(cost === null ? 1 : 0)
      }),
      { numRuns: 20 },
    )
  })
})

describe('stockValue', () => {
  it('values stock above zero at the latest cost and counts what has no cost', async () => {
    const w = await world()
    await costOf(w, P1, 5000, T0, 10_000) // 10 kg bought at 50/kg: also stocks 10 kg
    await costOf(w, P1, 6000, T0 + 1000, 0 + 1000) // +1 kg at 60/kg
    await w.db.execute(`INSERT INTO stock_balance (id, tenant_id, store_id, product_id, qty_milli, oversold, movement_count) VALUES ('x:${P2}', ?, 'x', ?, 4000, 0, 1)`, [IDENTITY.tenantId, P2])
    const v = await stockValue(w.db)
    expect(v).toEqual({ valuePaise: 11 * 6000, costMissingItems: 1 })
  })
})
