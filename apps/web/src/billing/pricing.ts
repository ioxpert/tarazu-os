import type { CatalogueItem, Unit } from '../catalogue/types'
import type { LocalDb } from '../sync/schemaDb'
import { resolveLineTax, type TaxRule } from './tax'
import type { CartLine, GstMode } from './types'

export type PriceSource = CartLine['priceSource']

/**
 * Unit price (paise per BASE unit) for an item: customer rate > retail > MRP. Null when the item has no price at all
 * (the UI then asks for a manual price).
 */
export function pickUnitPrice(
  item: Pick<CatalogueItem, 'retailPaise' | 'mrpPaise'>,
  customerRatePaise: number | null,
): { unitPricePaise: number; priceSource: PriceSource } | null {
  if (customerRatePaise !== null) return { unitPricePaise: customerRatePaise, priceSource: 'customer' }
  if (item.retailPaise !== null) return { unitPricePaise: item.retailPaise, priceSource: 'retail' }
  if (item.mrpPaise !== null) return { unitPricePaise: item.mrpPaise, priceSource: 'mrp' }
  return null
}

/** A cashier-typed price always marks the line 'manual'. */
export function manualPrice(unitPricePaise: number): { unitPricePaise: number; priceSource: 'manual' } {
  if (!Number.isSafeInteger(unitPricePaise) || unitPricePaise < 0) throw new RangeError('price must be a non-negative integer')
  return { unitPricePaise, priceSource: 'manual' }
}

interface RateRow {
  amount_paise: number
  effective_from: string
  hlc: string | null
}

/** The latest customer rate for (product, party) effective at `at`; same effective instant: the later HLC wins. */
export async function loadCustomerRate(
  db: Pick<LocalDb, 'getAll'>,
  productId: string,
  partyId: string,
  at: Date | number,
): Promise<number | null> {
  const atMs = typeof at === 'number' ? at : at.getTime()
  const rows = await db.getAll<RateRow>(
    `SELECT amount_paise, effective_from, hlc FROM price_version
     WHERE product_id = ? AND party_id = ? AND price_type = 'customer'`,
    [productId, partyId],
  )
  let best: { ms: number; hlc: string; amount: number } | null = null
  for (const r of rows) {
    const ms = Date.parse(r.effective_from)
    if (Number.isNaN(ms) || ms > atMs) continue
    const hlc = r.hlc ?? ''
    if (best === null || ms > best.ms || (ms === best.ms && hlc > best.hlc)) best = { ms, hlc, amount: Number(r.amount_paise) }
  }
  return best === null ? null : best.amount
}

export interface NewLineOptions {
  qtyMilli: number
  unit?: Unit
  /** Result of loadCustomerRate for the cart's party. */
  customerRatePaise?: number | null
  /** Cashier-typed unit price (per base unit); wins over everything and marks the line 'manual'. */
  manualUnitPricePaise?: number | null
  rules: readonly TaxRule[]
  gstMode: GstMode
  /** Invoice date 'YYYY-MM-DD'. */
  onDate: string
  lineId?: string
}

/** Build a cart line from a catalogue item (price pick + tax resolve). Null if no price is known and none was typed. */
export function cartLineFromItem(item: CatalogueItem, o: NewLineOptions): CartLine | null {
  const price =
    o.manualUnitPricePaise != null ? manualPrice(o.manualUnitPricePaise) : pickUnitPrice(item, o.customerRatePaise ?? null)
  if (price === null) return null
  const tax = o.gstMode === 'regular' ? resolveLineTax(item, o.rules, o.onDate) : { rateBp: 0, source: 'none' as const }
  return {
    lineId: o.lineId ?? crypto.randomUUID(),
    productId: item.id,
    name: item.name,
    localName: item.localName,
    hsn: item.hsn,
    qtyMilli: o.qtyMilli,
    unit: o.unit ?? item.unit,
    unitPricePaise: price.unitPricePaise,
    priceSource: price.priceSource,
    taxInclusive: item.taxInclusive,
    taxRateBp: tax.rateBp,
    taxRateSource: tax.source,
    discount: null,
  }
}
