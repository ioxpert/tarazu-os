import type { ReceiptData, ReceiptLine } from '../billing/types'
import { clip, formatQty, formatRate, formatRupees, padCenter, padLeft, padRight, textWidth, wrapText } from './format'
import { label, labelIn, labelLines, type LabelKey, type ReceiptLang } from './labels'

export type Align = 'left' | 'right' | 'center'
export interface Cell {
  text: string
  /** Columns at the row's scale. */
  width: number
  align: Align
}
export type Role =
  | 'heading' | 'address' | 'title' | 'note' | 'kv' | 'colhead' | 'item' | 'detail' | 'taxhead' | 'tax' | 'totals'
  | 'total' | 'tender' | 'owes' | 'qrcaption' | 'footer'

export type Block =
  | { kind: 'row'; role: Role; cells: Cell[]; bold: boolean; scale: 1 | 2 }
  | { kind: 'rule'; char: '-' | '=' }
  | { kind: 'qr'; matrix: boolean[][]; /** raw payload, when known, lets ESC/POS use the printer's native QR */ data: string | null }
  | { kind: 'feed'; lines: number }

export interface ReceiptLayout {
  widthMm: 58 | 80
  /** Characters per line at font A, scale 1. */
  cols: number
  /** Printable dots across. */
  dots: number
  lang: ReceiptLang
  blocks: Block[]
}

export interface ReceiptOptions {
  widthMm: 58 | 80
  lang: ReceiptLang
  /** UPI QR modules, supplied by the UI from billing/qr.ts. Omit for no QR. */
  qrMatrix?: boolean[][]
  /** The string behind qrMatrix; when given, ESC/POS prints the printer-native QR instead of a bitmap. */
  qrData?: string
  /** The QR is the merchant's static QR (no amount): caption shows the VPA instead of the amount. */
  staticQr?: boolean
  /** Amount encoded in a dynamic QR (caption only). */
  qrAmountPaise?: number
}

export const WIDTHS = { 58: { cols: 32, dots: 384 }, 80: { cols: 48, dots: 576 } } as const

const IST_OFFSET_MIN = 330
/** "17-10-2026 14:35" in IST regardless of the machine timezone. */
export function formatIst(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  const d = new Date(t + IST_OFFSET_MIN * 60000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCDate())}-${p(d.getUTCMonth() + 1)}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

/** One printed line of a row: cells padded to their widths, trailing spaces trimmed. */
export function rowText(b: Extract<Block, { kind: 'row' }>): string {
  return b.cells
    .map((c) => {
      const t = textWidth(c.text) > c.width ? clip(c.text, c.width) : c.text
      return c.align === 'right' ? padLeft(t, c.width) : c.align === 'center' ? padCenter(t, c.width) : padRight(t, c.width)
    })
    .join('')
    .replace(/ +$/, '')
}

/** Plain-text rendering of the whole layout (what the 'text' path would print), one string per physical line. */
export function layoutLines(layout: ReceiptLayout): string[] {
  const out: string[] = []
  for (const b of layout.blocks) {
    if (b.kind === 'row') out.push(rowText(b))
    else if (b.kind === 'rule') out.push(b.char.repeat(layout.cols))
    else if (b.kind === 'qr') out.push(`[QR ${b.matrix.length}x${b.matrix.length}]`)
    else for (let i = 0; i < b.lines; i++) out.push('')
  }
  return out
}

const money = (p: number) => formatRupees(p)

function row(role: Role, cells: Cell[], bold = false, scale: 1 | 2 = 1): Block {
  return { kind: 'row', role, cells, bold, scale }
}
function textRows(role: Role, text: string, width: number, align: Align, bold = false, scale: 1 | 2 = 1): Block[] {
  return wrapText(text, width).map((t) => row(role, [{ text: t, width, align }], bold, scale))
}
/** label left, value right on one line when they fit; otherwise the wrapped label then the value alone on the right. */
function kv(role: Role, left: string, value: string, width: number, bold = false, scale: 1 | 2 = 1): Block[] {
  const vw = textWidth(value)
  if (textWidth(left) + 1 + vw <= width) {
    return [row(role, [{ text: left, width: width - vw, align: 'left' }, { text: value, width: vw, align: 'right' }], bold, scale)]
  }
  return [...textRows(role, left, width, 'left', bold, scale), row(role, [{ text: value, width, align: 'right' }], bold, scale)]
}

function displayNames(l: ReceiptLine, lang: ReceiptLang): string[] {
  const local = l.localName && l.localName.trim() ? l.localName : null
  if (lang === 'hi') return [local ?? l.name]
  if (lang === 'en+hi' && local && local !== l.name) return [l.name, local]
  return [l.name]
}

function colHead(key: LabelKey, lang: ReceiptLang): string {
  return labelIn(key, lang === 'hi' ? 'hi' : 'en')
}

function itemBlocks(l: ReceiptLine, lang: ReceiptLang, cols: number, widthMm: 58 | 80): Block[] {
  const out: Block[] = []
  const names = displayNames(l, lang)
  const qty = formatQty(l.qtyMilli, l.unit)
  const rate = money(l.unitPricePaise)
  const amt = money(l.lineTotalPaise)
  if (widthMm === 80) {
    const nameW = cols - 8 - 9 - 12
    const nameLines = names.flatMap((n) => wrapText(n, nameW))
    nameLines.forEach((n, i) => {
      out.push(
        row('item', [
          { text: n, width: nameW, align: 'left' },
          { text: i === 0 ? qty : '', width: 8, align: 'right' },
          { text: i === 0 ? rate : '', width: 9, align: 'right' },
          { text: i === 0 ? amt : '', width: 12, align: 'right' },
        ]),
      )
    })
  } else {
    for (const n of names) out.push(...textRows('item', n, cols, 'left'))
    const detail = `${qty} x ${rate}`
    out.push(...kv('detail', '  ' + detail, amt, cols))
  }
  if (l.discountPaise > 0) out.push(...kv('detail', '  ' + labelIn('discount', lang === 'hi' ? 'hi' : 'en'), '-' + money(l.discountPaise), cols))
  return out
}

function docTitleKey(data: ReceiptData): LabelKey {
  switch (data.docType) {
    case 'tax_invoice': return 'taxInvoice'
    case 'bill_of_supply': return 'billOfSupply'
    case 'retail_invoice': return 'retailInvoice'
    case 'credit_note': return 'creditNote'
  }
}

function tenderKey(mode: string): LabelKey {
  return mode === 'upi' ? 'upi' : mode === 'card' ? 'card' : mode === 'credit' ? 'credit' : 'cash'
}

export function buildReceiptLayout(data: ReceiptData, opts: ReceiptOptions): ReceiptLayout {
  const { cols, dots } = WIDTHS[opts.widthMm]
  const lang = opts.lang
  const half = Math.floor(cols / 2)
  const isNote = data.kind === 'credit_note'
  // a credit note against a tax invoice reverses tax, so it shows the same tax lines
  const isTaxInvoice = data.docType === 'tax_invoice' || (isNote && data.taxPaise > 0)
  const blocks: Block[] = []
  const rule = (char: '-' | '=' = '-') => {
    const prev = blocks[blocks.length - 1]
    // never print two rules in a row: merge, keeping the heavier one
    if (prev && prev.kind === 'rule') {
      if (char === '=') prev.char = '='
      return
    }
    blocks.push({ kind: 'rule', char })
  }
  const L = (k: LabelKey) => label(k, lang)

  // heading
  const name = data.business.businessName.trim() || ' '
  const big = textWidth(name) <= half
  blocks.push(...textRows('heading', name, big ? half : cols, 'center', true, big ? 2 : 1))
  if (data.business.address) blocks.push(...textRows('address', data.business.address, cols, 'center'))
  if (data.business.phone) blocks.push(...textRows('address', `${L('phone')}: ${data.business.phone}`, cols, 'center'))
  if (data.business.gstin) blocks.push(...textRows('address', `${L('gstin')}: ${data.business.gstin}`, cols, 'center'))
  rule()
  for (const t of labelLines(docTitleKey(data), lang)) blocks.push(...textRows('title', t, cols, 'center', true))
  if (data.docType === 'bill_of_supply') {
    for (const t of labelLines('compositionNote', lang)) blocks.push(...textRows('note', t, cols, 'center'))
  }
  rule()
  blocks.push(...kv('kv', L('billNo'), data.label, cols))
  blocks.push(...kv('kv', L('date'), formatIst(data.issuedAtIso), cols))
  if (isNote && data.againstLabel) blocks.push(...kv('kv', L('against'), data.againstLabel, cols))
  if (data.customerName) blocks.push(...kv('kv', L('customer'), data.customerName, cols))
  if (data.cashierName) blocks.push(...kv('kv', L('cashier'), data.cashierName, cols))
  rule()

  // items
  if (opts.widthMm === 80) {
    blocks.push(
      row('colhead', [
        { text: colHead('item', lang), width: cols - 29, align: 'left' },
        { text: colHead('qty', lang), width: 8, align: 'right' },
        { text: colHead('rate', lang), width: 9, align: 'right' },
        { text: colHead('amount', lang), width: 12, align: 'right' },
      ], true),
    )
    rule()
  }
  for (const l of data.lines) blocks.push(...itemBlocks(l, lang, cols, opts.widthMm))
  rule()

  // totals
  const cgst = data.taxBreakup.reduce((s, r) => s + r.cgstPaise, 0)
  const sgst = data.taxBreakup.reduce((s, r) => s + r.sgstPaise, 0)
  if (isTaxInvoice) {
    blocks.push(...kv('totals', L('subtotal'), money(data.subtotalPaise), cols))
    if (data.taxPaise > 0) {
      blocks.push(...kv('totals', L('cgst'), money(cgst), cols))
      blocks.push(...kv('totals', L('sgst'), money(sgst), cols))
    }
  }
  if (data.roundOffPaise !== 0) {
    blocks.push(...kv('totals', L('roundOff'), (data.roundOffPaise > 0 ? '+' : '') + money(data.roundOffPaise), cols))
  }
  rule('=')
  blocks.push(...kv('total', labelIn('total', lang === 'hi' ? 'hi' : 'en'), money(data.totalPaise), half, true, 2))
  rule('=')
  if (data.discountPaise > 0) blocks.push(...kv('totals', L('youSaved'), money(data.discountPaise), cols))

  // tax breakup
  if (isTaxInvoice && data.taxBreakup.length > 0 && data.taxPaise > 0) {
    if (opts.widthMm === 80) {
      blocks.push(
        row('taxhead', [
          { text: colHead('gst', lang) + '%', width: 7, align: 'left' },
          { text: colHead('taxable', lang), width: 14, align: 'right' },
          { text: colHead('cgst', lang), width: 13, align: 'right' },
          { text: colHead('sgst', lang), width: 14, align: 'right' },
        ], true),
      )
      for (const r of data.taxBreakup) {
        blocks.push(
          row('tax', [
            { text: `${formatRate(r.rateBp)}%`, width: 7, align: 'left' },
            { text: money(r.taxablePaise), width: 14, align: 'right' },
            { text: money(r.cgstPaise), width: 13, align: 'right' },
            { text: money(r.sgstPaise), width: 14, align: 'right' },
          ]),
        )
      }
    } else {
      const text = `${colHead('gst', lang)}: ` + data.taxBreakup.map((r) => `${formatRate(r.rateBp)}% ${money(r.taxPaise)}`).join(', ')
      blocks.push(...textRows('tax', text, cols, 'left'))
    }
    rule()
  }

  // tenders
  const tenders = data.tenders.filter((t) => t.mode !== 'credit' && t.amountPaise !== 0)
  for (const t of tenders) {
    const base = isNote ? `${L('refund')} ${label(tenderKey(t.mode), lang)}` : `${L('paid')} ${label(tenderKey(t.mode), lang)}`
    const left = t.reference ? `${base} ${L('ref')}:${t.reference}` : base
    blocks.push(...kv('tender', left, money(t.amountPaise), cols))
  }
  if (data.changeDuePaise > 0) blocks.push(...kv('tender', L('change'), money(data.changeDuePaise), cols))
  if (data.creditPaise > 0) {
    rule('=')
    blocks.push(...kv('owes', isNote ? L('khataAdjusted') : L('customerOwes'), money(data.creditPaise), cols, true))
    rule('=')
  }

  // QR
  if (opts.qrMatrix && opts.qrMatrix.length > 0 && !isNote) {
    blocks.push({ kind: 'qr', matrix: opts.qrMatrix, data: opts.qrData ?? null })
    for (const t of labelLines('scanToPay', lang)) blocks.push(...textRows('qrcaption', t, cols, 'center', true))
    if (opts.staticQr && data.business.upiVpa) blocks.push(...textRows('qrcaption', data.business.upiVpa, cols, 'center'))
    else if (opts.qrAmountPaise !== undefined) blocks.push(...textRows('qrcaption', money(opts.qrAmountPaise), cols, 'center'))
  }

  // footer
  for (const t of labelLines('thankYou', lang)) blocks.push(...textRows('footer', t, cols, 'center', true))
  blocks.push({ kind: 'feed', lines: 3 })
  return { widthMm: opts.widthMm, cols, dots, lang, blocks }
}
