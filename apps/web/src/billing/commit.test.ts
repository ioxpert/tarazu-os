import { describe, expect, it } from 'vitest'
import { OpLogWriter } from '../sync/oplog'
import { makeSchemaDb } from '../sync/schemaDb'
import { isUuidV7 } from '../sync/uuid7'
import { priceCart } from './calc'
import { commitSale, type CommitSaleInput } from './commit'
import { defaultProfile } from './settings'
import { first, line } from './testKit'
import type { CartLine, MerchantProfile, Tender } from './types'

export const IDENTITY = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  storeId: '11111111-1111-4111-8111-111111111111',
  deviceId: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
}
const P1 = '22222222-2222-4222-8222-222222222221'
const P2 = '22222222-2222-4222-8222-222222222222'
const PARTY = { id: '33333333-3333-4333-8333-333333333333', name: 'Ramesh' }
const NOW = Date.parse('2026-10-17T10:00:00.000Z')
let reqSeq = 0

const regular: MerchantProfile = { ...defaultProfile(), businessName: 'Sharma Store', gstMode: 'regular', gstin: '27ABCDE1234F1Z5' }

async function setup(profile: MerchantProfile = regular) {
  const { sqlite, db } = await makeSchemaDb()
  const writer = new OpLogWriter(db, { deviceId: IDENTITY.deviceId, storeId: IDENTITY.storeId }, () => NOW)
  return { sqlite, db, writer, profile }
}

function input(profile: MerchantProfile, lines: CartLine[], tenders: Tender[], over: Partial<CommitSaleInput> = {}): CommitSaleInput {
  const bill = priceCart(
    { lines, billDiscount: null },
    { gstMode: profile.gstMode, rounding: profile.rounding, onDate: '2026-10-17' },
  )
  return {
    requestId: `req-${++reqSeq}`,
    bill,
    lines,
    party: null,
    tenders,
    profile,
    identity: IDENTITY,
    actorUserId: null,
    now: NOW,
    ...over,
  }
}

const ops = (sqlite: { prepare(s: string): { all(...p: unknown[]): unknown[] } }) =>
  sqlite.prepare('SELECT entity_type, entity_id, payload, local_seq, idempotency_key, id FROM op_log ORDER BY local_seq').all() as {
    entity_type: string
    entity_id: string
    payload: string
    local_seq: number
    idempotency_key: string
    id: string
  }[]

const one = (over: Partial<CartLine> = {}) => line({ qtyMilli: 1000, unitPricePaise: 118000, productId: P1, taxRateBp: 1800, ...over })

describe('commitSale', () => {
  it('writes invoice, stock movement and payment ops in order with payloads that satisfy the server equations', async () => {
    const { sqlite, db, writer } = await setup()
    const lines = [one(), line({ qtyMilli: 2500, unitPricePaise: 4000, productId: P2, taxRateBp: 500, taxInclusive: false })]
    const inp = input(regular, lines, [{ mode: 'cash', amountPaise: 200000 }])
    const r = await commitSale(writer, db, inp)
    expect(r.label).toBe('A1B2C3D4/2026-27/1')
    expect(r.series).toBe('A1B2C3D4-2026-27')
    expect(isUuidV7(r.invoiceId)).toBe(true)
    expect(r.changeDuePaise).toBe(200000 - inp.bill.totalPaise)

    const rows = ops(sqlite)
    expect(rows.map((o) => o.entity_type)).toEqual(['invoice', 'stock_movement', 'stock_movement', 'payment'])
    expect(rows.map((o) => o.local_seq)).toEqual([1, 2, 3, 4])
    expect(new Set(rows.map((o) => o.idempotency_key)).size).toBe(4)
    expect(rows[0].entity_id).toBe(r.invoiceId)

    const inv = JSON.parse(rows[0].payload)
    expect(inv).toMatchObject({ series: 'A1B2C3D4-2026-27', number: 1, docType: 'tax_invoice', invoiceDate: '2026-10-17', partyId: null, discountPaise: 0 })
    const lineSum = inv.lines.reduce((a: number, l: { lineTotalPaise: number }) => a + l.lineTotalPaise, 0)
    expect(lineSum).toBe(inv.subtotalPaise + inv.taxPaise)
    expect(inv.subtotalPaise + inv.taxPaise - inv.discountPaise + inv.roundOffPaise).toBe(inv.totalPaise)
    expect(inv.lines.reduce((a: number, l: { taxPaise: number }) => a + l.taxPaise, 0)).toBe(inv.taxPaise)
    expect(inv.totalPaise % 100).toBe(0)

    const sm = rows.slice(1, 3).map((o) => JSON.parse(o.payload))
    expect(sm[0]).toMatchObject({ productId: P1, qtyMilli: -1000, reason: 'sale', refType: 'invoice', refId: r.invoiceId })
    expect(sm[1]).toMatchObject({ productId: P2, qtyMilli: -2500 })
    expect(JSON.parse(rows[3].payload)).toMatchObject({ direction: 'in', mode: 'cash', amountPaise: inp.bill.totalPaise, invoiceId: r.invoiceId })

    // optimistic local rows
    expect(first(sqlite, 'SELECT count(*) AS n FROM invoice_line WHERE invoice_id = ?', r.invoiceId)).toEqual({ n: 2 })
    expect(first(sqlite, 'SELECT total_paise FROM invoice WHERE id = ?', r.invoiceId)).toEqual({ total_paise: inp.bill.totalPaise })
    expect(r.receipt).toMatchObject({ kind: 'sale', label: r.label, totalPaise: inp.bill.totalPaise, changeDuePaise: r.changeDuePaise })
  })

  it('numbers are gapless: a build that throws consumes no number', async () => {
    const { sqlite, db, writer } = await setup()
    const a = await commitSale(writer, db, input(regular, [one()], [{ mode: 'cash', amountPaise: 118000 }]))
    // a failing commit inside the transaction (second invoice fails after the number is allocated)
    await expect(
      writer.writeAllWith(async (tx) => {
        const { allocateNumber } = await import('./numbering')
        await allocateNumber(tx, a.series)
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    const b = await commitSale(writer, db, input(regular, [one()], [{ mode: 'cash', amountPaise: 118000 }]))
    expect([a.number, b.number]).toEqual([1, 2])
    expect(ops(sqlite).filter((o) => o.entity_type === 'invoice')).toHaveLength(2)
  })

  it('validation failures write nothing and leave numbering untouched', async () => {
    const { sqlite, db, writer } = await setup()
    await expect(commitSale(writer, db, input(regular, [one()], [{ mode: 'cash', amountPaise: 1 }]))).rejects.toThrow(/tender_short/)
    expect(ops(sqlite)).toHaveLength(0)
    const r = await commitSale(writer, db, input(regular, [one()], [{ mode: 'cash', amountPaise: 118000 }]))
    expect(r.number).toBe(1)
  })

  it('1200 = 500 UPI + 700 credit: khata balance 700, only the 500 UPI payment', async () => {
    const { sqlite, db, writer } = await setup()
    const inp = input(regular, [line({ qtyMilli: 1000, unitPricePaise: 120000, productId: P1 })], [
      { mode: 'upi', amountPaise: 50000, reference: 'UPI123' },
      { mode: 'credit', amountPaise: 70000 },
    ], { party: PARTY })
    expect(inp.bill.totalPaise).toBe(120000)
    const r = await commitSale(writer, db, inp)
    const rows = ops(sqlite)
    expect(rows.map((o) => o.entity_type)).toEqual(['invoice', 'stock_movement', 'payment', 'khata_entry'])
    expect(JSON.parse(rows[2].payload)).toMatchObject({ mode: 'upi', amountPaise: 50000, reference: 'UPI123', partyId: PARTY.id })
    expect(JSON.parse(rows[3].payload)).toMatchObject({ partyId: PARTY.id, direction: 'debit', amountPaise: 70000, refType: 'invoice', refId: r.invoiceId })
    expect(first(sqlite, 'SELECT balance_paise, entry_count FROM khata_balance WHERE party_id = ?', PARTY.id)).toEqual({ balance_paise: 70000, entry_count: 1 })
    expect(first(sqlite, 'SELECT count(*) AS n FROM payment')).toEqual({ n: 1 })
    expect(r.receipt.creditPaise).toBe(70000)
    expect(JSON.parse(rows[0].payload).partyId).toBe(PARTY.id)
  })

  it('credit without a customer is refused', async () => {
    const { sqlite, db, writer } = await setup()
    await expect(commitSale(writer, db, input(regular, [one()], [{ mode: 'credit', amountPaise: 118000 }]))).rejects.toThrow(/credit_needs_customer/)
    expect(ops(sqlite)).toHaveLength(0)
  })

  it('split cash + UPI makes two payments', async () => {
    const { sqlite, db, writer } = await setup()
    const inp = input(regular, [one()], [
      { mode: 'cash', amountPaise: 68000 },
      { mode: 'upi', amountPaise: 50000 },
    ])
    await commitSale(writer, db, inp)
    const pays = ops(sqlite).filter((o) => o.entity_type === 'payment').map((o) => JSON.parse(o.payload))
    expect(pays.map((p) => [p.mode, p.amountPaise])).toEqual([['cash', 68000], ['upi', 50000]])
  })

  it('change is given only out of cash and is never a payment', async () => {
    const { sqlite, db, writer } = await setup()
    const inp = input(regular, [one()], [{ mode: 'cash', amountPaise: 150000 }])
    const r = await commitSale(writer, db, inp)
    expect(r.changeDuePaise).toBe(32000)
    const pay = JSON.parse(ops(sqlite).find((o) => o.entity_type === 'payment')!.payload)
    expect(pay.amountPaise).toBe(118000)
    // UPI over-tender is not change
    await expect(commitSale(writer, db, input(regular, [one()], [{ mode: 'upi', amountPaise: 150000 }]))).rejects.toThrow(/tender_excess/)
    // change larger than the cash handed over (credit covers the rest and then some)
    await expect(
      commitSale(writer, db, input(regular, [one()], [{ mode: 'cash', amountPaise: 10000 }, { mode: 'upi', amountPaise: 150000 }])),
    ).rejects.toThrow(/tender_excess/)
  })

  it('oversold goes negative and flags the stock projection', async () => {
    const { sqlite, db, writer } = await setup()
    sqlite.exec(`INSERT INTO stock_balance (id, tenant_id, store_id, product_id, qty_milli, oversold, movement_count)
      VALUES ('${IDENTITY.storeId}:${P1}', '${IDENTITY.tenantId}', '${IDENTITY.storeId}', '${P1}', 1000, 0, 1)`)
    await commitSale(writer, db, input(regular, [one({ qtyMilli: 3000 })], [{ mode: 'cash', amountPaise: 354000 }]))
    expect(first(sqlite, 'SELECT qty_milli, oversold FROM stock_balance WHERE product_id = ?', P1)).toEqual({ qty_milli: -2000, oversold: 1 })
  })

  it('a double submit with the same requestId returns the same invoice and writes once', async () => {
    const { sqlite, db, writer } = await setup()
    const inp = input(regular, [one()], [{ mode: 'cash', amountPaise: 118000 }])
    const a = await commitSale(writer, db, inp)
    const b = await commitSale(writer, db, inp)
    expect(b.invoiceId).toBe(a.invoiceId)
    expect(b.label).toBe(a.label)
    expect(b.receipt).toEqual(a.receipt)
    expect(ops(sqlite).filter((o) => o.entity_type === 'invoice')).toHaveLength(1)
  })

  it('composition merchant: bill of supply, zero tax', async () => {
    const comp: MerchantProfile = { ...regular, gstMode: 'composition' }
    const { sqlite, db, writer } = await setup(comp)
    const inp = input(comp, [one()], [{ mode: 'cash', amountPaise: 118000 }])
    expect(inp.bill.taxPaise).toBe(0)
    const r = await commitSale(writer, db, inp)
    const inv = JSON.parse(ops(sqlite)[0].payload)
    expect(inv).toMatchObject({ docType: 'bill_of_supply', taxPaise: 0, totalPaise: 118000 })
    expect(inv.lines[0]).toMatchObject({ taxRateBp: 0, taxPaise: 0 })
    expect(r.receipt.docType).toBe('bill_of_supply')
  })

  it('carries an owner approval on the invoice and refuses a blank reason', async () => {
    const { sqlite, db, writer } = await setup()
    const approval = { approverUserId: '44444444-4444-4444-8444-444444444444', reason: ' loyal customer ' }
    await commitSale(writer, db, input(regular, [one()], [{ mode: 'cash', amountPaise: 118000 }], { approval }))
    expect(JSON.parse(ops(sqlite)[0].payload).approval).toEqual({ approverUserId: approval.approverUserId, reason: 'loyal customer' })
    await expect(
      commitSale(writer, db, input(regular, [one()], [{ mode: 'cash', amountPaise: 118000 }], { approval: { ...approval, reason: ' ' } })),
    ).rejects.toThrow(/approval_reason_required/)
  })

  it('refuses a card tender that carries a full card number', async () => {
    const { db, writer } = await setup()
    await expect(
      commitSale(writer, db, input(regular, [one()], [{ mode: 'card', amountPaise: 118000, reference: '4111 1111 1111 1111' }])),
    ).rejects.toThrow(/card_reference_looks_like_pan/)
    await commitSale(writer, db, input(regular, [one()], [{ mode: 'card', amountPaise: 118000, reference: '1111' }]))
  })

  it('uses the Indian financial year of the invoice date for the series (April rollover)', async () => {
    const { db, writer } = await setup()
    const r = await commitSale(writer, db, input(regular, [one()], [{ mode: 'cash', amountPaise: 118000 }], { now: Date.parse('2027-03-31T19:00:00Z') }))
    // 2027-03-31T19:00Z is 2027-04-01 00:30 IST
    expect(r.series).toBe('A1B2C3D4-2027-28')
    expect(r.number).toBe(1)
  })

  it('never calls fetch', async () => {
    const { db, writer } = await setup()
    const orig = globalThis.fetch
    globalThis.fetch = (() => {
      throw new Error('network used')
    }) as typeof fetch
    try {
      await commitSale(writer, db, input(regular, [one()], [{ mode: 'cash', amountPaise: 118000 }]))
    } finally {
      globalThis.fetch = orig
    }
  })

  it('refuses mismatched or inconsistent bills', async () => {
    const { db, writer } = await setup()
    const inp = input(regular, [one()], [{ mode: 'cash', amountPaise: 118000 }])
    await expect(commitSale(writer, db, { ...inp, lines: [] })).rejects.toThrow(/empty_cart/)
    await expect(commitSale(writer, db, { ...inp, lines: [one({ qtyMilli: 2000 })] })).rejects.toThrow(/bill_lines_mismatch/)
    await expect(commitSale(writer, db, { ...inp, bill: { ...inp.bill, totalPaise: inp.bill.totalPaise + 100 } })).rejects.toThrow(/bill_inconsistent/)
  })
})
