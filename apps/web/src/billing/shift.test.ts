import { describe, expect, it } from 'vitest'
import { OpLogWriter } from '../sync/oplog'
import { makeSchemaDb } from '../sync/schemaDb'
import { priceCart } from './calc'
import { commitSale } from './commit'
import { defaultProfile } from './settings'
import { closeShift, currentShift, expectedCash, openShift } from './shift'
import { first, line } from './testKit'

const IDENTITY = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  storeId: '11111111-1111-4111-8111-111111111111',
  deviceId: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
}
const P1 = '22222222-2222-4222-8222-222222222221'
const NOW = Date.parse('2026-10-17T04:00:00.000Z')
let n = 0

async function world() {
  const { sqlite, db } = await makeSchemaDb()
  const writer = new OpLogWriter(db, { deviceId: IDENTITY.deviceId, storeId: IDENTITY.storeId }, () => NOW)
  const sellCash = (paise: number, mode: 'cash' | 'upi' = 'cash') => {
    const lines = [line({ productId: P1, qtyMilli: 1000, unitPricePaise: paise })]
    const bill = priceCart({ lines, billDiscount: null }, { gstMode: 'non_gst', rounding: 'nearest_rupee', onDate: '2026-10-17' })
    return commitSale(writer, db, {
      requestId: `q${++n}`, bill, lines, party: null, tenders: [{ mode, amountPaise: bill.totalPaise }], profile: defaultProfile(),
      identity: IDENTITY, actorUserId: null, now: NOW,
    })
  }
  const open = (float: number) => openShift(writer, { openingCashPaise: float, identity: IDENTITY, actorUserId: null, now: NOW })
  const close = (declared: number) => closeShift(writer, { declaredCashPaise: declared, identity: IDENTITY, actorUserId: null, now: NOW + 8 * 3600_000 })
  return { sqlite, db, writer, sellCash, open, close }
}

describe('shift', () => {
  it('opens a shift: op + local row + currentShift', async () => {
    const w = await world()
    expect(await currentShift(w.db)).toBeNull()
    const s = await w.open(200000)
    expect(await currentShift(w.db)).toEqual(s)
    const op = first<{ entity_type: string; payload: string }>(w.sqlite, "SELECT entity_type, payload FROM op_log WHERE entity_type = 'shift'")!
    expect(JSON.parse(op.payload)).toMatchObject({ openingCashPaise: 200000, openedAt: '2026-10-17T04:00:00.000Z' })
    expect(first(w.sqlite, 'SELECT opening_cash_paise FROM shift WHERE id = ?', s.id)).toEqual({ opening_cash_paise: 200000 })
    await expect(w.open(1)).rejects.toThrow(/shift_already_open/)
  })

  it('expected = opening + cash in; UPI sales do not count', async () => {
    const w = await world()
    const s = await w.open(100000)
    await w.sellCash(50000)
    await w.sellCash(30000)
    await w.sellCash(99900, 'upi')
    expect(await expectedCash(w.db, s)).toBe(180000)
  })

  it('cash sales before the shift opened are not part of it', async () => {
    const w = await world()
    await w.sellCash(70000)
    const s = await w.open(100000)
    expect(await expectedCash(w.db, s)).toBe(100000)
  })

  it('closes with a shortage (negative variance)', async () => {
    const w = await world()
    await w.open(100000)
    await w.sellCash(50000)
    const r = await w.close(145000)
    expect(r).toMatchObject({ expectedCashPaise: 150000, declaredCashPaise: 145000, variancePaise: -5000 })
    const op = first<{ payload: string }>(w.sqlite, "SELECT payload FROM op_log WHERE entity_type = 'shift_close'")!
    expect(JSON.parse(op.payload)).toMatchObject({ shiftId: r.shiftId, declaredCashPaise: 145000, expectedCashPaise: 150000 })
    expect(first(w.sqlite, 'SELECT variance_paise, shift_id FROM shift_close')).toEqual({ variance_paise: -5000, shift_id: r.shiftId })
    expect(await currentShift(w.db)).toBeNull()
  })

  it('closes with an overage (positive variance) and exact (zero)', async () => {
    const w = await world()
    await w.open(0)
    await w.sellCash(10000)
    expect((await w.close(10200)).variancePaise).toBe(200)
    await w.open(500)
    expect((await w.close(500)).variancePaise).toBe(0)
  })

  it('cannot close without an open shift; a second open is possible after close', async () => {
    const w = await world()
    await expect(w.close(0)).rejects.toThrow(/no_open_shift/)
    await w.open(0)
    await w.close(0)
    const s2 = await w.open(100)
    expect(s2.openingCashPaise).toBe(100)
  })
})
