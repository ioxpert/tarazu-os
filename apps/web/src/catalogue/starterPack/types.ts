import type { UomSpec, Unit } from '../types'

export type StoreType = 'grocery' | 'general'

/** One row of a bundled starter pack. */
export interface StarterItem {
  /** Stable id inside the pack ('GRO-0001', 'GEN-0001'); never reused for another item. */
  packSku: string
  /** English name as sold, including the pack size ('Parle-G Biscuit 56 g'). */
  name: string
  /** Devanagari name. */
  localName: string
  brand: string | null
  /** Category tile id. */
  category: string
  hsn: string
  unit: Unit
  uom: UomSpec
  /**
   * INDICATIVE price in paise, per BASE unit. For packaged goods an approximate printed MRP; for loose goods an
   * approximate shop rate per kg/litre (there is no printed MRP on a loose item). The merchant must review them.
   */
  mrpPaise: number
  /**
   * INDICATIVE GST rate in basis points, authored from general knowledge of the rate schedule. It is only a fallback:
   * billing uses the synced server tax rule for the HSN first and falls back to this only when no rule resolves.
   */
  indicativeTaxRateBp: number
  taxInclusive: true
  loose: boolean
  /** Always null: barcodes are never invented. Scanning an item attaches its real code. */
  barcode: null
}

export interface StarterPackFile {
  storeType: StoreType
  /** Bumps whenever item content changes. Stored in device_state `starter_pack` when seeded. */
  version: string
  note: string
  items: StarterItem[]
}
