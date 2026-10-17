import { documentLabel } from '../billing/numbering'
import type { StateReader } from '../billing/settings'

export interface PurchaseRow {
  id: string
  label: string
  supplierName: string | null
  supplierRef: string | null
  receiptDate: string
  totalPaise: number
  lineCount: number
}

/** Recent purchase receipts, newest first. */
export async function listPurchases(db: StateReader, limit = 50): Promise<PurchaseRow[]> {
  const rows = await db.getAll<{ id: string; series: string; number: number; supplier_ref: string | null; receipt_date: string; total_paise: number; lines: string | null; supplier: string | null }>(
    `SELECT r.id AS id, r.series AS series, r.number AS number, r.supplier_ref AS supplier_ref, r.receipt_date AS receipt_date,
            r.total_paise AS total_paise, r.lines AS lines, p.name AS supplier
     FROM purchase_receipt r LEFT JOIN party p ON p.id = r.supplier_id
     ORDER BY r.receipt_date DESC, r.created_at DESC, r.number DESC LIMIT ?`,
    [limit],
  )
  return rows.map((r) => {
    let lineCount = 0
    try {
      lineCount = (JSON.parse(r.lines ?? '[]') as unknown[]).length
    } catch {
      lineCount = 0
    }
    return { id: r.id, label: documentLabel(r.series, Number(r.number)), supplierName: r.supplier, supplierRef: r.supplier_ref, receiptDate: r.receipt_date, totalPaise: Number(r.total_paise), lineCount }
  })
}

/** Latest purchase price per base unit for each product (paise), for the cost column and margin hints. */
export async function loadLastCosts(db: StateReader, ids: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (ids.length === 0) return out
  const rows = await db.getAll<{ product_id: string; amount_paise: number }>(
    `SELECT product_id, amount_paise FROM price_version
     WHERE price_type = 'purchase' AND (party_id IS NULL OR party_id = '') AND product_id IN (${ids.map(() => '?').join(',')})
     ORDER BY effective_from ASC, hlc ASC`,
    [...ids],
  )
  for (const r of rows) out.set(r.product_id, Number(r.amount_paise)) // later rows win
  return out
}

/** Profit as a share of the selling price, in basis points (2500 = 25%). Null when there is no price to compare. */
export function marginBp(sellingPaise: number | null, costPaise: number | null): number | null {
  if (sellingPaise === null || costPaise === null || sellingPaise <= 0) return null
  return Math.round(((sellingPaise - costPaise) * 10_000) / sellingPaise)
}
