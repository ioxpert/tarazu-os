import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { closeShift, openShift } from '../billing/shift'
import { first } from '../billing/testKit'
import { loadStatement, listCustomers } from '../khata/ledger'
import { OpLogWriter } from '../sync/oplog'
import { makeSchemaDb } from '../sync/schemaDb'
import { commitPurchase, priceLines, type CommitPurchaseInput } from './commit'
import { listPurchases, loadLastCosts, marginBp } from './history'
import { countStock } from './stockCount'
import { createSupplier, paySupplier } from './supplier'

const IDENTITY = { tenantId: '00000000-0000-4000-8000-000000000001', storeId: '11111111-1111-4111-8111-111111111111', deviceId: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' }
const P1 = '22222222-2222-4222-8222-222222222221'
const P2 = '22222222-2222-4222-8222-222222222222'
let t = Date.parse('2026-10-17T10:00:00.000Z')
const tick = () => (t += 60_000)
let req = 0

async function setup() {
  const { sqlite, db } = await makeSchemaDb()
  const writer = new OpLogWriter(db, { deviceId: IDENTITY.deviceId, storeId: IDENTITY.storeId }, tick)
  for (const [id, name] of [[P1, 'Biscuit'], [P2, 'Salt']] as const) {
    await db.execute(`INSERT INTO product (id, tenant_id, name, unit, active) VALUES (?, ?, ?, 'packet', 1)`, [id, IDENTITY.tenantId, name])
  }
  const supplier = await createSupplier(writer, { tenantId: IDENTITY.tenantId }, 'Agarwal Traders', '9811100000')
  return { sqlite, db, writer, supplier }
}

const buy = (writer: OpLogWriter, db: Parameters<typeof commitPurchase>[1], over: Partial<CommitPurchaseInput> & Pick<CommitPurchaseInput, 'lines'>) =>
  commitPurchase(writer, db, { requestId: `r${++req}`, supplier: null, payments: [], identity: IDENTITY, actorUserId: null, now: tick(), ...over })

describe('priceLines', () => {
  it('rounds each line half-up and sums them; rejects empty or nonsense lines', () => {
    expect(priceLines([{ productId: P1, qtyMilli: 2500, unitCostPaise: 333 }])).toMatchObject({ totalPaise: 833, lines: [{ lineTotalPaise: 833 }] }) // 2.5 x 3.33 = 8.325 -> 8.33
    expect(() => priceLines([])).toThrow()
    expect(() => priceLines([{ productId: P1, qtyMilli: 0, unitCostPaise: 1 }])).toThrow()
    expect(() => priceLines([{ productId: P1, qtyMilli: 1000, unitCostPaise: -1 }])).toThrow()
  })
})

describe('commitPurchase', () => {
  it('writes receipt, stock movements, cost prices, payment and supplier payable in one transaction', async () => {
    const { sqlite, db, writer, supplier } = await setup()
    const lines = [{ productId: P1, qtyMilli: 24_000, unitCostPaise: 4_000 }, { productId: P2, qtyMilli: 10_000, unitCostPaise: 1_800 }]
    const r = await buy(writer, db, { supplier, supplierRef: 'INV-77', lines, payments: [{ mode: 'cash', amountPaise: 50_000 }] })
    expect(r.totalPaise).toBe(96_000 + 18_000)
    expect(r.owedPaise).toBe(64_000)
    expect(r.label).toMatch(/^A1B2C3D4\/PR\/\d{4}-\d{2}\/1$/)

    const types = (sqlite.prepare('SELECT entity_type FROM op_log ORDER BY local_seq').all() as { entity_type: string }[]).map((o) => o.entity_type)
    expect(types).toEqual(['party', 'purchase_receipt', 'stock_movement', 'stock_movement', 'price_version', 'price_version', 'payment', 'khata_entry'])
    expect(first(sqlite, "SELECT sum(qty_milli) AS q FROM stock_balance WHERE product_id = ?", P1)).toEqual({ q: 24_000 })
    const receipt = JSON.parse((first<{ payload: string }>(sqlite, "SELECT payload FROM op_log WHERE entity_type = 'purchase_receipt'"))!.payload)
    expect(receipt.totalPaise).toBe(114_000)
    expect(receipt.lines.reduce((a: number, l: { lineTotalPaise: number }) => a + l.lineTotalPaise, 0)).toBe(receipt.totalPaise)
    expect(receipt).toMatchObject({ supplierRef: 'INV-77', supplierId: supplier.id })
    const pay = JSON.parse((first<{ payload: string }>(sqlite, "SELECT payload FROM op_log WHERE entity_type = 'payment'"))!.payload)
    expect(pay).toMatchObject({ direction: 'out', mode: 'cash', amountPaise: 50_000, partyId: supplier.id })
    expect(first(sqlite, 'SELECT balance_paise FROM khata_balance WHERE party_id = ?', supplier.id)).toEqual({ balance_paise: -64_000 })
    expect((await loadLastCosts(db, [P1, P2])).get(P1)).toBe(4_000)
    const [row] = await listPurchases(db)
    expect(row).toMatchObject({ supplierName: 'Agarwal Traders', supplierRef: 'INV-77', totalPaise: 114_000, lineCount: 2 })
  })

  it('numbers run 1, 2 and a rolled-back purchase consumes none; an unchanged cost writes no new price', async () => {
    const { sqlite, db, writer, supplier } = await setup()
    const line = [{ productId: P1, qtyMilli: 1_000, unitCostPaise: 4_000 }]
    expect((await buy(writer, db, { supplier, lines: line, payments: [{ mode: 'upi', amountPaise: 4_000 }] })).label).toMatch(/\/1$/)
    await expect(buy(writer, db, { supplier: null, lines: line })).rejects.toMatchObject({ code: 'supplier_needed' }) // owed, nobody to owe
    expect((await buy(writer, db, { supplier, lines: line, payments: [{ mode: 'upi', amountPaise: 4_000 }] })).label).toMatch(/\/2$/)
    expect(first(sqlite, "SELECT count(*) AS n FROM op_log WHERE entity_type = 'price_version'")).toEqual({ n: 1 })
    const dearer = await buy(writer, db, { supplier, lines: [{ productId: P1, qtyMilli: 1_000, unitCostPaise: 4_500 }], payments: [{ mode: 'upi', amountPaise: 4_500 }] })
    expect(dearer.totalPaise).toBe(4_500)
    expect((await loadLastCosts(db, [P1])).get(P1)).toBe(4_500)
    expect(first(sqlite, "SELECT count(*) AS n FROM op_log WHERE entity_type = 'price_version'")).toEqual({ n: 2 })
  })

  it('a paid-in-full cash purchase from nobody works (market purchase), and leaves nothing owed', async () => {
    const { sqlite, db, writer } = await setup()
    const r = await buy(writer, db, { lines: [{ productId: P1, qtyMilli: 5_000, unitCostPaise: 2_000 }], payments: [{ mode: 'cash', amountPaise: 10_000 }] })
    expect(r.owedPaise).toBe(0)
    expect(first(sqlite, "SELECT count(*) AS n FROM op_log WHERE entity_type = 'khata_entry'")).toEqual({ n: 0 })
  })

  it('refuses paying more than the bill, a card number, and an empty bill; writes nothing', async () => {
    const { sqlite, db, writer, supplier } = await setup()
    const before = first<{ n: number }>(sqlite, 'SELECT count(*) AS n FROM op_log')!.n
    const line = [{ productId: P1, qtyMilli: 1_000, unitCostPaise: 1_000 }]
    await expect(buy(writer, db, { supplier, lines: line, payments: [{ mode: 'cash', amountPaise: 1_001 }] })).rejects.toMatchObject({ code: 'tender_excess' })
    await expect(buy(writer, db, { supplier, lines: line, payments: [{ mode: 'card', amountPaise: 1_000, reference: '4111111111111111' }] })).rejects.toMatchObject({ code: 'card_reference_looks_like_pan' })
    await expect(buy(writer, db, { supplier, lines: [] })).rejects.toMatchObject({ code: 'nothing_received' })
    expect(first<{ n: number }>(sqlite, 'SELECT count(*) AS n FROM op_log')!.n).toBe(before)
  })

  it('the same request id twice is one receipt', async () => {
    const { sqlite, db, writer, supplier } = await setup()
    const base = { requestId: 'same', supplier, lines: [{ productId: P1, qtyMilli: 1_000, unitCostPaise: 1_000 }], payments: [{ mode: 'cash' as const, amountPaise: 1_000 }] }
    const a = await buy(writer, db, base)
    const b = await buy(writer, db, base)
    expect(b).toEqual(a)
    expect(first(sqlite, "SELECT count(*) AS n FROM op_log WHERE entity_type = 'purchase_receipt'")).toEqual({ n: 1 })
    expect(first(sqlite, 'SELECT qty_milli FROM stock_balance WHERE product_id = ?', P1)).toEqual({ qty_milli: 1_000 })
  })

  it('cash paid to the supplier leaves the open shift; UPI does not', async () => {
    const { db, writer, supplier } = await setup()
    await openShift(writer, { openingCashPaise: 100_000, identity: IDENTITY, actorUserId: null, now: tick() })
    await buy(writer, db, { supplier, lines: [{ productId: P1, qtyMilli: 10_000, unitCostPaise: 3_000 }], payments: [{ mode: 'cash', amountPaise: 20_000 }, { mode: 'upi', amountPaise: 10_000 }] })
    const r = await closeShift(writer, { declaredCashPaise: 80_000, identity: IDENTITY, actorUserId: null, now: tick() })
    expect(r.expectedCashPaise).toBe(80_000)
  })

  it('for any purchases: stock = sum received, total = sum of lines, paid + owed = total (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ q: fc.integer({ min: 1, max: 500_000 }), c: fc.integer({ min: 0, max: 200_000 }), pay: fc.double({ min: 0, max: 1, noNaN: true }) }), { minLength: 1, maxLength: 6 }),
        async (buys) => {
          const { sqlite, db, writer, supplier } = await setup()
          let received = 0
          let owed = 0
          for (const b of buys) {
            const total = priceLines([{ productId: P1, qtyMilli: b.q, unitCostPaise: b.c }]).totalPaise
            const paid = Math.floor(total * b.pay)
            const r = await buy(writer, db, { supplier, lines: [{ productId: P1, qtyMilli: b.q, unitCostPaise: b.c }], payments: paid > 0 ? [{ mode: 'upi', amountPaise: paid }] : [] })
            expect(r.paidPaise + r.owedPaise).toBe(r.totalPaise)
            received += b.q
            owed += r.owedPaise
          }
          expect(first<{ q: number }>(sqlite, 'SELECT qty_milli AS q FROM stock_balance WHERE product_id = ?', P1)!.q).toBe(received)
          const bal = first<{ b: number | null }>(sqlite, 'SELECT balance_paise AS b FROM khata_balance WHERE party_id = ?', supplier.id)
          expect(Number(bal?.b ?? 0)).toBe(-owed)
        },
      ),
      { numRuns: 20 },
    )
  })
})

describe('supplier payable', () => {
  it('shows what you owe, and paying lowers it; the statement shows both', async () => {
    const { db, writer, supplier } = await setup()
    await buy(writer, db, { supplier, lines: [{ productId: P1, qtyMilli: 10_000, unitCostPaise: 5_000 }] })
    expect((await listCustomers(db, { kind: 'supplier', filter: 'all' })).map((s) => [s.name, s.balancePaise])).toEqual([['Agarwal Traders', -50_000]])
    expect(await listCustomers(db, { filter: 'all' })).toEqual([]) // suppliers are not customers
    const r = await paySupplier(writer, { requestId: 'p1', supplierId: supplier.id, amountPaise: 30_000, mode: 'upi', reference: 'UTR9', identity: IDENTITY, actorUserId: null, now: tick() })
    expect(r.balanceAfterPaise).toBe(-20_000)
    const st = (await loadStatement(db, supplier.id, Date.now(), 'supplier'))!
    expect(st.lines.map((l) => [l.direction, l.amountPaise, l.balanceAfterPaise])).toEqual([['credit', 50_000, -50_000], ['debit', 30_000, -20_000]])
    const again = await paySupplier(writer, { requestId: 'p1', supplierId: supplier.id, amountPaise: 30_000, mode: 'upi', identity: IDENTITY, actorUserId: null, now: tick() })
    expect(again).toEqual(r)
    await expect(paySupplier(writer, { requestId: 'p2', supplierId: supplier.id, amountPaise: 0, mode: 'cash', identity: IDENTITY, actorUserId: null, now: tick() })).rejects.toMatchObject({ code: 'invalid_amount' })
  })
})

describe('stock count', () => {
  it('writes only the difference, as an adjustment or a damage, and nothing when it matches', async () => {
    const { sqlite, db, writer } = await setup()
    await buy(writer, db, { lines: [{ productId: P1, qtyMilli: 10_000, unitCostPaise: 100 }], payments: [{ mode: 'cash', amountPaise: 1_000 }] })
    const ctx = { tenantId: IDENTITY.tenantId, storeId: IDENTITY.storeId }
    expect(await countStock(writer, ctx, P1, 10_000)).toEqual({ deltaMilli: 0, booksMilli: 10_000 })
    expect(await countStock(writer, ctx, P1, 7_000)).toEqual({ deltaMilli: -3_000, booksMilli: 10_000 })
    expect(await countStock(writer, ctx, P1, 6_000, { reason: 'damage' })).toEqual({ deltaMilli: -1_000, booksMilli: 7_000 })
    expect(await countStock(writer, ctx, P1, 9_000, { reason: 'damage' })).toEqual({ deltaMilli: 3_000, booksMilli: 6_000 })
    const moves = sqlite.prepare("SELECT payload FROM op_log WHERE entity_type = 'stock_movement' ORDER BY local_seq").all() as { payload: string }[]
    expect(moves.slice(1).map((m) => [JSON.parse(m.payload).qtyMilli, JSON.parse(m.payload).reason])).toEqual([[-3_000, 'adjustment'], [-1_000, 'damage'], [3_000, 'adjustment']])
    expect(first(sqlite, 'SELECT qty_milli FROM stock_balance WHERE product_id = ?', P1)).toEqual({ qty_milli: 9_000 })
    await expect(countStock(writer, ctx, P1, -1)).rejects.toMatchObject({ code: 'invalid_count' })
  })
})

describe('margin', () => {
  it('is profit over selling price in basis points', () => {
    expect(marginBp(5_000, 4_000)).toBe(2_000)
    expect(marginBp(5_000, 6_000)).toBe(-2_000)
    expect(marginBp(null, 4_000)).toBeNull()
    expect(marginBp(0, 0)).toBeNull()
  })
})
