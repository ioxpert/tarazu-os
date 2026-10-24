import { describe, expect, it } from 'vitest'
import { OpLogWriter } from '../sync/oplog'
import { makeSchemaDb } from '../sync/schemaDb'
import { priceCart } from './calc'
import { commitSale, type CommitSaleInput } from './commit'
import { dailySales, itemSales, position, presetRange, summary } from './reports'
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
