import type { components } from '../api/schema'
import type { Unit } from '../catalogue/types'
import { adjustKhataBalance, adjustStockBalance } from '../sync/effects'
import { item, type OpLogWriter, type WriteItem } from '../sync/oplog'
import { uuidv7 } from '../sync/uuid7'
import { taxBreakup } from './calc'
import { assertSafeCardReference } from './card'
import { BillingError } from './errors'
import { mulDiv } from './money'
import { allocateNumber, creditNoteSeries, documentLabel, financialYear, istDate } from './numbering'
import { getJson, setJson, type StateReader } from './settings'
import { recordCashMovement } from './shift'
import type { Approval, DeviceScope } from './commit'
import type { DocType, MerchantProfile, PricedLine, ReceiptData, Tender } from './types'

type CreditNoteLine = components['schemas']['CreditNoteLine']

export interface ReturnInvoiceLine {
  lineNo: number
  productId: string
  name: string
  /** Base unit of the product (quantities are milli of it). */
  unit: Unit
  qtyMilli: number
  unitPricePaise: number
  discountPaise: number
  hsn: string | null
  taxRateBp: number
  taxPaise: number
  lineTotalPaise: number
  /** Cumulative over earlier credit notes (local credit_note.lines). */
  returnedQtyMilli: number
  returnedTaxPaise: number
  returnedTotalPaise: number
}

export interface ReturnInvoice {
  id: string
  series: string
  number: number
  label: string
  docType: DocType
  invoiceDate: string
  partyId: string | null
  totalPaise: number
  lines: ReturnInvoiceLine[]
  /** Payments recorded against the invoice. */
  payments: { direction: 'in' | 'out'; mode: string; amountPaise: number }[]
  /** Net money received against the invoice (in - out). */
  paidPaise: number
  /** Total of earlier credit notes. */
  returnedTotalPaise: number
}

export interface ReturnSelection {
  lineNo: number
  qtyMilli: number
}

export interface ReturnComputation {
  lines: CreditNoteLine[]
  totalPaise: number
  taxPaise: number
}

interface InvRow {
  id: string
  series: string
  number: number
  doc_type: DocType
  invoice_date: string
  party_id: string | null
  total_paise: number
}
interface LineRow {
  line_no: number
  product_id: string
  name: string | null
  unit: Unit | null
  qty_milli: number
  unit_price_paise: number
  discount_paise: number
  hsn: string | null
  tax_rate_bp: number
  tax_paise: number
  line_total_paise: number
}

/** Read an invoice with its lines, payments and what earlier credit notes already returned. Works on a LocalDb or a tx. */
export async function loadInvoiceForReturn(db: StateReader, invoiceId: string): Promise<ReturnInvoice> {
  const inv = (await db.getAll<InvRow>(
    'SELECT id, series, number, doc_type, invoice_date, party_id, total_paise FROM invoice WHERE id = ?',
    [invoiceId],
  ))[0]
  if (!inv) throw new BillingError('invoice_not_found')
  const lines = await db.getAll<LineRow>(
    `SELECT l.line_no, l.product_id, p.name AS name, p.unit AS unit, l.qty_milli, l.unit_price_paise, l.discount_paise, l.hsn, l.tax_rate_bp,
            l.tax_paise, l.line_total_paise
     FROM invoice_line l LEFT JOIN product p ON p.id = l.product_id
     WHERE l.invoice_id = ? ORDER BY l.line_no`,
    [invoiceId],
  )
  const payments = await db.getAll<{ direction: 'in' | 'out'; mode: string; amount_paise: number }>(
    'SELECT direction, mode, amount_paise FROM payment WHERE invoice_id = ?',
    [invoiceId],
  )
  const notes = await db.getAll<{ lines: string | null; total_paise: number }>(
    'SELECT lines, total_paise FROM credit_note WHERE invoice_id = ?',
    [invoiceId],
  )
  const returned = new Map<number, { qty: number; tax: number; total: number }>()
  let returnedTotal = 0
  for (const n of notes) {
    returnedTotal += Number(n.total_paise)
    let parsed: CreditNoteLine[] = []
    try {
      parsed = n.lines ? (JSON.parse(n.lines) as CreditNoteLine[]) : []
    } catch {
      parsed = []
    }
    for (const l of parsed) {
      const r = returned.get(l.invoiceLineNo) ?? { qty: 0, tax: 0, total: 0 }
      r.qty += Number(l.qtyMilli)
      r.tax += Number(l.taxPaise)
      r.total += Number(l.lineTotalPaise)
      returned.set(l.invoiceLineNo, r)
    }
  }
  const paidPaise = payments.reduce((a, p) => a + (p.direction === 'in' ? 1 : -1) * Number(p.amount_paise), 0)
  return {
    id: inv.id,
    series: inv.series,
    number: Number(inv.number),
    label: documentLabel(inv.series, Number(inv.number)),
    docType: inv.doc_type,
    invoiceDate: inv.invoice_date,
    partyId: inv.party_id,
    totalPaise: Number(inv.total_paise),
    lines: lines.map((l) => {
      const r = returned.get(Number(l.line_no)) ?? { qty: 0, tax: 0, total: 0 }
      return {
        lineNo: Number(l.line_no),
        productId: l.product_id,
        name: l.name ?? '',
        unit: l.unit ?? 'piece',
        qtyMilli: Number(l.qty_milli),
        unitPricePaise: Number(l.unit_price_paise),
        discountPaise: Number(l.discount_paise),
        hsn: l.hsn,
        taxRateBp: Number(l.tax_rate_bp),
        taxPaise: Number(l.tax_paise),
        lineTotalPaise: Number(l.line_total_paise),
        returnedQtyMilli: r.qty,
        returnedTaxPaise: r.tax,
        returnedTotalPaise: r.total,
      }
    }),
    payments: payments.map((p) => ({ direction: p.direction, mode: p.mode, amountPaise: Number(p.amount_paise) })),
    paidPaise,
    returnedTotalPaise: returnedTotal,
  }
}

/**
 * Prorate a return. Amounts come from CUMULATIVE proration of the ORIGINAL line total / tax: the credit for a return
 * of q on top of q0 already returned is C(q0 + q) - C(q0) with C(x) = round(total * x / invoicedQty), and the return
 * that reaches the invoiced quantity takes exactly what is left (total - already credited). So any sequence of
 * partial returns telescopes to the original line total and tax to the paisa, and can never exceed them. Tax is
 * reversed at the invoiced rate. Pure.
 */
export function computeReturn(invoice: ReturnInvoice, selections: readonly ReturnSelection[]): ReturnComputation {
  const wanted = new Map<number, number>()
  for (const s of selections) {
    if (!Number.isSafeInteger(s.qtyMilli) || s.qtyMilli <= 0) throw new BillingError('invalid_quantity')
    wanted.set(s.lineNo, (wanted.get(s.lineNo) ?? 0) + s.qtyMilli)
  }
  if (wanted.size === 0) throw new BillingError('nothing_to_return')
  const lines: CreditNoteLine[] = []
  for (const [lineNo, qty] of [...wanted].sort((a, b) => a[0] - b[0])) {
    const l = invoice.lines.find((x) => x.lineNo === lineNo)
    if (!l) throw new BillingError('unknown_line', String(lineNo))
    const after = l.returnedQtyMilli + qty
    if (after > l.qtyMilli) throw new BillingError('return_exceeds_sold', `line ${lineNo}`)
    const last = after === l.qtyMilli
    const leftTotal = l.lineTotalPaise - l.returnedTotalPaise
    const leftTax = l.taxPaise - l.returnedTaxPaise
    const total = last
      ? leftTotal
      : Math.min(leftTotal, Math.max(0, mulDiv(l.lineTotalPaise, after, l.qtyMilli) - l.returnedTotalPaise))
    let tax = last ? leftTax : Math.min(leftTax, Math.max(0, mulDiv(l.taxPaise, after, l.qtyMilli) - l.returnedTaxPaise))
    if (!last) tax = Math.min(tax, total)
    lines.push({
      invoiceLineNo: lineNo,
      productId: l.productId,
      qtyMilli: qty,
      taxRateBp: l.taxRateBp,
      taxPaise: Math.max(0, tax),
      lineTotalPaise: Math.max(0, total),
    })
  }
  return {
    lines,
    totalPaise: lines.reduce((a, l) => a + l.lineTotalPaise, 0),
    taxPaise: lines.reduce((a, l) => a + (l.taxPaise ?? 0), 0),
  }
}

/** Default way to give the money back: first reduce what the customer still owes on this invoice, the rest in `mode`. */
export function suggestRefund(
  invoice: Pick<ReturnInvoice, 'totalPaise' | 'paidPaise' | 'returnedTotalPaise' | 'partyId'>,
  creditNoteTotalPaise: number,
  mode: 'cash' | 'upi' | 'card' = 'cash',
): RefundPart[] {
  const owedOnInvoice = Math.max(0, invoice.totalPaise - invoice.paidPaise - invoice.returnedTotalPaise)
  const toKhata = invoice.partyId === null ? 0 : Math.min(owedOnInvoice, creditNoteTotalPaise)
  const parts: RefundPart[] = []
  if (toKhata > 0) parts.push({ kind: 'khata', amountPaise: toKhata })
  if (creditNoteTotalPaise - toKhata > 0) parts.push({ kind: mode, amountPaise: creditNoteTotalPaise - toKhata })
  return parts
}

export type RefundPart =
  | { kind: 'cash' | 'upi' | 'card'; amountPaise: number; reference?: string | null }
  | { kind: 'khata'; amountPaise: number }

export interface CommitReturnInput {
  requestId: string
  invoiceId: string
  selections: readonly ReturnSelection[]
  /** Mandatory, non-blank. */
  reason: string
  /** How the credit-note total is given back; must sum to it. */
  refunds: readonly RefundPart[]
  /** Owner approval (PIN checked on the device). The server flags a credit note without one. */
  approval?: Approval | null
  partyName?: string | null
  profile: MerchantProfile
  identity: DeviceScope
  actorUserId: string | null
  cashierName?: string | null
  now: Date | number
}

export interface CommitReturnResult {
  creditNoteId: string
  label: string
  series: string
  number: number
  totalPaise: number
  receipt: ReceiptData
}

interface StoredReturn {
  creditNoteId: string
  series: string
  number: number
  issuedAtIso: string
  totalPaise: number
  lines: CreditNoteLine[]
  againstLabel: string
  docType: DocType
  names: Record<number, string>
  units: Record<number, Unit>
  unitPrices: Record<number, number>
}

const retKey = (id: string) => `ret_req:${id}`

function receiptOf(input: CommitReturnInput, s: StoredReturn): ReceiptData {
  const pseudo: PricedLine[] = s.lines.map((l, i) => ({
    lineNo: i + 1,
    productId: l.productId,
    hsn: null,
    qtyMilli: l.qtyMilli,
    unitPricePaise: 0,
    grossPaise: l.lineTotalPaise,
    discountPaise: 0,
    taxRateBp: l.taxRateBp ?? 0,
    taxPaise: l.taxPaise,
    taxablePaise: l.lineTotalPaise - l.taxPaise,
    lineTotalPaise: l.lineTotalPaise,
  }))
  const tax = s.lines.reduce((a, l) => a + l.taxPaise, 0)
  const tenders: Tender[] = input.refunds.map((r) =>
    r.kind === 'khata' ? { mode: 'credit', amountPaise: r.amountPaise } : { mode: r.kind, amountPaise: r.amountPaise, reference: r.reference ?? null },
  )
  return {
    kind: 'credit_note',
    business: {
      businessName: input.profile.businessName,
      gstin: input.profile.gstin,
      address: input.profile.address,
      phone: input.profile.phone,
      upiVpa: input.profile.upiVpa,
      gstMode: input.profile.gstMode,
    },
    docType: 'credit_note',
    label: documentLabel(s.series, s.number),
    issuedAtIso: s.issuedAtIso,
    againstLabel: s.againstLabel,
    customerName: input.partyName ?? null,
    cashierName: input.cashierName ?? null,
    lines: s.lines.map((l) => ({
      name: s.names[l.invoiceLineNo] ?? '',
      localName: null,
      qtyMilli: l.qtyMilli,
      unit: s.units[l.invoiceLineNo] ?? 'piece',
      unitPricePaise: s.unitPrices[l.invoiceLineNo] ?? 0,
      discountPaise: 0,
      taxRateBp: l.taxRateBp ?? 0,
      lineTotalPaise: l.lineTotalPaise,
    })),
    subtotalPaise: s.totalPaise - tax,
    taxPaise: tax,
    discountPaise: 0,
    roundOffPaise: 0,
    totalPaise: s.totalPaise,
    taxBreakup: input.profile.gstMode === 'regular' ? taxBreakup(pseudo) : [],
    tenders,
    changeDuePaise: 0,
    creditPaise: input.refunds.filter((r) => r.kind === 'khata').reduce((a, r) => a + r.amountPaise, 0),
  }
}

function resultOf(input: CommitReturnInput, s: StoredReturn): CommitReturnResult {
  return {
    creditNoteId: s.creditNoteId,
    label: documentLabel(s.series, s.number),
    series: s.series,
    number: s.number,
    totalPaise: s.totalPaise,
    receipt: receiptOf(input, s),
  }
}

/**
 * Record a return as a credit note, in ONE local transaction (the over-return check reads the credit notes INSIDE it,
 * so two quick returns can never exceed the sold quantity):
 *   op credit_note (+ optimistic credit_note row), op stock_movement (reason sale_return, positive) per returned line,
 *   op payment (direction out) for each money refund, op khata_entry (credit) for the part that reduces the
 *   customer's balance. Idempotent per requestId. Errors: reason_required, nothing_to_return, unknown_line,
 *   return_exceeds_sold, return_amount_zero, refund_mismatch, credit_needs_customer, invoice_not_found.
 */
export async function commitReturn(writer: OpLogWriter, db: StateReader, input: CommitReturnInput): Promise<CommitReturnResult> {
  const reason = input.reason.trim()
  if (reason === '') throw new BillingError('reason_required')
  if (input.approval && input.approval.reason.trim() === '') throw new BillingError('approval_reason_required')
  const approval = input.approval ? { approverUserId: input.approval.approverUserId, reason: input.approval.reason.trim() } : null
  for (const r of input.refunds) {
    if (!Number.isSafeInteger(r.amountPaise) || r.amountPaise <= 0) throw new BillingError('invalid_tender')
    if (r.kind === 'card') assertSafeCardReference(r.reference)
  }

  const prior = await getJson<StoredReturn>(db, retKey(input.requestId))
  if (prior) return resultOf(input, prior)

  const nowMs = new Date(input.now).getTime()
  const issuedAtIso = new Date(nowMs).toISOString()
  const fy = financialYear(istDate(nowMs))
  const { tenantId, storeId, deviceId } = input.identity
  const series = creditNoteSeries(deviceId, fy)
  let stored: StoredReturn | null = null
  let duplicate: StoredReturn | null = null

  await writer.writeAllWith(async (tx) => {
    const again = await getJson<StoredReturn>(tx, retKey(input.requestId))
    if (again) {
      duplicate = again
      return []
    }
    const invoice = await loadInvoiceForReturn(tx, input.invoiceId)
    const comp = computeReturn(invoice, input.selections)
    if (comp.totalPaise <= 0) throw new BillingError('return_amount_zero')
    const refundSum = input.refunds.reduce((a, r) => a + r.amountPaise, 0)
    if (refundSum !== comp.totalPaise) throw new BillingError('refund_mismatch')
    if (input.refunds.some((r) => r.kind === 'khata') && invoice.partyId === null) throw new BillingError('credit_needs_customer')

    const number = await allocateNumber(tx, series)
    const creditNoteId = uuidv7(nowMs)
    const names: Record<number, string> = {}
    const units: Record<number, Unit> = {}
    const unitPrices: Record<number, number> = {}
    for (const l of invoice.lines) {
      names[l.lineNo] = l.name
      units[l.lineNo] = l.unit
      unitPrices[l.lineNo] = l.unitPricePaise
    }
    stored = { creditNoteId, series, number, issuedAtIso, totalPaise: comp.totalPaise, lines: comp.lines, againstLabel: invoice.label, docType: invoice.docType, names, units, unitPrices }
    await setJson(tx, retKey(input.requestId), stored)

    const items: WriteItem[] = []
    items.push(
      item(
        {
          entityType: 'credit_note',
          entityId: creditNoteId,
          opType: 'create',
          actorUserId: input.actorUserId,
          payload: {
            series,
            number,
            invoiceId: invoice.id,
            partyId: invoice.partyId,
            reason,
            totalPaise: comp.totalPaise,
            lines: comp.lines,
            ...(approval ? { approval } : {}),
          },
        },
        [
          {
            sql: `INSERT OR REPLACE INTO credit_note (id, tenant_id, store_id, device_id, series, number, invoice_id, party_id, reason,
                    total_paise, lines, hlc, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            params: [
              creditNoteId, tenantId, storeId, deviceId, series, number, invoice.id, invoice.partyId, reason, comp.totalPaise,
              JSON.stringify(comp.lines), null, issuedAtIso,
            ],
          },
        ],
      ),
    )
    for (const l of comp.lines) {
      items.push(
        item(
          {
            entityType: 'stock_movement',
            entityId: uuidv7(nowMs),
            opType: 'create',
            actorUserId: input.actorUserId,
            payload: { productId: l.productId, qtyMilli: l.qtyMilli, reason: 'sale_return', refType: 'credit_note', refId: creditNoteId, occurredAt: issuedAtIso },
          },
          [adjustStockBalance(tenantId, storeId, l.productId, l.qtyMilli)],
        ),
      )
    }
    for (const r of input.refunds) {
      if (r.kind === 'khata') {
        items.push(
          item(
            {
              entityType: 'khata_entry',
              entityId: uuidv7(nowMs),
              opType: 'create',
              actorUserId: input.actorUserId,
              payload: { partyId: invoice.partyId!, direction: 'credit', amountPaise: r.amountPaise, refType: 'credit_note', refId: creditNoteId, occurredAt: issuedAtIso },
            },
            [adjustKhataBalance(tenantId, invoice.partyId!, -r.amountPaise)],
          ),
        )
        continue
      }
      const paymentId = uuidv7(nowMs)
      const reference = r.kind === 'card' ? assertSafeCardReference(r.reference) : (r.reference?.trim() || null)
      items.push(
        item(
          {
            entityType: 'payment',
            entityId: paymentId,
            opType: 'create',
            actorUserId: input.actorUserId,
            payload: {
              partyId: invoice.partyId,
              invoiceId: invoice.id,
              direction: 'out',
              mode: r.kind,
              amountPaise: r.amountPaise,
              ...(reference ? { reference } : {}),
              occurredAt: issuedAtIso,
            },
          },
          [
            {
              sql: `INSERT OR REPLACE INTO payment (id, tenant_id, store_id, party_id, invoice_id, direction, mode, amount_paise,
                      reference, occurred_at) VALUES (?, ?, ?, ?, ?, 'out', ?, ?, ?, ?)`,
              params: [paymentId, tenantId, storeId, invoice.partyId, invoice.id, r.kind, r.amountPaise, reference, issuedAtIso],
            },
          ],
        ),
      )
      if (r.kind === 'cash') await recordCashMovement(tx, 'out', r.amountPaise)
    }
    return items
  })

  const final = (duplicate ?? stored) as StoredReturn | null
  if (final === null) throw new Error('commitReturn wrote nothing')
  return resultOf(input, final)
}
