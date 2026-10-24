import { describe, expect, it } from 'vitest'
import { OpLogWriter } from '../sync/oplog'
import { makeSchemaDb } from '../sync/schemaDb'
import { layoutLines, buildReceiptLayout } from '../print/receipt'
import { priceCart } from './calc'
import { commitSale, type CommitSaleInput } from './commit'
import { listHistory, loadInvoiceDetail, receiptFromInvoice } from './history'
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
const T0 = Date.parse('2026-10-17T10:00:00.000Z')
const DAY = 86_400_000
const regular: MerchantProfile = { ...defaultProfile(), businessName: 'Sharma Store', gstMode: 'regular', gstin: '27ABCDE1234F1Z5' }
let seq = 0

async function world() {
  const { sqlite, db } = await makeSchemaDb()
  sqlite.exec(`INSERT INTO product (id, tenant_id, name, unit, local_name) VALUES ('${P1}', '${IDENTITY.tenantId}', 'Rice', 'kg', 'चावल'), ('${P2}', '${IDENTITY.tenantId}', 'Soap', 'piece', NULL)`)
  sqlite.exec(`INSERT INTO party (id, tenant_id, name, phone, party_type, active) VALUES ('${PARTY.id}', '${IDENTITY.tenantId}', 'Ramesh', '9876543210', 'customer', 1)`)
  let now = T0
  const writer = new OpLogWriter(db, { deviceId: IDENTITY.deviceId, storeId: IDENTITY.storeId }, () => now)
  return { sqlite, db, writer, at: (ms: number) => (now = ms) }
}
type World = Awaited<ReturnType<typeof world>>

async function sell(w: World, at: number, lines: CartLine[], tenders: Tender[], party: CommitSaleInput['party'] = null) {
  w.at(at)
  const bill = priceCart({ lines, billDiscount: null }, { gstMode: 'regular', rounding: 'nearest_rupee', onDate: '2026-10-17' })
  return commitSale(w.writer, w.db, { requestId: `s${++seq}`, bill, lines, party, tenders, profile: regular, identity: IDENTITY, actorUserId: null, now: at })
}
const rice = (over: Partial<CartLine> = {}) => line({ productId: P1, name: 'Rice', localName: 'चावल', qtyMilli: 3000, unitPricePaise: 11800, taxRateBp: 1800, unit: 'kg', ...over })
const soap = (over: Partial<CartLine> = {}) => line({ productId: P2, name: 'Soap', qtyMilli: 2000, unitPricePaise: 5000, taxRateBp: 500, ...over })

describe('listHistory', () => {
  it('lists sales and credit notes newest first with modes, party and returned flag', async () => {
    const w = await world()
    const a = await sell(w, T0, [rice()], [{ mode: 'cash', amountPaise: 35400 }])
    const b = await sell(w, T0 + 60_000, [soap()], [{ mode: 'upi', amountPaise: 5000 }, { mode: 'cash', amountPaise: 5000 }], PARTY)
    w.at(T0 + 120_000)
    const ret = await commitReturn(w.writer, w.db, {
      requestId: `r${++seq}`, invoiceId: a.invoiceId, selections: [{ lineNo: 1, qtyMilli: 1000 }], reason: 'damaged',
      refunds: [{ kind: 'cash', amountPaise: 11800 }], profile: regular, identity: IDENTITY, actorUserId: null, now: T0 + 120_000,
    })
    const { entries, next } = await listHistory(w.db)
    expect(next).toBeNull()
    expect(entries.map((e) => [e.kind, e.id])).toEqual([['credit_note', ret.creditNoteId], ['sale', b.invoiceId], ['sale', a.invoiceId]])
    expect(entries[0]).toMatchObject({ invoiceId: a.invoiceId, totalPaise: 11800, modes: [] })
    expect(entries[1]).toMatchObject({ partyName: 'Ramesh', label: b.label })
    expect([...entries[1].modes].sort()).toEqual(['cash', 'upi'])
    expect(entries[2]).toMatchObject({ returned: true, modes: ['cash'], partyName: null })
  })

  it('filters by IST day, mode, type, party and number or phone search', async () => {
    const w = await world()
    await sell(w, T0, [rice()], [{ mode: 'cash', amountPaise: 35400 }])
    const khata = await sell(w, T0 + DAY, [soap()], [{ mode: 'credit', amountPaise: 10000 }], PARTY)
    // 18:35 UTC on the 17th is already the 18th in IST
    const late = await sell(w, Date.parse('2026-10-17T18:35:00.000Z'), [soap()], [{ mode: 'card', amountPaise: 10000 }])
    const ids = async (f: Parameters<typeof listHistory>[1]) => (await listHistory(w.db, f)).entries.map((e) => e.id)

    expect(await ids({ fromDate: '2026-10-18', toDate: '2026-10-18' })).toEqual([khata.invoiceId, late.invoiceId])
    expect(await ids({ mode: 'credit' })).toEqual([khata.invoiceId])
    expect(await ids({ mode: 'card' })).toEqual([late.invoiceId])
    expect(await ids({ partyId: PARTY.id })).toEqual([khata.invoiceId])
    expect(await ids({ query: '98765' })).toEqual([khata.invoiceId])
    expect(await ids({ query: 'ramesh' })).toEqual([khata.invoiceId])
    expect(await ids({ query: String(late.number) })).toContain(late.invoiceId)
    expect(await ids({ docType: 'credit_note' })).toEqual([])
    expect(await ids({ docType: 'bill_of_supply' })).toEqual([])
    expect(await ids({ query: '100%' })).toEqual([]) // LIKE wildcards are escaped
  })

  it('pages by keyset without gaps or repeats, even with equal timestamps', async () => {
    const w = await world()
    const made: string[] = []
    for (let i = 0; i < 7; i++) made.push((await sell(w, T0 + (i < 4 ? 0 : i * 1000), [soap({ qtyMilli: 1000 })], [{ mode: 'cash', amountPaise: 5000 }])).invoiceId)
    const seen: string[] = []
    let cursor = null
    for (let guard = 0; guard < 10; guard++) {
      const page: Awaited<ReturnType<typeof listHistory>> = await listHistory(w.db, {}, cursor, 3)
      seen.push(...page.entries.map((e) => e.id))
      cursor = page.next
      if (!cursor) break
    }
    expect(seen).toHaveLength(7)
    expect(new Set(seen).size).toBe(7)
    expect([...seen].sort()).toEqual([...made].sort())
  })
})

describe('reprint', () => {
  it('rebuilds the receipt of an old invoice, marked as a duplicate, with the same totals and lines', async () => {
    const w = await world()
    const sale = await sell(w, T0, [rice(), soap()], [{ mode: 'cash', amountPaise: 50000 }])
    const detail = await loadInvoiceDetail(w.db, sale.invoiceId)
    const r = receiptFromInvoice(detail, regular)
    expect(r.duplicate).toBe(true)
    expect(r).toMatchObject({ label: sale.label, totalPaise: sale.receipt.totalPaise, subtotalPaise: sale.receipt.subtotalPaise, taxPaise: sale.receipt.taxPaise, roundOffPaise: sale.receipt.roundOffPaise })
    expect(r.lines).toEqual(sale.receipt.lines.map((l) => ({ ...l, unit: l.name === 'Rice' ? 'kg' : 'piece' })))
    expect(r.taxBreakup).toEqual(sale.receipt.taxBreakup)
    expect(r.creditPaise).toBe(0)

    const original = layoutLines(buildReceiptLayout(sale.receipt, { widthMm: 80, lang: 'en' }))
    const again = layoutLines(buildReceiptLayout(r, { widthMm: 80, lang: 'en' }))
    const isMarker = (l: string) => l.trim() === 'DUPLICATE COPY'
    expect(again.filter(isMarker)).toHaveLength(1)
    expect(original.filter(isMarker)).toHaveLength(0)
    // only the payment lines differ: the device stores what was settled (454), not the cash handed over (500) and the change
    const tendered = (l: string) => /^(Paid|Change)\b/.test(l.trim())
    expect(again.filter((l) => !isMarker(l) && !tendered(l))).toEqual(original.filter((l) => !tendered(l)))
    expect(again.find(tendered)).toMatch(new RegExp(`${(sale.receipt.totalPaise / 100).toFixed(2)}$`))
  })

  it('shows what is still owed on khata and lists linked credit notes', async () => {
    const w = await world()
    const sale = await sell(w, T0, [rice()], [{ mode: 'cash', amountPaise: 10000 }, { mode: 'credit', amountPaise: 25400 }], PARTY)
    const detail = await loadInvoiceDetail(w.db, sale.invoiceId)
    expect(receiptFromInvoice(detail, regular).creditPaise).toBe(25400)
    expect(detail.creditNotes).toEqual([])
    await expect(loadInvoiceDetail(w.db, 'nope')).rejects.toThrow(/invoice_not_found/)
  })
})
