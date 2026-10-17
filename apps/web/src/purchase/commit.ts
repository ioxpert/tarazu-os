import type { components } from '../api/schema'
import { BillingError } from '../billing/errors'
import { mulDiv } from '../billing/money'
import { allocateNumber, documentLabel, financialYear, istDate, purchaseSeries } from '../billing/numbering'
import { assertSafeCardReference } from '../billing/card'
import { getJson, setJson, type StateReader } from '../billing/settings'
import { recordCashMovement } from '../billing/shift'
import { adjustStockBalance, khataEntryEffects } from '../sync/effects'
import { item, type OpLogWriter, type WriteItem } from '../sync/oplog'
import { uuidv7 } from '../sync/uuid7'

type PurchaseLine = components['schemas']['PurchaseLine']

export type PayMode = 'cash' | 'upi' | 'card' | 'bank_transfer' | 'cheque'

export interface PurchaseLineInput {
  productId: string
  /** Milli-units of the product's BASE unit. */
  qtyMilli: number
  /** Cost per BASE unit, paise, tax-inclusive. */
  unitCostPaise: number
}

export interface PurchasePayment {
  mode: PayMode
  amountPaise: number
  reference?: string | null
}

export interface CommitPurchaseInput {
  /** Made when the screen opens; a double tap returns the first receipt instead of a second one. */
  requestId: string
  supplier: { id: string; name: string } | null
  /** The supplier's own bill number, as printed on their bill. */
  supplierRef?: string | null
  lines: readonly PurchaseLineInput[]
  /** Money paid to the supplier now. Whatever is left is owed to them and needs a supplier. */
  payments: readonly PurchasePayment[]
  /** Keep the last purchase price of each product up to date (default true). */
  updateCost?: boolean
  identity: { tenantId: string; storeId: string; deviceId: string }
  actorUserId: string | null
  now: Date | number
  /** 'YYYY-MM-DD' (IST) of the supplier's bill; default today. */
  receiptDate?: string
}

export interface CommitPurchaseResult {
  receiptId: string
  label: string
  totalPaise: number
  paidPaise: number
  /** What is now owed to the supplier because of this receipt. */
  owedPaise: number
  lines: PurchaseLine[]
}

const isPaise = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0

export function priceLines(lines: readonly PurchaseLineInput[]): { lines: PurchaseLine[]; totalPaise: number } {
  if (lines.length === 0) throw new BillingError('nothing_received')
  const out: PurchaseLine[] = lines.map((l) => {
    if (!Number.isSafeInteger(l.qtyMilli) || l.qtyMilli <= 0) throw new BillingError('invalid_quantity')
    if (!isPaise(l.unitCostPaise)) throw new BillingError('invalid_price')
    return { productId: l.productId, qtyMilli: l.qtyMilli, unitCostPaise: l.unitCostPaise, lineTotalPaise: mulDiv(l.qtyMilli, l.unitCostPaise, 1000) }
  })
  return { lines: out, totalPaise: out.reduce((a, l) => a + l.lineTotalPaise, 0) }
}

interface Stored {
  result: CommitPurchaseResult
}

/**
 * "Stock came in with a bill". ONE local transaction writes the purchase receipt (next number of this device's PR
 * series), a stock movement per line (reason purchase, so stock rises by exactly what was received), a new
 * purchase price per product when the cost changed, a payment out for money handed over now, and a khata credit on
 * the supplier for what is still owed (balance negative = you owe them). Never touches the network.
 */
export async function commitPurchase(writer: OpLogWriter, db: StateReader, input: CommitPurchaseInput): Promise<CommitPurchaseResult> {
  void db
  const priced = priceLines(input.lines)
  let paid = 0
  for (const p of input.payments) {
    if (!isPaise(p.amountPaise)) throw new BillingError('invalid_tender')
    if (p.mode === 'card') assertSafeCardReference(p.reference)
    paid += p.amountPaise
  }
  if (paid > priced.totalPaise) throw new BillingError('tender_excess')
  const owed = priced.totalPaise - paid
  if (owed > 0 && input.supplier === null) throw new BillingError('supplier_needed')

  const nowMs = new Date(input.now).getTime()
  const occurredAt = new Date(nowMs).toISOString()
  const receiptDate = input.receiptDate ?? istDate(nowMs)
  const { tenantId, storeId, deviceId } = input.identity
  const reqKey = `pur_req:${input.requestId}`
  let result: CommitPurchaseResult | null = null

  await writer.writeAllWith(async (tx) => {
    const done = await getJson<Stored>(tx, reqKey)
    if (done) {
      result = done.result
      return []
    }
    const series = purchaseSeries(deviceId, financialYear(receiptDate))
    const number = await allocateNumber(tx, series)
    const receiptId = uuidv7(nowMs)
    const label = documentLabel(series, number)
    result = { receiptId, label, totalPaise: priced.totalPaise, paidPaise: paid, owedPaise: owed, lines: priced.lines }
    await setJson(tx, reqKey, { result } satisfies Stored)

    const ops: WriteItem[] = []
    ops.push(
      item(
        {
          entityType: 'purchase_receipt',
          entityId: receiptId,
          opType: 'create',
          actorUserId: input.actorUserId,
          payload: {
            series,
            number,
            supplierId: input.supplier?.id ?? null,
            supplierRef: input.supplierRef?.trim() || null,
            receiptDate,
            totalPaise: priced.totalPaise,
            lines: priced.lines,
          },
        },
        [
          {
            sql: `INSERT OR REPLACE INTO purchase_receipt (id, tenant_id, store_id, device_id, series, number, supplier_id, supplier_ref,
                    receipt_date, total_paise, lines, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            params: [receiptId, tenantId, storeId, deviceId, series, number, input.supplier?.id ?? null, input.supplierRef?.trim() || null, receiptDate, priced.totalPaise, JSON.stringify(priced.lines), occurredAt],
          },
        ],
      ),
    )

    for (const l of priced.lines) {
      ops.push(
        item(
          {
            entityType: 'stock_movement',
            entityId: uuidv7(nowMs),
            opType: 'create',
            actorUserId: input.actorUserId,
            payload: { productId: l.productId, qtyMilli: l.qtyMilli, reason: 'purchase', refType: 'purchase_receipt', refId: receiptId, occurredAt },
          },
          [adjustStockBalance(tenantId, storeId, l.productId, l.qtyMilli)],
        ),
      )
    }

    if (input.updateCost !== false) {
      for (const l of priced.lines) {
        const [last] = await tx.getAll<{ amount_paise: number }>(
          `SELECT amount_paise FROM price_version WHERE product_id = ? AND price_type = 'purchase' AND (party_id IS NULL OR party_id = '')
           ORDER BY effective_from DESC, hlc DESC LIMIT 1`,
          [l.productId],
        )
        if (last && Number(last.amount_paise) === l.unitCostPaise) continue
        const priceId = uuidv7(nowMs)
        const payload = { productId: l.productId, priceType: 'purchase' as const, partyId: null, amountPaise: l.unitCostPaise, effectiveFrom: occurredAt }
        ops.push(
          item(
            { entityType: 'price_version', entityId: priceId, opType: 'create', actorUserId: input.actorUserId, payload },
            [
              {
                sql: `INSERT OR REPLACE INTO price_version (id, tenant_id, product_id, party_id, price_type, amount_paise, effective_from, hlc)
                      VALUES (?, ?, ?, NULL, 'purchase', ?, ?, ?)`,
                params: [priceId, tenantId, l.productId, l.unitCostPaise, occurredAt, `${occurredAt}-0000-${deviceId.slice(0, 8)}`],
              },
            ],
          ),
        )
      }
    }

    for (const p of input.payments) {
      if (p.amountPaise === 0) continue
      const paymentId = uuidv7(nowMs)
      const reference = p.reference?.trim() || null
      ops.push(
        item(
          {
            entityType: 'payment',
            entityId: paymentId,
            opType: 'create',
            actorUserId: input.actorUserId,
            payload: { partyId: input.supplier?.id ?? null, invoiceId: null, direction: 'out', mode: p.mode, amountPaise: p.amountPaise, reference: reference ?? `purchase ${label}`, occurredAt },
          },
          [
            {
              sql: `INSERT OR REPLACE INTO payment (id, tenant_id, store_id, party_id, invoice_id, direction, mode, amount_paise, reference, occurred_at)
                    VALUES (?, ?, ?, ?, NULL, 'out', ?, ?, ?, ?)`,
              params: [paymentId, tenantId, storeId, input.supplier?.id ?? null, p.mode, p.amountPaise, reference ?? `purchase ${label}`, occurredAt],
            },
          ],
        ),
      )
      if (p.mode === 'cash') await recordCashMovement(tx, 'out', p.amountPaise)
    }

    if (owed > 0 && input.supplier) {
      const khataId = uuidv7(nowMs)
      ops.push(
        item(
          {
            entityType: 'khata_entry',
            entityId: khataId,
            opType: 'create',
            actorUserId: input.actorUserId,
            payload: { partyId: input.supplier.id, direction: 'credit', amountPaise: owed, refType: 'purchase_receipt', refId: receiptId, occurredAt },
          },
          khataEntryEffects({ id: khataId, tenantId, storeId, partyId: input.supplier.id, direction: 'credit', amountPaise: owed, refType: 'purchase_receipt', refId: receiptId, note: null, occurredAt }),
        ),
      )
    }
    return ops
  })
  if (result === null) throw new Error('commitPurchase wrote nothing')
  return result
}
