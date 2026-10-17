import { bigSale, plainSale, splitCreditSale } from './fixtures'
import { buildReceiptText, enqueueShare, listPending, markSent, normalizeIndianMobile, shareFile, whatsappUrl } from './share'
import { makeSchemaDb } from '../sync/schemaDb'

describe('buildReceiptText', () => {
  it('is plain text with Indian amounts, no markdown tables', () => {
    const t = buildReceiptText(plainSale, 'en')
    expect(t).toContain('Sharma General Store')
    expect(t).toContain('Tax Invoice A1B2C3D4/2026-27/17')
    expect(t).toContain('1. Atta 5kg 5kg x 45.00 = 225.00')
    expect(t).toContain('TOTAL: 305.00')
    expect(t).not.toMatch(/\|/)
    expect(t.length).toBeLessThanOrEqual(1500)
  })
  it('adds the UPI pay link only when the customer owes and a VPA is set', () => {
    expect(buildReceiptText(plainSale)).not.toContain('upi://')
    const t = buildReceiptText(splitCreditSale)
    expect(t).toContain('Customer owes: 78.00')
    expect(t).toContain('upi://pay?pa=sharma%40upi&pn=Sharma%20General%20Store&am=78.00&cu=INR')
    const noVpa = buildReceiptText({ ...splitCreditSale, business: { ...splitCreditSale.business, upiVpa: null } })
    expect(noVpa).not.toContain('upi://')
  })
  it('stays under the cap with a long bill and says how many items were cut', () => {
    const t = buildReceiptText({ ...bigSale, lines: bigSale.lines.concat(bigSale.lines, bigSale.lines) })
    expect(t.length).toBeLessThanOrEqual(1500)
    expect(t).toMatch(/\.\.\. \+\d+/)
    expect(t).toContain('TOTAL: 305.00')
  })
  it('supports Hindi labels', () => expect(buildReceiptText(splitCreditSale, 'hi')).toContain('ग्राहक पर बकाया: 78.00'))
})

describe('whatsappUrl', () => {
  it.each([
    ['98765 43210', '919876543210'],
    ['+91-98765-43210', '919876543210'],
    ['09876543210', '919876543210'],
    ['919876543210', '919876543210'],
  ])('%s', (input, e164) => {
    expect(normalizeIndianMobile(input)).toBe(e164)
    expect(whatsappUrl(input, 'hi there & bye')).toBe(`https://wa.me/${e164}?text=hi%20there%20%26%20bye`)
  })
  it.each(['12345', '5876543210', '98765432101234', '', 'abc'])('rejects %s', (bad) => {
    expect(normalizeIndianMobile(bad)).toBeNull()
    expect(() => whatsappUrl(bad, 'x')).toThrow('invalid_phone')
  })
})

describe('share queue', () => {
  it('queues offline, lists pending in order, marks sent', async () => {
    const { db } = await makeSchemaDb()
    const a = await enqueueShare(db, { invoiceId: 'inv-1', phone: '98765 43210', body: 'one' }, 1_000)
    const b = await enqueueShare(db, { invoiceId: 'inv-2', phone: '9123456789', body: 'two' }, 2_000)
    expect((await listPending(db)).map((r) => [r.id, r.phone, r.body])).toEqual([[a, '919876543210', 'one'], [b, '919123456789', 'two']])
    await markSent(db, a, 5_000)
    const pending = await listPending(db)
    expect(pending.map((r) => r.id)).toEqual([b])
    const sent = await db.getAll<{ sent_at: string }>('SELECT sent_at FROM share_queue WHERE id = ?', [a])
    expect(sent[0].sent_at).toBe(new Date(5_000).toISOString())
    await markSent(db, a, 9_000) // idempotent: first sent_at wins
    expect((await db.getAll<{ sent_at: string }>('SELECT sent_at FROM share_queue WHERE id = ?', [a]))[0].sent_at).toBe(new Date(5_000).toISOString())
  })
  it('does not double-queue the same invoice and number while pending', async () => {
    const { db } = await makeSchemaDb()
    const a = await enqueueShare(db, { invoiceId: 'inv-1', phone: '9876543210', body: 'x' })
    const b = await enqueueShare(db, { invoiceId: 'inv-1', phone: '+91 9876543210', body: 'x' })
    expect(b).toBe(a)
    expect(await listPending(db)).toHaveLength(1)
  })
  it('rejects invalid numbers', async () => {
    const { db } = await makeSchemaDb()
    await expect(enqueueShare(db, { invoiceId: 'i', phone: '123', body: 'x' })).rejects.toThrow('invalid_phone')
  })
})

describe('shareFile', () => {
  const file = new File(['x'], 'r.pdf', { type: 'application/pdf' })
  it('feature-detects the Web Share API', async () => {
    expect(await shareFile(file, {}, {})).toBe('unsupported')
    expect(await shareFile(file, {}, { share: async () => {}, canShare: () => false })).toBe('unsupported')
    let got: unknown
    expect(await shareFile(file, { title: 't' }, { share: async (d) => void (got = d), canShare: () => true })).toBe('shared')
    expect(got).toMatchObject({ title: 't' })
  })
  it('treats a dismissed sheet as cancelled', async () => {
    const abort = Object.assign(new Error('x'), { name: 'AbortError' })
    expect(await shareFile(file, {}, { share: async () => { throw abort } })).toBe('cancelled')
  })
})
