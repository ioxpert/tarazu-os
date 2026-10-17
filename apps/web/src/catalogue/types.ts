import type { components } from '../api/schema'

export type Unit = components['schemas']['UomUnit']
export type UomSpec = components['schemas']['UomSpec']

/**
 * A sellable item as the counter sees it: the synced `product` row plus its current prices and stock.
 * Quantities are milli-units of the BASE unit of `uom` (1000 = one base unit); prices are paise per base unit.
 */
export interface CatalogueItem {
  id: string
  name: string
  /** Name in the merchant's language (e.g. Devanagari), shown first when the UI language matches. */
  localName: string | null
  brand: string | null
  category: string | null
  barcode: string | null
  sku: string | null
  /** Set when the item came from the bundled starter pack. */
  packSku: string | null
  hsn: string | null
  /** Default selling unit. Always `uom.base` or one of `uom.units`. */
  unit: Unit
  /** Never null here: a product row without a chain gets { base: unit, units: [] }. */
  uom: UomSpec
  /** Prices are tax-inclusive (MRP style). */
  taxInclusive: boolean
  /** Merchant's own rate, used only when no server tax rule resolves for the HSN. */
  taxRateBp: number | null
  loose: boolean
  pinned: boolean
  active: boolean
  mrpPaise: number | null
  /** Current selling price per base unit; null until the merchant sets one (billing then falls back to MRP). */
  retailPaise: number | null
  stockMilli: number | null
  oversold: boolean
}
