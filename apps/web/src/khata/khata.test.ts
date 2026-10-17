import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { commitSale } from '../billing/commit'
import { priceCart } from '../billing/calc'
import { defaultProfile } from '../billing/settings'
import { openShift, closeShift } from '../billing/shift'
import { first, line } from '../billing/testKit'
import { OpLogWriter } from '../sync/oplog'
import { makeSchemaDb } from '../sync/schemaDb'
import { collectPayment, recordPreviousBalance } from './collect'
import { flushConsent, hasConsent, recordConsent } from './consent'
import { checkCreditLimit, listCustomers, loadStatement } from './ledger'
import { updateCustomer } from './party'
import { buildReminderText, buildThanksText } from './reminder'

const IDENTITY = { tenantId: '00000000-0000-4000-8000-000000000001', storeId: '11111111-1111-4111-8111-111111111111', deviceId: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' }
const RAMESH = '33333333-3333-4333-8333-333333333333'
const SURESH = '33333333-3333-4333-8333-333333333334'
let t = Date.parse('2026-10-01T10:00:00.000Z')
const tick = () => (t += 60_000)
let req = 0

async function setup() {
  const { sqlite, db } = await makeSchemaDb()
  const writer = new OpLogWriter(db, { deviceId: IDENTITY.deviceId, storeId: IDENTITY.storeId }, tick)
  for (const [id, name, phone] of [[RAMESH, 'Ramesh', '9876543210'], [SURESH, 'Suresh', null]] as const) {
    await db.execute(`INSERT INTO party (id, tenant_id, name, party_type, phone, active) VALUES (?, ?, ?, 'customer', ?, 1)`, [id, IDENTITY.tenantId, name, phone])
  }
  return { sqlite, db, writer }
}

const collect = (writer: OpLogWriter, partyId: string, amountPaise: number, over: Partial<Parameters<typeof collectPayment>[1]> = {}) =>
  collectPayment(writer, { requestId: `c${++req}`, partyId, amountPaise, mode: 'cash', identity: IDENTITY, actorUserId: null, now: tick(), ...over })
const owe = (writer: OpLogWriter, partyId: string, amountPaise: number) =>
  recordPreviousBalance(writer, { requestId: `p${++req}`, partyId, amountPaise, identity: IDENTITY, actorUserId: null, now: tick() })

describe('collecting payments', () => {
  it('writes a payment and a khata credit in one transaction and lowers the balance', async () => {
    const { sqlite, db, writer } = await setup()
    await owe(writer, RAMESH, 120_000)
    const r = await collect(writer, RAMESH, 50_000, { mode: 'upi', reference: 'UTR123' })
    expect(r.balanceAfterPaise).toBe(70_000)
    expect(first(sqlite, 'SELECT balance_paise FROM khata_balance WHERE party_id = ?', RAMESH)).toEqual({ balance_paise: 70_000 })
    const queued = sqlite.prepare("SELECT entity_type, payload FROM op_log ORDER BY local_seq").all() as { entity_type: string; payload: string }[]
    expect(queued.map((o) => o.entity_type)).toEqual(['khata_entry', 'payment', 'khata_entry'])
    const pay = JSON.parse(queued[1].payload)
    expect(pay).toMatchObject({ partyId: RAMESH, direction: 'in', mode: 'upi', amountPaise: 50_000, reference: 'UTR123', invoiceId: null })
    expect(JSON.parse(queued[2].payload)).toMatchObject({ direction: 'credit', amountPaise: 50_000, refType: 'payment', refId: r.paymentId })
    const st = await loadStatement(db, RAMESH)
    expect(st!.lines.map((l) => [l.direction, l.amountPaise, l.balanceAfterPaise])).toEqual([['debit', 120_000, 120_000], ['credit', 50_000, 70_000]])
  })

  it('a double tap with the same request id is one payment', async () => {
    const { sqlite, writer } = await setup()
    await owe(writer, RAMESH, 10_000)
    const a = await collectPayment(writer, { requestId: 'same', partyId: RAMESH, amountPaise: 4_000, mode: 'cash', identity: IDENTITY, actorUserId: null, now: tick() })
    const b = await collectPayment(writer, { requestId: 'same', partyId: RAMESH, amountPaise: 4_000, mode: 'cash', identity: IDENTITY, actorUserId: null, now: tick() })
    expect(b).toEqual(a)
    expect(first(sqlite, "SELECT count(*) AS n FROM op_log WHERE entity_type = 'payment'")).toEqual({ n: 1 })
  })

  it('more than owed becomes an advance, shown negative', async () => {
    const { db, writer } = await setup()
    await owe(writer, RAMESH, 1_000)
    const r = await collect(writer, RAMESH, 5_000)
    expect(r.balanceAfterPaise).toBe(-4_000)
    expect((await listCustomers(db, { filter: 'advance' })).map((c) => c.name)).toEqual(['Ramesh'])
    expect(await listCustomers(db, { filter: 'owing' })).toEqual([])
  })

  it('cash lands in the open shift, UPI does not', async () => {
    const { db, writer } = await setup()
    await owe(writer, RAMESH, 100_000)
    await openShift(writer, { openingCashPaise: 100_000, identity: IDENTITY, actorUserId: null, now: tick() })
    await collect(writer, RAMESH, 30_000)
    await collect(writer, RAMESH, 20_000, { mode: 'upi' })
    const r = await closeShift(writer, { declaredCashPaise: 130_000, identity: IDENTITY, actorUserId: null, now: tick() })
    expect(r.expectedCashPaise).toBe(130_000)
    expect(r.variancePaise).toBe(0)
    void db
  })

  it('refuses nonsense and unknown customers, and writes nothing', async () => {
    const { sqlite, writer } = await setup()
    await expect(collect(writer, RAMESH, 0)).rejects.toMatchObject({ code: 'invalid_amount' })
    await expect(collect(writer, RAMESH, 1.5)).rejects.toMatchObject({ code: 'invalid_amount' })
    await expect(collect(writer, 'nobody', 100)).rejects.toMatchObject({ code: 'customer_not_found' })
    await expect(collect(writer, RAMESH, 100, { mode: 'card', reference: '4111111111111111' })).rejects.toMatchObject({ code: 'card_reference_looks_like_pan' })
    expect(first(sqlite, 'SELECT count(*) AS n FROM op_log')).toEqual({ n: 0 })
  })

  it('the balance always equals the sum of the statement lines (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.tuple(fc.boolean(), fc.integer({ min: 1, max: 500_000 })), { minLength: 1, maxLength: 12 }), async (steps) => {
        const { db, writer } = await setup()
        for (const [isDebit, amount] of steps) await (isDebit ? owe(writer, RAMESH, amount) : collect(writer, RAMESH, amount))
        const st = (await loadStatement(db, RAMESH))!
        const sum = st.lines.reduce((a, l) => a + (l.direction === 'debit' ? l.amountPaise : -l.amountPaise), 0)
        expect(st.customer.balancePaise).toBe(sum)
        expect(st.lines.at(-1)!.balanceAfterPaise).toBe(sum)
        expect(st.ageing.owedPaise - st.ageing.advancePaise).toBe(sum)
      }),
      { numRuns: 25 },
    )
  })
})

describe('credit sales show up on the statement', () => {
  it('a bill on credit adds a debit line labelled with the invoice number', async () => {
    const { db, writer } = await setup()
    const lines = [line({ qtyMilli: 1000, unitPricePaise: 120_000 })]
    const profile = defaultProfile()
    const bill = priceCart({ lines, billDiscount: null }, { gstMode: 'non_gst', rounding: 'nearest_rupee', onDate: '2026-10-17' })
    await commitSale(writer, db, {
      requestId: 'sale-1', bill, lines, party: { id: RAMESH, name: 'Ramesh' },
      tenders: [{ mode: 'upi', amountPaise: 50_000 }, { mode: 'credit', amountPaise: 70_000 }],
      profile, identity: IDENTITY, actorUserId: null, now: tick(),
    })
    const st = (await loadStatement(db, RAMESH))!
    expect(st.customer.balancePaise).toBe(70_000)
    expect(st.lines).toHaveLength(1)
    expect(st.lines[0]).toMatchObject({ direction: 'debit', amountPaise: 70_000, refType: 'invoice' })
    expect(st.lines[0].invoiceLabel).toMatch(/^A1B2C3D4\/\d{4}-\d{2}\/1$/)
    await collect(writer, RAMESH, 70_000)
    expect((await loadStatement(db, RAMESH))!.customer.balancePaise).toBe(0)
  })
})

describe('customer list', () => {
  it('sorts by amount or by how long it has been owed, and searches by name or phone', async () => {
    const { db, writer } = await setup()
    t = Date.parse('2026-05-01T10:00:00.000Z')
    await owe(writer, SURESH, 9_000)
    t = Date.parse('2026-09-30T10:00:00.000Z')
    await owe(writer, RAMESH, 90_000)
    const asOf = Date.parse('2026-10-17T10:00:00.000Z')
    expect((await listCustomers(db, { sort: 'amount', asOf })).map((c) => c.name)).toEqual(['Ramesh', 'Suresh'])
    const byAge = await listCustomers(db, { sort: 'oldest', asOf })
    expect(byAge.map((c) => c.name)).toEqual(['Suresh', 'Ramesh'])
    expect(byAge[0].oldestDays).toBeGreaterThan(150)
    expect((await listCustomers(db, { query: '98765', asOf })).map((c) => c.name)).toEqual(['Ramesh'])
    expect((await listCustomers(db, { query: 'sure', asOf })).map((c) => c.name)).toEqual(['Suresh'])
  })
})

describe('credit limit advice', () => {
  it('warns before and after the limit, never blocks', () => {
    expect(checkCreditLimit(0, null, 5_000_000).state).toBe('no_limit')
    expect(checkCreditLimit(50_000, 100_000, 40_000).state).toBe('ok')
    expect(checkCreditLimit(50_000, 100_000, 60_000)).toMatchObject({ state: 'will_exceed', afterPaise: 110_000 })
    expect(checkCreditLimit(150_000, 100_000, 1).state).toBe('already_over')
  })

  it('updating a customer sends only the changed fields and validates the phone', async () => {
    const { sqlite, db, writer } = await setup()
    await updateCustomer(writer, SURESH, { phone: '098765 43211', creditLimitPaise: 200_000 }, null)
    const op = first<{ payload: string; op_type: string }>(sqlite, "SELECT payload, op_type FROM op_log WHERE entity_type = 'party'")!
    expect(op.op_type).toBe('update')
    expect(JSON.parse(op.payload)).toEqual({ phone: '9876543211', creditLimitPaise: 200_000 })
    const [c] = await listCustomers(db, { query: 'Suresh', filter: 'all' })
    expect(c).toMatchObject({ phone: '9876543211', creditLimitPaise: 200_000 })
    await expect(updateCustomer(writer, SURESH, { phone: '12345' }, null)).rejects.toMatchObject({ code: 'invalid_phone' })
    await expect(updateCustomer(writer, SURESH, { creditLimitPaise: -1 }, null)).rejects.toMatchObject({ code: 'invalid_credit_limit' })
  })
})

describe('reminders and consent', () => {
  it('no consent until the customer agrees; withdrawal wins; the outbox flushes in order and idempotently', async () => {
    const { db } = await setup()
    expect(await hasConsent(db, RAMESH)).toBe(false)
    await recordConsent(db, { partyId: RAMESH, action: 'grant', now: 1000 })
    expect(await hasConsent(db, RAMESH)).toBe(true)
    await recordConsent(db, { partyId: RAMESH, action: 'withdraw', now: 2000 })
    expect(await hasConsent(db, RAMESH)).toBe(false)

    const calls: { body: Record<string, unknown>; auth: string }[] = []
    let fail = true
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      if (fail) throw new Error('offline')
      calls.push({ body: JSON.parse(init.body as string), auth: (init.headers as Record<string, string>).Authorization })
      return { ok: true } as Response
    }) as unknown as typeof fetch
    expect(await flushConsent(db, { apiBase: '/api', deviceToken: 'tzd.x' }, fakeFetch)).toEqual({ sent: 0, pending: 2 })
    fail = false
    expect(await flushConsent(db, { apiBase: '/api', deviceToken: 'tzd.x' }, fakeFetch)).toEqual({ sent: 2, pending: 0 })
    expect(calls.map((c) => c.body.action)).toEqual(['grant', 'withdraw'])
    expect(calls[0].body).toMatchObject({ subjectType: 'party', subjectId: RAMESH, purpose: 'whatsapp_reminders', channel: 'verbal' })
    expect(calls[0].body.idempotencyKey).toBe(`consent:${calls[0].body.operationId}`)
    expect(calls[0].auth).toBe('Bearer tzd.x')
    expect(await flushConsent(db, { apiBase: '/api', deviceToken: 'tzd.x' }, fakeFetch)).toEqual({ sent: 0, pending: 0 })
  })

  it('reminder text carries the amount in Indian grouping and the pay link', () => {
    const en = buildReminderText({ shopName: 'Sharma Store', customerName: 'Ramesh', owedPaise: 12_345_000, upiUri: 'upi://pay?pa=a@b&am=123450.00' })
    expect(en).toContain('₹1,23,450')
    expect(en).toContain('Sharma Store')
    expect(en).toContain('upi://pay?pa=a@b&am=123450.00')
    const hi = buildReminderText({ shopName: 'शर्मा स्टोर', customerName: 'रमेश', owedPaise: 70_000, lang: 'hi' })
    expect(hi).toContain('₹700')
    expect(hi).toContain('बकाया')
    expect(buildThanksText({ shopName: 'S', customerName: 'R', paidPaise: 50_000, balancePaise: 0 })).toContain('clear')
  })
})
