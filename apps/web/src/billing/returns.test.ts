import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { OpLogWriter } from '../sync/oplog'
import { makeSchemaDb } from '../sync/schemaDb'
import { priceCart } from './calc'
import { commitSale, type CommitSaleInput } from './commit'
import { commitReturn, computeReturn, loadInvoiceForReturn, suggestRefund, type CommitReturnInput, type ReturnInvoice, type ReturnInvoiceLine } from './returns'
import { cashLedger, openShift } from './shift'
import { defaultProfile } from './settings'
import { first, line } from './testKit'
import type { CartLine, MerchantProfile, Tender } from './types'

const IDENTITY = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  storeId: '11111111-1111-4111-8111-111111111111',
  deviceId: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
}
const P1 = '22222222-2222-4222-8222-222222222221'
const P2 = '22222222-2222-4222-8222-222222222222'
const PARTY = { id: '33333333-3333-4333-8333-333333333333', name: 'Ramesh' }
const NOW = Date.parse('2026-10-17T10:00:00.000Z')
const regular: MerchantProfile = { ...defaultProfile(), businessName: 'Sharma Store', gstMode: 'regular', gstin: '27ABCDE1234F1Z5' }
let seq = 0

async function world() {
  const { sqlite, db } = await makeSchemaDb()
  sqlite.exec(`INSERT INTO product (id, tenant_id, name, unit) VALUES ('${P1}', '${IDENTITY.tenantId}', 'Rice', 'kg'), ('${P2}', '${IDENTITY.tenantId}', 'Soap', 'piece')`)
  const writer = new OpLogWriter(db, { deviceId: IDENTITY.deviceId, storeId: IDENTITY.storeId }, () => NOW)
  return { sqlite, db, writer }
}

async function sell(w: Awaited<ReturnType<typeof world>>, lines: CartLine[], tenders: Tender[], party: CommitSaleInput['party'] = null) {
  const bill = priceCart({ lines, billDiscount: null }, { gstMode: 'regular', rounding: 'nearest_rupee', onDate: '2026-10-17' })
  return commitSale(w.writer, w.db, { requestId: `s${++seq}`, bill, lines, party, tenders, profile: regular, identity: IDENTITY, actorUserId: null, now: NOW })
}

function ret(over: Partial<CommitReturnInput> & Pick<CommitReturnInput, 'invoiceId' | 'selections' | 'refunds'>): CommitReturnInput {
  return { requestId: `r${++seq}`, reason: 'damaged', profile: regular, identity: IDENTITY, actorUserId: null, now: NOW + 60_000, ...over }
}

const opsOf = (sqlite: Parameters<typeof first>[0]) =>
  (sqlite.prepare('SELECT entity_type, payload FROM op_log ORDER BY local_seq').all() as { entity_type: string; payload: string }[]).map((o) => ({
    type: o.entity_type,
    p: JSON.parse(o.payload),
  }))

describe('computeReturn properties', () => {
  const lineArb = fc
    .record({
      qty: fc.integer({ min: 1, max: 50_000 }),
      total: fc.integer({ min: 0, max: 2_000_000 }),
      taxRatio: fc.double({ min: 0, max: 1, noNaN: true }),
    })
    .map(({ qty, total, taxRatio }): ReturnInvoiceLine => {
      const tax = Math.floor(total * taxRatio)
      return {
        lineNo: 1, productId: P1, name: 'x', unit: 'piece', qtyMilli: qty, unitPricePaise: 1, discountPaise: 0, hsn: null, taxRateBp: 1800,
        taxPaise: tax, lineTotalPaise: total, returnedQtyMilli: 0, returnedTaxPaise: 0, returnedTotalPaise: 0,
      }
    })
  const asInvoice = (lines: ReturnInvoiceLine[]): ReturnInvoice => ({
    id: 'i', series: 'S', number: 1, label: 'S/1', docType: 'tax_invoice', invoiceDate: '2026-10-17', partyId: null,
    totalPaise: lines.reduce((a, l) => a + l.lineTotalPaise, 0), lines, payments: [], paidPaise: 0, returnedTotalPaise: 0,
  })

  it('any partition of the quantity, returned step by step, sums EXACTLY to the line total and tax and never exceeds', () => {
    fc.assert(
      fc.property(lineArb, fc.array(fc.integer({ min: 1, max: 10_000 }), { minLength: 1, maxLength: 12 }), (base, cuts) => {
        // partition qty into the given cuts (clipped), remainder last
        const parts: number[] = []
        let left = base.qtyMilli
        for (const c of cuts) {
          const q = Math.min(c, left)
          if (q > 0) parts.push(q)
          left -= q
        }
        if (left > 0) parts.push(left)
        let inv = asInvoice([base])
        let sumTotal = 0
        let sumTax = 0
        for (const q of parts) {
          const r = computeReturn(inv, [{ lineNo: 1, qtyMilli: q }])
          const l = r.lines[0]
          expect(l.lineTotalPaise).toBeGreaterThanOrEqual(0)
          expect(l.taxPaise).toBeGreaterThanOrEqual(0)
          sumTotal += l.lineTotalPaise
          sumTax += l.taxPaise
          expect(sumTotal).toBeLessThanOrEqual(base.lineTotalPaise)
          expect(sumTax).toBeLessThanOrEqual(base.taxPaise)
          const cur = inv.lines[0]
          inv = asInvoice([{ ...cur, returnedQtyMilli: cur.returnedQtyMilli + q, returnedTotalPaise: cur.returnedTotalPaise + l.lineTotalPaise, returnedTaxPaise: cur.returnedTaxPaise + (l.taxPaise ?? 0) }])
        }
        expect(sumTotal).toBe(base.lineTotalPaise)
        expect(sumTax).toBe(base.taxPaise)
        expect(() => computeReturn(inv, [{ lineNo: 1, qtyMilli: 1 }])).toThrow(/return_exceeds_sold/)
      }),
      { numRuns: 2000 },
    )
  })

  it('a full single return reverses the line exactly; one return of many lines sums the invoice', () => {
    fc.assert(
      fc.property(fc.array(lineArb, { minLength: 1, maxLength: 8 }), (ls) => {
        const lines = ls.map((l, i) => ({ ...l, lineNo: i + 1 }))
        const inv = asInvoice(lines)
        const r = computeReturn(inv, lines.map((l) => ({ lineNo: l.lineNo, qtyMilli: l.qtyMilli })))
        expect(r.totalPaise).toBe(inv.totalPaise)
        expect(r.taxPaise).toBe(lines.reduce((a, l) => a + l.taxPaise, 0))
      }),
      { numRuns: 1000 },
    )
  })

  it('refuses over-return, unknown lines, bad quantities', () => {
    const inv = asInvoice([{ lineNo: 1, productId: P1, name: 'x', unit: 'piece', qtyMilli: 2000, unitPricePaise: 1, discountPaise: 0, hsn: null, taxRateBp: 0, taxPaise: 0, lineTotalPaise: 500, returnedQtyMilli: 0, returnedTaxPaise: 0, returnedTotalPaise: 0 }])
    expect(() => computeReturn(inv, [{ lineNo: 1, qtyMilli: 2001 }])).toThrow(/return_exceeds_sold/)
    expect(() => computeReturn(inv, [{ lineNo: 1, qtyMilli: 1500 }, { lineNo: 1, qtyMilli: 600 }])).toThrow(/return_exceeds_sold/)
    expect(() => computeReturn(inv, [{ lineNo: 9, qtyMilli: 1 }])).toThrow(/unknown_line/)
    expect(() => computeReturn(inv, [{ lineNo: 1, qtyMilli: 0 }])).toThrow(/invalid_quantity/)
    expect(() => computeReturn(inv, [{ lineNo: 1, qtyMilli: -5 }])).toThrow(/invalid_quantity/)
    expect(() => computeReturn(inv, [])).toThrow(/nothing_to_return/)
  })
})

describe('commitReturn', () => {
  const rice = (over: Partial<CartLine> = {}) => line({ productId: P1, qtyMilli: 3000, unitPricePaise: 11800, taxRateBp: 1800, unit: 'kg', ...over })
  const soap = (over: Partial<CartLine> = {}) => line({ productId: P2, qtyMilli: 2000, unitPricePaise: 5000, taxRateBp: 500, ...over })

  it('loads the invoice with lines, payments and what was already returned', async () => {
    const w = await world()
    const sale = await sell(w, [rice(), soap()], [{ mode: 'cash', amountPaise: 50000 }])
    const inv = await loadInvoiceForReturn(w.db, sale.invoiceId)
    expect(inv.label).toBe(sale.label)
    expect(inv.lines.map((l) => [l.lineNo, l.name, l.unit, l.returnedQtyMilli])).toEqual([[1, 'Rice', 'kg', 0], [2, 'Soap', 'piece', 0]])
    expect(inv.paidPaise).toBe(sale.receipt.totalPaise)
    await expect(loadInvoiceForReturn(w.db, 'nope')).rejects.toThrow(/invoice_not_found/)
  })

  it('cash refund: credit note, restock, payment out; ops payload checks; refund = credit note total', async () => {
    const w = await world()
    const sale = await sell(w, [rice(), soap()], [{ mode: 'cash', amountPaise: 50000 }])
    const inv = await loadInvoiceForReturn(w.db, sale.invoiceId)
    const expected = computeReturn(inv, [{ lineNo: 1, qtyMilli: 1000 }])
    const r = await commitReturn(w.writer, w.db, ret({ invoiceId: sale.invoiceId, selections: [{ lineNo: 1, qtyMilli: 1000 }], refunds: [{ kind: 'cash', amountPaise: expected.totalPaise }] }))
    expect(r.label).toBe('A1B2C3D4/CN/2026-27/1')
    expect(r.totalPaise).toBe(expected.totalPaise)
    const ops = opsOf(w.sqlite).slice(sale.receipt.lines.length + 2) // after invoice + 2 stock + 1 payment
    expect(ops.map((o) => o.type)).toEqual(['credit_note', 'stock_movement', 'payment'])
    expect(ops[0].p).toMatchObject({ series: 'A1B2C3D4-CN-2026-27', number: 1, invoiceId: sale.invoiceId, reason: 'damaged', totalPaise: expected.totalPaise })
    expect(ops[0].p.lines).toEqual(expected.lines)
    expect(ops[0].p.lines.reduce((a: number, l: { lineTotalPaise: number }) => a + l.lineTotalPaise, 0)).toBe(ops[0].p.totalPaise)
    expect(ops[1].p).toMatchObject({ productId: P1, qtyMilli: 1000, reason: 'sale_return', refType: 'credit_note', refId: r.creditNoteId })
    expect(ops[2].p).toMatchObject({ direction: 'out', mode: 'cash', amountPaise: expected.totalPaise, invoiceId: sale.invoiceId })
    // stock: sold 3 + 2 then 1 back
    expect(first(w.sqlite, 'SELECT qty_milli FROM stock_balance WHERE product_id = ?', P1)).toEqual({ qty_milli: -2000 })
    expect(first(w.sqlite, 'SELECT total_paise FROM credit_note WHERE id = ?', r.creditNoteId)).toEqual({ total_paise: expected.totalPaise })
    expect(r.receipt).toMatchObject({ kind: 'credit_note', docType: 'credit_note', againstLabel: sale.label, totalPaise: expected.totalPaise })
  })

  it('refund to khata: credit entry reduces the balance, no payment', async () => {
    const w = await world()
    const sale = await sell(w, [rice()], [{ mode: 'credit', amountPaise: 35400 }], PARTY)
    expect(first(w.sqlite, 'SELECT balance_paise FROM khata_balance WHERE party_id = ?', PARTY.id)).toEqual({ balance_paise: 35400 })
    const paymentsBefore = first<{ n: number }>(w.sqlite, 'SELECT count(*) AS n FROM payment')!.n
    const r = await commitReturn(w.writer, w.db, ret({ invoiceId: sale.invoiceId, selections: [{ lineNo: 1, qtyMilli: 1000 }], refunds: [{ kind: 'khata', amountPaise: 11800 }], partyName: 'Ramesh' }))
    expect(r.totalPaise).toBe(11800)
    expect(first(w.sqlite, 'SELECT balance_paise FROM khata_balance WHERE party_id = ?', PARTY.id)).toEqual({ balance_paise: 23600 })
    expect(first<{ n: number }>(w.sqlite, 'SELECT count(*) AS n FROM payment')!.n).toBe(paymentsBefore)
    const k = opsOf(w.sqlite).filter((o) => o.type === 'khata_entry').pop()!
    expect(k.p).toMatchObject({ partyId: PARTY.id, direction: 'credit', amountPaise: 11800, refType: 'credit_note', refId: r.creditNoteId })
    expect(r.receipt.creditPaise).toBe(11800)
  })

  it('refuses over-return across two credit notes, and writes nothing for the refused one', async () => {
    const w = await world()
    const sale = await sell(w, [soap()], [{ mode: 'cash', amountPaise: 10000 }])
    await commitReturn(w.writer, w.db, ret({ invoiceId: sale.invoiceId, selections: [{ lineNo: 1, qtyMilli: 1500 }], refunds: [{ kind: 'cash', amountPaise: 7500 }] }))
    const before = opsOf(w.sqlite).length
    await expect(
      commitReturn(w.writer, w.db, ret({ invoiceId: sale.invoiceId, selections: [{ lineNo: 1, qtyMilli: 600 }], refunds: [{ kind: 'cash', amountPaise: 1500 }] })),
    ).rejects.toThrow(/return_exceeds_sold/)
    expect(opsOf(w.sqlite)).toHaveLength(before)
    // the remaining 500 can still go, and takes the exact remainder (10000 total, 7500 already credited)
    const last = await commitReturn(w.writer, w.db, ret({ invoiceId: sale.invoiceId, selections: [{ lineNo: 1, qtyMilli: 500 }], refunds: [{ kind: 'cash', amountPaise: 2500 }] }))
    expect(last.totalPaise).toBe(2500)
    const inv = await loadInvoiceForReturn(w.db, sale.invoiceId)
    expect(inv.returnedTotalPaise).toBe(10000)
    expect(inv.lines[0].returnedQtyMilli).toBe(2000)
  })

  it('full return of a mixed invoice reverses it exactly', async () => {
    const w = await world()
    const sale = await sell(w, [rice({ qtyMilli: 2333 }), soap({ qtyMilli: 3001 })], [{ mode: 'cash', amountPaise: 100000 }])
    const inv = await loadInvoiceForReturn(w.db, sale.invoiceId)
    const total = inv.lines.reduce((a, l) => a + l.lineTotalPaise, 0)
    const r = await commitReturn(w.writer, w.db, ret({
      invoiceId: sale.invoiceId,
      selections: inv.lines.map((l) => ({ lineNo: l.lineNo, qtyMilli: l.qtyMilli })),
      refunds: [{ kind: 'cash', amountPaise: total }],
    }))
    expect(r.totalPaise).toBe(total)
    expect(first(w.sqlite, 'SELECT qty_milli FROM stock_balance WHERE product_id = ?', P1)).toEqual({ qty_milli: 0 })
    expect(first(w.sqlite, 'SELECT qty_milli FROM stock_balance WHERE product_id = ?', P2)).toEqual({ qty_milli: 0 })
  })

  it('validates reason, refund sum, khata without a customer, zero amount, idempotency and approval', async () => {
    const w = await world()
    const sale = await sell(w, [rice()], [{ mode: 'cash', amountPaise: 35400 }])
    const sel = [{ lineNo: 1, qtyMilli: 1000 }]
    const base = { invoiceId: sale.invoiceId, selections: sel }
    await expect(commitReturn(w.writer, w.db, ret({ ...base, reason: '  ', refunds: [{ kind: 'cash', amountPaise: 11800 }] }))).rejects.toThrow(/reason_required/)
    await expect(commitReturn(w.writer, w.db, ret({ ...base, refunds: [{ kind: 'cash', amountPaise: 11700 }] }))).rejects.toThrow(/refund_mismatch/)
    await expect(commitReturn(w.writer, w.db, ret({ ...base, refunds: [{ kind: 'khata', amountPaise: 11800 }] }))).rejects.toThrow(/credit_needs_customer/)
    await expect(commitReturn(w.writer, w.db, ret({ invoiceId: sale.invoiceId, selections: [{ lineNo: 1, qtyMilli: 1 }], refunds: [{ kind: 'cash', amountPaise: 1 }] }))).rejects.toThrow(/return_amount_zero|refund_mismatch/)
    await expect(commitReturn(w.writer, w.db, ret({ ...base, invoiceId: 'missing', refunds: [{ kind: 'cash', amountPaise: 1 }] }))).rejects.toThrow(/invoice_not_found/)
    const approval = { approverUserId: '44444444-4444-4444-8444-444444444444', reason: 'manager ok' }
    const input = ret({ ...base, refunds: [{ kind: 'cash', amountPaise: 11800 }], approval })
    const a = await commitReturn(w.writer, w.db, input)
    const b = await commitReturn(w.writer, w.db, input)
    expect(b.creditNoteId).toBe(a.creditNoteId)
    const cns = opsOf(w.sqlite).filter((o) => o.type === 'credit_note')
    expect(cns).toHaveLength(1)
    expect(cns[0].p.approval).toEqual(approval)
  })

  it('a cash refund reduces the open shift cash', async () => {
    const w = await world()
    await openShift(w.writer, { openingCashPaise: 100000, identity: IDENTITY, actorUserId: null, now: NOW })
    const sale = await sell(w, [rice()], [{ mode: 'cash', amountPaise: 35400 }])
    await commitReturn(w.writer, w.db, ret({ invoiceId: sale.invoiceId, selections: [{ lineNo: 1, qtyMilli: 1000 }], refunds: [{ kind: 'cash', amountPaise: 11800 }] }))
    const shiftId = first<{ id: string }>(w.sqlite, 'SELECT id FROM shift')!.id
    expect(await cashLedger(w.db, shiftId)).toEqual({ inPaise: 35400, outPaise: 11800 })
  })
})

describe('suggestRefund', () => {
  it('sends the still-owed part to khata first, the rest to the chosen mode', () => {
    const inv = { totalPaise: 120000, paidPaise: 50000, returnedTotalPaise: 0, partyId: 'p' }
    expect(suggestRefund(inv, 30000)).toEqual([{ kind: 'khata', amountPaise: 30000 }])
    expect(suggestRefund(inv, 90000, 'upi')).toEqual([{ kind: 'khata', amountPaise: 70000 }, { kind: 'upi', amountPaise: 20000 }])
    expect(suggestRefund({ ...inv, partyId: null }, 30000)).toEqual([{ kind: 'cash', amountPaise: 30000 }])
  })
})
