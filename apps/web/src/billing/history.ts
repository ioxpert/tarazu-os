import type { Unit } from '../catalogue/types'
import { taxBreakup } from './calc'
import { BillingError } from './errors'
import { documentLabel } from './numbering'
import type { StateReader } from './settings'
import type { DocType, MerchantProfile, PricedLine, ReceiptData, Tender, TenderMode } from './types'

/** Invoice history and reprint. Reads only the local read-model, so it works offline and sees other counters after sync. */

export const HISTORY_PAGE = 50

export interface HistoryFilters {
  /** IST dates, inclusive, 'YYYY-MM-DD'. */
  fromDate?: string
  toDate?: string
  partyId?: string
  /** Credit = part of the bill left owing on khata. Credit notes are hidden when a tender mode is chosen. */
  mode?: TenderMode
  /** 'credit_note' lists only credit notes. */
  docType?: DocType | 'credit_note'
  /** Matches the document number, series, or the customer's name or phone. */
  query?: string
}

/** Keyset position: the last row of the previous page. */
export interface HistoryCursor {
  createdAt: string
  id: string
}

export interface HistoryEntry {
  kind: 'sale' | 'credit_note'
  id: string
  /** The invoice this row opens (a credit note opens the invoice it corrects). */
  invoiceId: string
  label: string
  createdAt: string
  docType: DocType | 'credit_note'
  partyId: string | null
  partyName: string | null
  totalPaise: number
  /** Distinct modes money came in with, plus 'credit' when part is owed. Empty for a credit note. */
  modes: TenderMode[]
  /** True when a credit note exists for this invoice. */
  returned: boolean
}

export interface HistoryPage {
  entries: HistoryEntry[]
  /** Pass back to get the next page; null at the end. */
  next: HistoryCursor | null
}

interface Row {
  kind: 'sale' | 'credit_note'
  id: string
  invoice_id: string
  series: string
  number: number
  created_at: string
  doc_type: DocType | 'credit_note'
  party_id: string | null
  party_name: string | null
  total_paise: number
  paid_paise: number
  modes: string | null
  returned: number
}

export const PAID_SQL = `COALESCE((SELECT SUM(CASE WHEN p.direction = 'in' THEN p.amount_paise ELSE -p.amount_paise END) FROM payment p WHERE p.invoice_id = i.id), 0)`

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/** Newest first across sales and credit notes. Keyset paged on (created_at, id), so a page costs the same at any depth. */
export async function listHistory(db: StateReader, filters: HistoryFilters = {}, cursor: HistoryCursor | null = null, limit = HISTORY_PAGE): Promise<HistoryPage> {
  const sale: string[] = []
  const sp: unknown[] = []
  const note: string[] = []
  const np: unknown[] = []
  const istDay = (col: string) => `date(${col}, '+330 minutes')`

  if (filters.fromDate) {
    sale.push(`${istDay('i.created_at')} >= ?`)
    sp.push(filters.fromDate)
    note.push(`${istDay('c.created_at')} >= ?`)
    np.push(filters.fromDate)
  }
  if (filters.toDate) {
    sale.push(`${istDay('i.created_at')} <= ?`)
    sp.push(filters.toDate)
    note.push(`${istDay('c.created_at')} <= ?`)
    np.push(filters.toDate)
  }
  if (filters.partyId) {
    sale.push('i.party_id = ?')
    sp.push(filters.partyId)
    note.push('c.party_id = ?')
    np.push(filters.partyId)
  }
  if (filters.query && filters.query.trim()) {
    const like = `%${escapeLike(filters.query.trim())}%`
    sale.push(`(CAST(i.number AS TEXT) LIKE ? ESCAPE '\\' OR i.series LIKE ? ESCAPE '\\' OR pa.name LIKE ? ESCAPE '\\' OR pa.phone LIKE ? ESCAPE '\\')`)
    sp.push(like, like, like, like)
    note.push(`(CAST(c.number AS TEXT) LIKE ? ESCAPE '\\' OR c.series LIKE ? ESCAPE '\\' OR pa.name LIKE ? ESCAPE '\\' OR pa.phone LIKE ? ESCAPE '\\')`)
    np.push(like, like, like, like)
  }
  if (filters.docType && filters.docType !== 'credit_note') {
    sale.push('i.doc_type = ?')
    sp.push(filters.docType)
  }
  if (filters.mode === 'credit') {
    sale.push(`i.party_id IS NOT NULL AND i.total_paise > ${PAID_SQL}`)
  } else if (filters.mode) {
    sale.push(`EXISTS (SELECT 1 FROM payment p WHERE p.invoice_id = i.id AND p.direction = 'in' AND p.mode = ?)`)
    sp.push(filters.mode)
  }

  const where = (parts: string[]) => (parts.length ? `WHERE ${parts.join(' AND ')}` : '')
  const parts: string[] = []
  const params: unknown[] = []
  const salesOnly = filters.docType === 'credit_note'
  const notesOnly = Boolean(filters.mode) || (filters.docType !== undefined && filters.docType !== 'credit_note')
  if (!salesOnly) {
    parts.push(
      `SELECT 'sale' AS kind, i.id AS id, i.id AS invoice_id, i.series AS series, i.number AS number, i.created_at AS created_at,
              i.doc_type AS doc_type, i.party_id AS party_id, pa.name AS party_name, i.total_paise AS total_paise,
              ${PAID_SQL} AS paid_paise,
              (SELECT group_concat(DISTINCT p.mode) FROM payment p WHERE p.invoice_id = i.id AND p.direction = 'in') AS modes,
              EXISTS (SELECT 1 FROM credit_note c WHERE c.invoice_id = i.id) AS returned
       FROM invoice i LEFT JOIN party pa ON pa.id = i.party_id ${where(sale)}`,
    )
    params.push(...sp)
  }
  if (!notesOnly) {
    parts.push(
      `SELECT 'credit_note' AS kind, c.id AS id, c.invoice_id AS invoice_id, c.series AS series, c.number AS number, c.created_at AS created_at,
              'credit_note' AS doc_type, c.party_id AS party_id, pa.name AS party_name, c.total_paise AS total_paise,
              0 AS paid_paise, NULL AS modes, 0 AS returned
       FROM credit_note c LEFT JOIN party pa ON pa.id = c.party_id ${where(note)}`,
    )
    params.push(...np)
  }
  if (parts.length === 0) return { entries: [], next: null }

  const after = cursor ? 'WHERE created_at < ? OR (created_at = ? AND id < ?)' : ''
  if (cursor) params.push(cursor.createdAt, cursor.createdAt, cursor.id)
  const rows = await db.getAll<Row>(
    `SELECT * FROM (${parts.join(' UNION ALL ')}) ${after} ORDER BY created_at DESC, id DESC LIMIT ?`,
    [...params, limit + 1],
  )
  const page = rows.slice(0, limit)
  const entries = page.map((r): HistoryEntry => {
    const modes = new Set<TenderMode>((r.modes ? r.modes.split(',') : []).filter((m): m is TenderMode => m === 'cash' || m === 'upi' || m === 'card'))
    if (r.kind === 'sale' && r.party_id !== null && Number(r.total_paise) > Number(r.paid_paise)) modes.add('credit')
    return {
      kind: r.kind,
      id: r.id,
      invoiceId: r.invoice_id,
      label: documentLabel(r.series, Number(r.number)),
      createdAt: r.created_at,
      docType: r.doc_type,
      partyId: r.party_id,
      partyName: r.party_name,
      totalPaise: Number(r.total_paise),
      modes: [...modes],
      returned: Number(r.returned) === 1,
    }
  })
  const last = page[page.length - 1]
  return { entries, next: rows.length > limit && last ? { createdAt: last.created_at, id: last.id } : null }
}

export interface InvoiceDetail {
  id: string
  label: string
  docType: DocType
  createdAt: string
  partyId: string | null
  partyName: string | null
  subtotalPaise: number
  taxPaise: number
  roundOffPaise: number
  totalPaise: number
  lines: {
    lineNo: number
    productId: string
    name: string
    localName: string | null
    unit: Unit
    qtyMilli: number
    unitPricePaise: number
    discountPaise: number
    hsn: string | null
    taxRateBp: number
    taxPaise: number
    lineTotalPaise: number
  }[]
  /** Money in, one row per payment. Refunds (direction out) are listed separately. */
  payments: Tender[]
  refundedPaise: number
  creditNotes: { id: string; label: string; createdAt: string; totalPaise: number; reason: string }[]
}

export async function loadInvoiceDetail(db: StateReader, invoiceId: string): Promise<InvoiceDetail> {
  const inv = (
    await db.getAll<{
      id: string; series: string; number: number; doc_type: DocType; created_at: string; party_id: string | null; party_name: string | null
      subtotal_paise: number; tax_paise: number; round_off_paise: number; total_paise: number
    }>(
      `SELECT i.id, i.series, i.number, i.doc_type, i.created_at, i.party_id, pa.name AS party_name, i.subtotal_paise, i.tax_paise,
              i.round_off_paise, i.total_paise
       FROM invoice i LEFT JOIN party pa ON pa.id = i.party_id WHERE i.id = ?`,
      [invoiceId],
    )
  )[0]
  if (!inv) throw new BillingError('invoice_not_found')
  const lines = await db.getAll<{
    line_no: number; product_id: string; name: string | null; local_name: string | null; unit: Unit | null; qty_milli: number
    unit_price_paise: number; discount_paise: number; hsn: string | null; tax_rate_bp: number; tax_paise: number; line_total_paise: number
  }>(
    `SELECT l.line_no, l.product_id, p.name AS name, p.local_name AS local_name, p.unit AS unit, l.qty_milli, l.unit_price_paise,
            l.discount_paise, l.hsn, l.tax_rate_bp, l.tax_paise, l.line_total_paise
     FROM invoice_line l LEFT JOIN product p ON p.id = l.product_id WHERE l.invoice_id = ? ORDER BY l.line_no`,
    [invoiceId],
  )
  const pays = await db.getAll<{ direction: 'in' | 'out'; mode: string; amount_paise: number; reference: string | null }>(
    'SELECT direction, mode, amount_paise, reference FROM payment WHERE invoice_id = ? ORDER BY occurred_at, id',
    [invoiceId],
  )
  const notes = await db.getAll<{ id: string; series: string; number: number; created_at: string; total_paise: number; reason: string }>(
    'SELECT id, series, number, created_at, total_paise, reason FROM credit_note WHERE invoice_id = ? ORDER BY created_at, id',
    [invoiceId],
  )
  const tenderModes: string[] = ['cash', 'upi', 'card']
  return {
    id: inv.id,
    label: documentLabel(inv.series, Number(inv.number)),
    docType: inv.doc_type,
    createdAt: inv.created_at,
    partyId: inv.party_id,
    partyName: inv.party_name,
    subtotalPaise: Number(inv.subtotal_paise),
    taxPaise: Number(inv.tax_paise),
    roundOffPaise: Number(inv.round_off_paise),
    totalPaise: Number(inv.total_paise),
    lines: lines.map((l) => ({
      lineNo: Number(l.line_no),
      productId: l.product_id,
      name: l.name ?? '',
      localName: l.local_name,
      unit: l.unit ?? 'piece',
      qtyMilli: Number(l.qty_milli),
      unitPricePaise: Number(l.unit_price_paise),
      discountPaise: Number(l.discount_paise),
      hsn: l.hsn,
      taxRateBp: Number(l.tax_rate_bp),
      taxPaise: Number(l.tax_paise),
      lineTotalPaise: Number(l.line_total_paise),
    })),
    payments: pays
      .filter((p) => p.direction === 'in' && tenderModes.includes(p.mode))
      .map((p) => ({ mode: p.mode as TenderMode, amountPaise: Number(p.amount_paise), reference: p.reference })),
    refundedPaise: pays.filter((p) => p.direction === 'out').reduce((a, p) => a + Number(p.amount_paise), 0),
    creditNotes: notes.map((n) => ({
      id: n.id,
      label: documentLabel(n.series, Number(n.number)),
      createdAt: n.created_at,
      totalPaise: Number(n.total_paise),
      reason: n.reason,
    })),
  }
}

/**
 * Rebuild the receipt of a past invoice from what is stored. It is a duplicate copy: the header says so, and it is never
 * written to device_state (the last-receipt slot belongs to the sale that just happened). Cashier name, cash change and
 * the dynamic UPI QR are not stored with the invoice, so they are not reprinted.
 */
export function receiptFromInvoice(d: InvoiceDetail, profile: MerchantProfile): ReceiptData {
  const priced: PricedLine[] = d.lines.map((l) => ({
    lineNo: l.lineNo,
    productId: l.productId,
    hsn: l.hsn,
    qtyMilli: l.qtyMilli,
    unitPricePaise: l.unitPricePaise,
    grossPaise: l.lineTotalPaise + l.discountPaise,
    discountPaise: l.discountPaise,
    taxRateBp: l.taxRateBp,
    taxPaise: l.taxPaise,
    taxablePaise: l.lineTotalPaise - l.taxPaise,
    lineTotalPaise: l.lineTotalPaise,
  }))
  const paidIn = d.payments.reduce((a, p) => a + p.amountPaise, 0)
  return {
    kind: 'sale',
    duplicate: true,
    business: {
      businessName: profile.businessName,
      gstin: profile.gstin,
      address: profile.address,
      phone: profile.phone,
      upiVpa: profile.upiVpa,
      gstMode: profile.gstMode,
    },
    docType: d.docType,
    label: d.label,
    issuedAtIso: d.createdAt,
    customerName: d.partyName,
    cashierName: null,
    lines: d.lines.map((l) => ({
      name: l.name,
      localName: l.localName,
      qtyMilli: l.qtyMilli,
      unit: l.unit,
      unitPricePaise: l.unitPricePaise,
      discountPaise: l.discountPaise,
      taxRateBp: l.taxRateBp,
      lineTotalPaise: l.lineTotalPaise,
    })),
    subtotalPaise: d.subtotalPaise,
    taxPaise: d.taxPaise,
    discountPaise: d.lines.reduce((a, l) => a + l.discountPaise, 0),
    roundOffPaise: d.roundOffPaise,
    totalPaise: d.totalPaise,
    taxBreakup: taxBreakup(priced),
    tenders: d.payments.map((p) => ({ ...p })),
    changeDuePaise: 0,
    creditPaise: d.partyId !== null ? Math.max(0, d.totalPaise - paidIn) : 0,
  }
}
