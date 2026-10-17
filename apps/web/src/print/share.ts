import type { ReceiptData } from '../billing/types'
import type { LocalDb } from '../sync/schemaDb'
import { uuidv7 } from '../sync/uuid7'
import { formatIst } from './receipt'
import { formatQty, formatRupees } from './format'
import { label, labelLines, type LabelKey, type ReceiptLang } from './labels'

export const MAX_SHARE_CHARS = 1500

/** UPI deep link for "pay the balance". Minimal on purpose (billing/upi.ts owns the full spec-compliant builder). */
function upiLink(vpa: string, payee: string, paise: number): string {
  const am = `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, '0')}`
  return `upi://pay?pa=${encodeURIComponent(vpa)}&pn=${encodeURIComponent(payee)}&am=${am}&cu=INR`
}

function titleKey(d: ReceiptData): LabelKey {
  return d.docType === 'tax_invoice' ? 'taxInvoice' : d.docType === 'bill_of_supply' ? 'billOfSupply' : d.docType === 'retail_invoice' ? 'retailInvoice' : 'creditNote'
}

/**
 * Plain-text receipt for WhatsApp: no tables, no markdown. Capped at ~1500 characters by summarising the tail of a
 * long item list. The UPI pay link is added only when the merchant has a VPA AND the customer still owes money.
 */
export function buildReceiptText(data: ReceiptData, lang: ReceiptLang = 'en'): string {
  const m = (p: number) => formatRupees(p)
  const head: string[] = [data.business.businessName]
  if (data.business.address) head.push(data.business.address)
  if (data.business.gstin) head.push(`${label('gstin', lang)}: ${data.business.gstin}`)
  head.push(labelLines(titleKey(data), lang).join(' / ') + ' ' + data.label)
  head.push(formatIst(data.issuedAtIso))
  if (data.kind === 'credit_note' && data.againstLabel) head.push(`${label('against', lang)}: ${data.againstLabel}`)

  const itemLine = (i: number) => {
    const l = data.lines[i]
    const name = lang === 'hi' && l.localName ? l.localName : l.name
    return `${i + 1}. ${name} ${formatQty(l.qtyMilli, l.unit)} x ${m(l.unitPricePaise)} = ${m(l.lineTotalPaise)}`
  }
  const tail: string[] = []
  if (data.discountPaise > 0) tail.push(`${label('youSaved', lang)}: ${m(data.discountPaise)}`)
  if (data.taxPaise > 0) tail.push(`${label('tax', lang)}: ${m(data.taxPaise)}`)
  if (data.roundOffPaise !== 0) tail.push(`${label('roundOff', lang)}: ${data.roundOffPaise > 0 ? '+' : ''}${m(data.roundOffPaise)}`)
  tail.push(`${label('total', lang)}: ${m(data.totalPaise)}`)
  for (const t of data.tenders) {
    if (t.mode === 'credit' || t.amountPaise === 0) continue
    tail.push(`${label('paid', lang)} ${label(t.mode, lang)}: ${m(t.amountPaise)}`)
  }
  if (data.creditPaise > 0) tail.push(`${label('customerOwes', lang)}: ${m(data.creditPaise)}`)
  if (data.creditPaise > 0 && data.business.upiVpa && data.kind === 'sale') {
    tail.push(upiLink(data.business.upiVpa, data.business.businessName, data.creditPaise))
  }
  tail.push(labelLines('thankYou', lang).join(' / '))

  const build = (shown: number): string => {
    const items = Array.from({ length: shown }, (_, i) => itemLine(i))
    if (shown < data.lines.length) items.push(`... +${data.lines.length - shown}`)
    return [...head, '', ...items, '', ...tail].join('\n')
  }
  let shown = data.lines.length
  let text = build(shown)
  while (text.length > MAX_SHARE_CHARS && shown > 0) text = build(--shown)
  return text.length > MAX_SHARE_CHARS ? text.slice(0, MAX_SHARE_CHARS - 1) + '…' : text
}

/** Digits-only E.164 for an Indian mobile ("98765 43210", "+91-98765-43210", "098765 43210"), or null if not valid. */
export function normalizeIndianMobile(phone: string): string | null {
  let d = phone.replace(/\D/g, '')
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2)
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1)
  else if (d.length === 13 && d.startsWith('091')) d = d.slice(3)
  return /^[6-9]\d{9}$/.test(d) ? '91' + d : null
}

export function whatsappUrl(phone: string, text: string): string {
  const n = normalizeIndianMobile(phone)
  if (!n) throw new Error('invalid_phone')
  return `https://wa.me/${n}?text=${encodeURIComponent(text)}`
}

export interface ShareQueueRow {
  id: string
  invoice_id: string
  phone: string
  body: string
  created_at: string
  sent_at: string | null
}

/** Queue a receipt share. Idempotent per (invoice, phone) while pending. Never opens WhatsApp: that needs a user gesture. */
export async function enqueueShare(
  db: LocalDb,
  s: { invoiceId: string; phone: string; body: string },
  nowMs: number = Date.now(),
): Promise<string> {
  const phone = normalizeIndianMobile(s.phone)
  if (!phone) throw new Error('invalid_phone')
  const existing = await db.getAll<{ id: string }>(
    'SELECT id FROM share_queue WHERE invoice_id = ? AND phone = ? AND sent_at IS NULL LIMIT 1',
    [s.invoiceId, phone],
  )
  if (existing.length > 0) return existing[0].id
  const id = uuidv7(nowMs)
  await db.execute('INSERT INTO share_queue (id, invoice_id, phone, body, created_at, sent_at) VALUES (?, ?, ?, ?, ?, NULL)', [
    id, s.invoiceId, phone, s.body, new Date(nowMs).toISOString(),
  ])
  return id
}

export function listPending(db: LocalDb): Promise<ShareQueueRow[]> {
  return db.getAll<ShareQueueRow>('SELECT * FROM share_queue WHERE sent_at IS NULL ORDER BY created_at, id')
}

/** Call after the user tapped "Send now" and the wa.me link was opened. */
export async function markSent(db: LocalDb, id: string, nowMs: number = Date.now()): Promise<void> {
  await db.execute('UPDATE share_queue SET sent_at = ? WHERE id = ? AND sent_at IS NULL', [new Date(nowMs).toISOString(), id])
}

export interface ShareNavigator {
  canShare?(d: { files?: File[] }): boolean
  share?(d: { files?: File[]; title?: string; text?: string }): Promise<void>
}

/** Share a file (PDF/PNG receipt) through the OS share sheet. Needs a user gesture. */
export async function shareFile(
  file: File,
  info: { title?: string; text?: string } = {},
  nav: ShareNavigator = globalThis.navigator as unknown as ShareNavigator,
): Promise<'shared' | 'cancelled' | 'unsupported'> {
  if (!nav || typeof nav.share !== 'function' || (nav.canShare && !nav.canShare({ files: [file] }))) return 'unsupported'
  try {
    await nav.share({ files: [file], ...info })
    return 'shared'
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') return 'cancelled'
    throw e
  }
}
