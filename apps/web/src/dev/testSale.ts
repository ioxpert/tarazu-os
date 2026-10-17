import { adjustKhataBalance, adjustStockBalance } from '../sync/effects'
import { item, type WriteItem } from '../sync/oplog'
import { uuidv7 } from '../sync/uuid7'

export interface SaleContext {
  tenantId: string
  storeId: string
  deviceId: string
  productId: string
  partyId: string
  /** Next invoice number in this device's series. */
  number: number
  actorUserId?: string | null
  now?: Date
}

/** One-time master data so a sale has something to refer to. */
export function buildCatalogue(ctx: Pick<SaleContext, 'productId' | 'partyId' | 'actorUserId'>): WriteItem[] {
  return [
    item({ entityType: 'product', entityId: ctx.productId, opType: 'create', actorUserId: ctx.actorUserId, payload: { name: 'Harness Biscuit 100g', unit: 'pcs', hsn: '1905' } }),
    item({ entityType: 'party', entityId: ctx.partyId, opType: 'create', actorUserId: ctx.actorUserId, payload: { name: 'Harness Customer', partyType: 'customer' } }),
  ]
}

/**
 * A credit sale of 1 unit at Rs 50: invoice + stock movement + khata debit, as the billing UI will commit it.
 * Intended for ONE writer.writeAll() call so the three ops and their local effects are atomic.
 */
export function buildSale(ctx: SaleContext): WriteItem[] {
  const invoiceId = uuidv7()
  const date = (ctx.now ?? new Date()).toISOString().slice(0, 10)
  const total = 5000
  const actor = ctx.actorUserId ?? null
  return [
    item({
      entityType: 'invoice',
      entityId: invoiceId,
      opType: 'create',
      actorUserId: actor,
      payload: {
        series: `${ctx.deviceId.slice(0, 8)}-2026-27`,
        number: ctx.number,
        docType: 'retail_invoice',
        invoiceDate: date,
        partyId: ctx.partyId,
        subtotalPaise: total,
        discountPaise: 0,
        taxPaise: 0,
        roundOffPaise: 0,
        totalPaise: total,
        lines: [{ productId: ctx.productId, qtyMilli: 1000, unitPricePaise: total, discountPaise: 0, taxRateBp: 0, taxPaise: 0, lineTotalPaise: total }],
      },
    }, [
      {
        sql: `INSERT OR REPLACE INTO invoice (id, tenant_id, store_id, device_id, series, number, doc_type, invoice_date, party_id,
                subtotal_paise, discount_paise, tax_paise, round_off_paise, total_paise, created_at)
              VALUES (?, ?, ?, ?, ?, ?, 'retail_invoice', ?, ?, ?, 0, 0, 0, ?, ?)`,
        params: [invoiceId, ctx.tenantId, ctx.storeId, ctx.deviceId, `${ctx.deviceId.slice(0, 8)}-2026-27`, ctx.number, date, ctx.partyId, total, total, new Date().toISOString()],
      },
      {
        sql: `INSERT OR REPLACE INTO invoice_line (id, tenant_id, invoice_id, line_no, product_id, qty_milli, unit_price_paise,
                discount_paise, tax_rate_bp, tax_paise, line_total_paise)
              VALUES (?, ?, ?, 1, ?, 1000, ?, 0, 0, 0, ?)`,
        params: [`${invoiceId}:1`, ctx.tenantId, invoiceId, ctx.productId, total, total],
      },
    ]),
    item({
      entityType: 'stock_movement',
      entityId: uuidv7(),
      opType: 'create',
      actorUserId: actor,
      payload: { productId: ctx.productId, qtyMilli: -1000, reason: 'sale', refType: 'invoice', refId: invoiceId },
    }, [adjustStockBalance(ctx.tenantId, ctx.storeId, ctx.productId, -1000)]),
    item({
      entityType: 'khata_entry',
      entityId: uuidv7(),
      opType: 'create',
      actorUserId: actor,
      payload: { partyId: ctx.partyId, direction: 'debit', amountPaise: total, refType: 'invoice', refId: invoiceId },
    }, [adjustKhataBalance(ctx.tenantId, ctx.partyId, total)]),
  ]
}

/** Nearest-rank percentile (p in 0..100) of a list of numbers. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]
}
