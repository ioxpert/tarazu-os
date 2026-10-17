import type { components } from '../api/schema'
import { adjustKhataBalance, adjustStockBalance } from '../sync/effects'
import { item, type OpLogWriter, type WriteItem } from '../sync/oplog'
import type { LocalDb } from '../sync/schemaDb'
import { uuidv7 } from '../sync/uuid7'
import { BillingError } from './errors'
import { allocateNumber, documentLabel, financialYear, invoiceSeries, istDate } from './numbering'
import { getJson, setJson } from './settings'
import { recordCashMovement } from './shift'
import { settleTenders, type Settlement } from './tender'
import type { CartLine, MerchantProfile, PricedBill, ReceiptData, Tender } from './types'

export type Approval = components['schemas']['Approval']

export interface DeviceScope {
  tenantId: string
  storeId: string
  deviceId: string
}

export interface PartyRef {
  id: string
  name: string
}

export interface CommitSaleInput {
  /** Client request id (UUID made when the cashier taps Pay). A second commit with the same id returns the first result. */
  requestId: string
  /** The priced bill, exactly as shown to the customer (from priceCart). */
  bill: PricedBill
  /** The cart lines the bill was priced from, in the same order. */
  lines: readonly CartLine[]
  party: PartyRef | null
  tenders: readonly Tender[]
  profile: MerchantProfile
  identity: DeviceScope
  actorUserId: string | null
  cashierName?: string | null
  /** Owner approval for a discount above policy or a back-dated bill. Required fields: approverUserId, reason. */
  approval?: Approval | null
  now: Date | number
  /** Override the invoice date ('YYYY-MM-DD', IST) for a back-dated bill. Default: today in IST. */
  invoiceDate?: string
}

export interface CommitSaleResult {
  invoiceId: string
  label: string
  series: string
  number: number
  changeDuePaise: number
  receipt: ReceiptData
}

interface StoredRequest {
  invoiceId: string
  series: string
  number: number
  issuedAtIso: string
}

const reqKey = (id: string) => `sale_req:${id}`

function checkApproval(a: Approval | null | undefined): Approval | null {
  if (a == null) return null
  if (a.reason.trim() === '' || !a.approverUserId) throw new BillingError('approval_reason_required')
  return { approverUserId: a.approverUserId, reason: a.reason.trim() }
}

/** Defensive: the bill must be internally consistent and match the cart lines before it becomes an immutable document. */
function checkBill(input: CommitSaleInput): void {
  const { bill, lines } = input
  if (lines.length === 0 || bill.lines.length === 0) throw new BillingError('empty_cart')
  if (bill.lines.length !== lines.length) throw new BillingError('bill_lines_mismatch')
  bill.lines.forEach((b, i) => {
    if (b.productId !== lines[i].productId || b.qtyMilli !== lines[i].qtyMilli) throw new BillingError('bill_lines_mismatch')
  })
  const lineSum = bill.lines.reduce((a, l) => a + l.lineTotalPaise, 0)
  if (
    lineSum !== bill.subtotalPaise + bill.taxPaise ||
    bill.subtotalPaise + bill.taxPaise + bill.roundOffPaise !== bill.totalPaise ||
    bill.totalPaise < 0
  ) {
    throw new BillingError('bill_inconsistent')
  }
}

function buildReceipt(input: CommitSaleInput, s: StoredRequest, settlement: Settlement): ReceiptData {
  const { bill, lines, profile } = input
  return {
    kind: 'sale',
    business: {
      businessName: profile.businessName,
      gstin: profile.gstin,
      address: profile.address,
      phone: profile.phone,
      upiVpa: profile.upiVpa,
      gstMode: profile.gstMode,
    },
    docType: bill.docType,
    label: documentLabel(s.series, s.number),
    issuedAtIso: s.issuedAtIso,
    customerName: input.party?.name ?? null,
    cashierName: input.cashierName ?? null,
    lines: bill.lines.map((b, i) => ({
      name: lines[i].name,
      localName: lines[i].localName,
      qtyMilli: b.qtyMilli,
      unit: lines[i].unit,
      unitPricePaise: b.unitPricePaise,
      discountPaise: b.discountPaise,
      taxRateBp: b.taxRateBp,
      lineTotalPaise: b.lineTotalPaise,
    })),
    subtotalPaise: bill.subtotalPaise,
    taxPaise: bill.taxPaise,
    discountPaise: bill.discountPaise,
    roundOffPaise: bill.roundOffPaise,
    totalPaise: bill.totalPaise,
    taxBreakup: bill.taxBreakup,
    tenders: input.tenders.filter((t) => t.amountPaise > 0).map((t) => ({ ...t })),
    changeDuePaise: settlement.changeDuePaise,
    creditPaise: settlement.creditPaise,
  }
}

function resultFrom(input: CommitSaleInput, s: StoredRequest, settlement: Settlement): CommitSaleResult {
  return {
    invoiceId: s.invoiceId,
    label: documentLabel(s.series, s.number),
    series: s.series,
    number: s.number,
    changeDuePaise: settlement.changeDuePaise,
    receipt: buildReceipt(input, s, settlement),
  }
}

/**
 * Record a sale. ONE local transaction (OpLogWriter.writeAllWith), no network, no AI:
 *   1. allocate the next invoice number of the series (rolled back with everything else if anything throws)
 *   2. op `invoice` (+ optimistic invoice / invoice_line rows)
 *   3. op `stock_movement` (reason sale, negative) per line + stock_balance effect. Stock is NOT required to be > 0:
 *      selling below zero is allowed and shows as oversold in the stock projection.
 *   4. op `payment` (direction in) per upi / card tender and one for the cash actually kept (cash - change)
 *   5. op `khata_entry` (debit) for the credit part + khata_balance effect
 * Idempotent per input.requestId (device_state `sale_req:<id>`, written in the same transaction): a double tap
 * returns the first invoice. The op-level idempotency key then protects the upload.
 */
export async function commitSale(writer: OpLogWriter, db: Pick<LocalDb, 'getAll'>, input: CommitSaleInput): Promise<CommitSaleResult> {
  checkBill(input)
  const approval = checkApproval(input.approval)
  const settlement = settleTenders(input.bill.totalPaise, input.tenders, input.party !== null)

  const prior = await getJson<StoredRequest>(db, reqKey(input.requestId))
  if (prior) return resultFrom(input, prior, settlement)

  const nowMs = new Date(input.now).getTime()
  const issuedAtIso = new Date(nowMs).toISOString()
  const invoiceDate = input.invoiceDate ?? istDate(nowMs)
  const fy = financialYear(invoiceDate)
  const { tenantId, storeId, deviceId } = input.identity
  const series = invoiceSeries(deviceId, fy)
  const partyId = input.party?.id ?? null
  let stored: StoredRequest | null = null
  let duplicate: StoredRequest | null = null

  await writer.writeAllWith(async (tx) => {
    const again = await getJson<StoredRequest>(tx, reqKey(input.requestId))
    if (again) {
      duplicate = again
      return []
    }
    const number = await allocateNumber(tx, series)
    const invoiceId = uuidv7(nowMs)
    stored = { invoiceId, series, number, issuedAtIso }
    await setJson(tx, reqKey(input.requestId), stored)
    const { bill } = input
    const items: WriteItem[] = []

    items.push(
      item(
        {
          entityType: 'invoice',
          entityId: invoiceId,
          opType: 'create',
          actorUserId: input.actorUserId,
          payload: {
            series,
            number,
            docType: bill.docType,
            invoiceDate,
            partyId,
            subtotalPaise: bill.subtotalPaise,
            discountPaise: 0, // ADR 0009: discounts live in the lines, the header equation stays exact
            taxPaise: bill.taxPaise,
            roundOffPaise: bill.roundOffPaise,
            totalPaise: bill.totalPaise,
            ...(approval ? { approval } : {}),
            lines: bill.lines.map((b) => ({
              productId: b.productId,
              qtyMilli: b.qtyMilli,
              unitPricePaise: b.unitPricePaise,
              discountPaise: b.discountPaise,
              hsn: b.hsn,
              taxRateBp: b.taxRateBp,
              taxPaise: b.taxPaise,
              lineTotalPaise: b.lineTotalPaise,
            })),
          },
        },
        [
          {
            sql: `INSERT OR REPLACE INTO invoice (id, tenant_id, store_id, device_id, series, number, doc_type, invoice_date,
                    party_id, subtotal_paise, discount_paise, tax_paise, round_off_paise, total_paise, hlc, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            params: [
              invoiceId, tenantId, storeId, deviceId, series, number, bill.docType, invoiceDate, partyId,
              bill.subtotalPaise, 0, bill.taxPaise, bill.roundOffPaise, bill.totalPaise, null, issuedAtIso,
            ],
          },
          ...bill.lines.map((b) => ({
            sql: `INSERT OR REPLACE INTO invoice_line (id, tenant_id, invoice_id, line_no, product_id, qty_milli, unit_price_paise,
                    discount_paise, hsn, tax_rate_bp, tax_paise, line_total_paise) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            params: [
              `${invoiceId}:${b.lineNo}`, tenantId, invoiceId, b.lineNo, b.productId, b.qtyMilli, b.unitPricePaise,
              b.discountPaise, b.hsn, b.taxRateBp, b.taxPaise, b.lineTotalPaise,
            ],
          })),
        ],
      ),
    )

    for (const b of bill.lines) {
      items.push(
        item(
          {
            entityType: 'stock_movement',
            entityId: uuidv7(nowMs),
            opType: 'create',
            actorUserId: input.actorUserId,
            payload: { productId: b.productId, qtyMilli: -b.qtyMilli, reason: 'sale', refType: 'invoice', refId: invoiceId, occurredAt: issuedAtIso },
          },
          [adjustStockBalance(tenantId, storeId, b.productId, -b.qtyMilli)],
        ),
      )
    }

    for (const p of settlement.payments) {
      const paymentId = uuidv7(nowMs)
      items.push(
        item(
          {
            entityType: 'payment',
            entityId: paymentId,
            opType: 'create',
            actorUserId: input.actorUserId,
            payload: {
              partyId,
              invoiceId,
              direction: 'in',
              mode: p.mode,
              amountPaise: p.amountPaise,
              ...(p.reference ? { reference: p.reference } : {}),
              occurredAt: issuedAtIso,
            },
          },
          [
            {
              sql: `INSERT OR REPLACE INTO payment (id, tenant_id, store_id, party_id, invoice_id, direction, mode, amount_paise,
                      reference, occurred_at) VALUES (?, ?, ?, ?, ?, 'in', ?, ?, ?, ?)`,
              params: [paymentId, tenantId, storeId, partyId, invoiceId, p.mode, p.amountPaise, p.reference, issuedAtIso],
            },
          ],
        ),
      )
      if (p.mode === 'cash') await recordCashMovement(tx, 'in', p.amountPaise)
    }

    if (settlement.creditPaise > 0 && partyId !== null) {
      items.push(
        item(
          {
            entityType: 'khata_entry',
            entityId: uuidv7(nowMs),
            opType: 'create',
            actorUserId: input.actorUserId,
            payload: { partyId, direction: 'debit', amountPaise: settlement.creditPaise, refType: 'invoice', refId: invoiceId, occurredAt: issuedAtIso },
          },
          [adjustKhataBalance(tenantId, partyId, settlement.creditPaise)],
        ),
      )
    }
    return items
  })

  const final = (duplicate ?? stored) as StoredRequest | null
  if (final === null) throw new Error('commitSale wrote nothing')
  return resultFrom(input, final, settlement)
}

