import { PAID_SQL } from './history'
import { istDate } from './numbering'
import type { StateReader } from './settings'
import type { TenderMode } from './types'

/**
 * Sales reports computed on the device from the local read-model, so they work offline and include other counters
 * after sync. Returns are subtracted on the day the credit note was made. Cost and profit are not here (slice 2 part 2:
 * they need a decision on who may see cost, docs/specs/phase1-gap-slices.md open question 3).
 */

/** IST dates, inclusive, 'YYYY-MM-DD'. */
export interface DateRange {
  fromDate: string
  toDate: string
}

export type RangePreset = 'today' | 'week' | 'month'
const DAY = 86_400_000

export function presetRange(preset: RangePreset, now = Date.now()): DateRange {
  const today = istDate(now)
  if (preset === 'today') return { fromDate: today, toDate: today }
  if (preset === 'week') return { fromDate: istDate(now - 6 * DAY), toDate: today }
  return { fromDate: `${today.slice(0, 8)}01`, toDate: today }
}

const day = (col: string) => `date(${col}, '+330 minutes')`

export interface DailySales {
  date: string
  bills: number
  salesPaise: number
  discountPaise: number
  taxPaise: number
  returnsPaise: number
  netPaise: number
}

/** One row per IST day that had a sale or a return, oldest first. */
export async function dailySales(db: StateReader, r: DateRange): Promise<DailySales[]> {
  const sales = await db.getAll<{ d: string; bills: number; total: number; disc: number; tax: number }>(
    `SELECT ${day('created_at')} AS d, COUNT(*) AS bills, SUM(total_paise) AS total, SUM(discount_paise) AS disc, SUM(tax_paise) AS tax
     FROM invoice WHERE ${day('created_at')} BETWEEN ? AND ? GROUP BY d`,
    [r.fromDate, r.toDate],
  )
  const returns = await db.getAll<{ d: string; total: number }>(
    `SELECT ${day('created_at')} AS d, SUM(total_paise) AS total FROM credit_note WHERE ${day('created_at')} BETWEEN ? AND ? GROUP BY d`,
    [r.fromDate, r.toDate],
  )
  const by = new Map<string, DailySales>()
  const row = (d: string): DailySales => {
    let v = by.get(d)
    if (!v) by.set(d, (v = { date: d, bills: 0, salesPaise: 0, discountPaise: 0, taxPaise: 0, returnsPaise: 0, netPaise: 0 }))
    return v
  }
  for (const s of sales) Object.assign(row(s.d), { bills: Number(s.bills), salesPaise: Number(s.total), discountPaise: Number(s.disc), taxPaise: Number(s.tax) })
  for (const x of returns) row(x.d).returnsPaise = Number(x.total)
  return [...by.values()].map((v) => ({ ...v, netPaise: v.salesPaise - v.returnsPaise })).sort((a, b) => a.date.localeCompare(b.date))
}

export interface ItemSales {
  productId: string
  name: string
  qtyMilli: number
  revenuePaise: number
  returnedQtyMilli: number
  returnedPaise: number
  netQtyMilli: number
  netPaise: number
  /** Net revenue per whole unit, rounded to a paisa; 0 when nothing net was sold. */
  avgPricePaise: number
}

/** Best sellers first (by net revenue). Revenue is the line total as billed, tax included; a return takes back what it refunded. */
export async function itemSales(db: StateReader, r: DateRange): Promise<ItemSales[]> {
  const sold = await db.getAll<{ pid: string; name: string | null; qty: number; rev: number }>(
    `SELECT l.product_id AS pid, p.name AS name, SUM(l.qty_milli) AS qty, SUM(l.line_total_paise) AS rev
     FROM invoice_line l JOIN invoice i ON i.id = l.invoice_id LEFT JOIN product p ON p.id = l.product_id
     WHERE ${day('i.created_at')} BETWEEN ? AND ? GROUP BY l.product_id`,
    [r.fromDate, r.toDate],
  )
  const back = await db.getAll<{ pid: string; qty: number; rev: number }>(
    `SELECT json_extract(j.value, '$.productId') AS pid, SUM(json_extract(j.value, '$.qtyMilli')) AS qty,
            SUM(json_extract(j.value, '$.lineTotalPaise')) AS rev
     FROM credit_note c, json_each(c.lines) j
     WHERE c.lines IS NOT NULL AND ${day('c.created_at')} BETWEEN ? AND ? GROUP BY pid`,
    [r.fromDate, r.toDate],
  )
  const names = new Map(sold.map((s) => [s.pid, s.name]))
  const out = new Map<string, ItemSales>()
  const item = (pid: string, name: string | null): ItemSales => {
    let v = out.get(pid)
    if (!v) out.set(pid, (v = { productId: pid, name: name ?? '', qtyMilli: 0, revenuePaise: 0, returnedQtyMilli: 0, returnedPaise: 0, netQtyMilli: 0, netPaise: 0, avgPricePaise: 0 }))
    return v
  }
  for (const s of sold) Object.assign(item(s.pid, s.name), { qtyMilli: Number(s.qty), revenuePaise: Number(s.rev) })
  for (const b of back) Object.assign(item(b.pid, names.get(b.pid) ?? null), { returnedQtyMilli: Number(b.qty), returnedPaise: Number(b.rev) })
  const missing = [...out.values()].filter((v) => !v.name).map((v) => v.productId)
  if (missing.length > 0) {
    const rows = await db.getAll<{ id: string; name: string }>(`SELECT id, name FROM product WHERE id IN (${missing.map(() => '?').join(',')})`, missing)
    for (const p of rows) out.get(p.id)!.name = p.name
  }
  return [...out.values()]
    .map((v) => {
      const netQtyMilli = v.qtyMilli - v.returnedQtyMilli
      const netPaise = v.revenuePaise - v.returnedPaise
      return { ...v, netQtyMilli, netPaise, avgPricePaise: netQtyMilli > 0 ? Math.round((netPaise * 1000) / netQtyMilli) : 0 }
    })
    .sort((a, b) => b.netPaise - a.netPaise || a.name.localeCompare(b.name))
}

export interface Summary {
  bills: number
  salesPaise: number
  returnsPaise: number
  netPaise: number
  /** Money that came in with each mode for bills in the range, less refunds. */
  byMode: Record<Exclude<TenderMode, 'credit'>, number>
  /** Left owing on khata for bills in the range. */
  creditPaise: number
}

const MODE_KEYS = ['cash', 'upi', 'card'] as const

export async function summary(db: StateReader, r: DateRange): Promise<Summary> {
  const [sale] = await db.getAll<{ bills: number; total: number | null }>(
    `SELECT COUNT(*) AS bills, SUM(total_paise) AS total FROM invoice WHERE ${day('created_at')} BETWEEN ? AND ?`,
    [r.fromDate, r.toDate],
  )
  const [ret] = await db.getAll<{ total: number | null }>(
    `SELECT SUM(total_paise) AS total FROM credit_note WHERE ${day('created_at')} BETWEEN ? AND ?`,
    [r.fromDate, r.toDate],
  )
  const modes = await db.getAll<{ mode: string; amt: number }>(
    `SELECT p.mode AS mode, SUM(CASE WHEN p.direction = 'in' THEN p.amount_paise ELSE -p.amount_paise END) AS amt
     FROM payment p JOIN invoice i ON i.id = p.invoice_id WHERE ${day('i.created_at')} BETWEEN ? AND ? GROUP BY p.mode`,
    [r.fromDate, r.toDate],
  )
  const [credit] = await db.getAll<{ owed: number | null }>(
    `SELECT SUM(MAX(0, i.total_paise - ${PAID_SQL})) AS owed FROM invoice i
     WHERE i.party_id IS NOT NULL AND ${day('i.created_at')} BETWEEN ? AND ?`,
    [r.fromDate, r.toDate],
  )
  const byMode = { cash: 0, upi: 0, card: 0 }
  for (const m of modes) if ((MODE_KEYS as readonly string[]).includes(m.mode)) byMode[m.mode as (typeof MODE_KEYS)[number]] = Number(m.amt)
  const salesPaise = Number(sale?.total ?? 0)
  const returnsPaise = Number(ret?.total ?? 0)
  return { bills: Number(sale?.bills ?? 0), salesPaise, returnsPaise, netPaise: salesPaise - returnsPaise, byMode, creditPaise: Number(credit?.owed ?? 0) }
}

export interface Position {
  /** Total owed to the shop by customers right now. */
  khataOutstandingPaise: number
  /** Items whose stock is below zero (sold more than was recorded). */
  oversoldItems: number
}

export async function position(db: StateReader): Promise<Position> {
  const [k] = await db.getAll<{ owed: number | null }>('SELECT SUM(balance_paise) AS owed FROM khata_balance WHERE balance_paise > 0')
  const [s] = await db.getAll<{ n: number }>('SELECT COUNT(*) AS n FROM stock_balance WHERE qty_milli < 0')
  return { khataOutstandingPaise: Number(k?.owed ?? 0), oversoldItems: Number(s?.n ?? 0) }
}
