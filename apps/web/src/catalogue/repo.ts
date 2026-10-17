import type { components } from '../api/schema'
import { adjustStockBalance } from '../sync/effects'
import { item as writeItem, type OpLogWriter, type WrittenOp } from '../sync/oplog'
import type { LocalDb } from '../sync/schemaDb'
import { uuidv7 } from '../sync/uuid7'
import { classifyBarcode } from './barcode'
import type { CatalogueContext } from './context'
import { findDuplicates, type DuplicateResult } from './duplicates'
import { priceVersionInsertEffect, productInsertEffect, productUpdateEffect } from './localEffects'
import { CatalogueIndex } from './search'
import { CATEGORY_TILES, type CategoryTile } from './starterPack/categories'
import type { CatalogueItem, UomSpec, Unit } from './types'
import { hasUnit, isUnit, isValidUom, looseSpec, parseUomOr, simpleSpec, toBaseMilli, UomError } from './uom'

type ProductPayload = components['schemas']['ProductPayload']
type PriceType = components['schemas']['PriceVersionPayload']['priceType']

// ---- reading ---------------------------------------------------------------------------------------------------

interface ProductRow {
  id: string
  name: string
  local_name: string | null
  brand: string | null
  category: string | null
  barcode: string | null
  sku: string | null
  pack_sku: string | null
  hsn: string | null
  unit: string | null
  uom: string | null
  tax_inclusive: number | null
  tax_rate_bp: number | null
  loose: number | null
  pinned: number | null
  active: number | null
}

interface PriceRow {
  product_id: string
  price_type: string
  amount_paise: number
  effective_from: string
  hlc: string | null
}

interface StockRow {
  product_id: string
  qty_milli: number
  oversold: number | null
}

export interface LoadOptions {
  storeId: string
  now?: Date
  /** Restrict to these product ids. */
  ids?: readonly string[]
}

const PRODUCT_COLS = `id, name, local_name, brand, category, barcode, sku, pack_sku, hsn, unit, uom, tax_inclusive, tax_rate_bp, loose, pinned, active`

function toTime(iso: string): number {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t
}

/**
 * The catalogue as the counter sees it: product rows + the current customer-less mrp/retail price (latest
 * effective_from not after `now`, the later hlc winning a tie) + this store's stock balance. Three plain queries, no
 * correlated sub-selects, because PowerSync tables are views without our own indexes.
 */
export async function loadCatalogue(db: LocalDb, opts: LoadOptions): Promise<CatalogueItem[]> {
  const now = (opts.now ?? new Date()).getTime()
  const ids = opts.ids
  if (ids && ids.length === 0) return []
  const inList = ids ? ` WHERE id IN (${ids.map(() => '?').join(',')})` : ''
  const products = await db.getAll<ProductRow>(`SELECT ${PRODUCT_COLS} FROM product${inList} ORDER BY name COLLATE NOCASE, id`, ids ? [...ids] : [])
  const prices = await db.getAll<PriceRow>(
    `SELECT product_id, price_type, amount_paise, effective_from, hlc FROM price_version
     WHERE price_type IN ('mrp', 'retail') AND (party_id IS NULL OR party_id = '')`,
  )
  const stock = await db.getAll<StockRow>('SELECT product_id, qty_milli, oversold FROM stock_balance WHERE store_id = ?', [opts.storeId])

  const best = new Map<string, { t: number; hlc: string; amount: number }>()
  for (const p of prices) {
    const t = toTime(p.effective_from)
    if (t > now) continue
    const key = `${p.product_id}|${p.price_type}`
    const cur = best.get(key)
    const hlc = p.hlc ?? ''
    if (!cur || t > cur.t || (t === cur.t && hlc > cur.hlc)) best.set(key, { t, hlc, amount: p.amount_paise })
  }
  const stockBy = new Map(stock.map((s) => [s.product_id, s]))

  return products.map((r) => {
    const unit: Unit = isUnit(r.unit) ? r.unit : 'piece'
    const s = stockBy.get(r.id)
    return {
      id: r.id,
      name: r.name,
      localName: r.local_name,
      brand: r.brand,
      category: r.category,
      barcode: r.barcode,
      sku: r.sku,
      packSku: r.pack_sku,
      hsn: r.hsn,
      unit,
      uom: parseUomOr(r.uom, unit),
      taxInclusive: r.tax_inclusive === null ? true : r.tax_inclusive !== 0,
      taxRateBp: r.tax_rate_bp,
      loose: r.loose === 1,
      pinned: r.pinned === 1,
      active: r.active === null ? true : r.active !== 0,
      mrpPaise: best.get(`${r.id}|mrp`)?.amount ?? null,
      retailPaise: best.get(`${r.id}|retail`)?.amount ?? null,
      stockMilli: s ? s.qty_milli : null,
      oversold: s ? s.oversold === 1 : false,
    }
  })
}

export async function loadItemsByBarcode(db: LocalDb, opts: { storeId: string; now?: Date }, barcode: string): Promise<CatalogueItem[]> {
  const variants = new Set([barcode])
  if (barcode.length === 12) variants.add('0' + barcode)
  if (barcode.length === 13 && barcode.startsWith('0')) variants.add(barcode.slice(1))
  const rows = await db.getAll<{ id: string }>(
    `SELECT id FROM product WHERE barcode IN (${[...variants].map(() => '?').join(',')}) AND (active IS NULL OR active != 0)`,
    [...variants],
  )
  return loadCatalogue(db, { ...opts, ids: rows.map((r) => r.id) })
}

/** Category tiles for the billing screen: only categories that have items, biggest first; unknown ids keep their id as label. */
export interface CategoryCount extends CategoryTile {
  count: number
}
export function listCategories(items: readonly CatalogueItem[], tiles: readonly CategoryTile[] = CATEGORY_TILES): CategoryCount[] {
  const counts = new Map<string, number>()
  for (const it of items) if (it.active && it.category) counts.set(it.category, (counts.get(it.category) ?? 0) + 1)
  const known = new Map(tiles.map((t) => [t.id, t]))
  return [...counts]
    .map(([id, count]) => ({ ...(known.get(id) ?? { id, en: id, hi: id }), count }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
}

/** Invoice lines per product (how often it was sold) over the last `days` days, from invoice_line (cheap: one GROUP BY). Feeds CatalogueIndex popularity. */
export async function loadPopularity(db: LocalDb, opts: { days?: number; now?: Date } = {}): Promise<Map<string, number>> {
  const since = new Date((opts.now ?? new Date()).getTime() - (opts.days ?? 30) * 86_400_000).toISOString().slice(0, 10)
  const rows = await db.getAll<{ product_id: string; n: number }>(
    `SELECT l.product_id AS product_id, COUNT(*) AS n FROM invoice_line l JOIN invoice i ON i.id = l.invoice_id
     WHERE substr(i.invoice_date, 1, 10) >= ? GROUP BY l.product_id ORDER BY n DESC, l.product_id LIMIT 500`,
    [since],
  )
  return new Map(rows.map((r) => [r.product_id, r.n]))
}

/** Most recently sold distinct products, newest first (the "recent" strip on the billing screen). */
export async function recentlySoldIds(db: LocalDb, limit = 12): Promise<string[]> {
  const rows = await db.getAll<{ product_id: string }>(
    `SELECT l.product_id AS product_id, MAX(i.created_at) AS last FROM invoice_line l JOIN invoice i ON i.id = l.invoice_id
     GROUP BY l.product_id ORDER BY last DESC, l.product_id LIMIT ?`,
    [limit],
  )
  return rows.map((r) => r.product_id)
}

// ---- writing ---------------------------------------------------------------------------------------------------

export type DraftIssue =
  | 'name_required'
  | 'name_too_long'
  | 'bad_unit'
  | 'unit_not_in_uom'
  | 'bad_uom'
  | 'bad_barcode'
  | 'bad_hsn'
  | 'bad_tax_rate'
  | 'bad_price'
  | 'bad_opening_stock'

export interface ItemDraft {
  name: string
  localName?: string | null
  brand?: string | null
  category?: string | null
  barcode?: string | null
  sku?: string | null
  hsn?: string | null
  /** Default selling unit. */
  unit: Unit
  /** Defaults to { base: unit, units: [] } (or kg/litre with g/ml for loose items). */
  uom?: UomSpec
  taxInclusive?: boolean
  taxRateBp?: number | null
  loose?: boolean
  pinned?: boolean
  /** Paise per BASE unit. */
  mrpPaise?: number | null
  retailPaise?: number | null
  /** Opening stock typed in any unit of the chain ('2' dozen, '0.5' kg). */
  openingStock?: { qty: string | number; unit: Unit } | null
  /** Pack size for the duplicate check when it is not in the name ('56 g'). */
  size?: string | null
  /** Human confirmed "yes, it is a different item" after a possible_duplicate. Never bypasses barcode_exists. */
  allowDuplicate?: boolean
}

export type CreateResult =
  | { status: 'created'; item: CatalogueItem; ops: WrittenOp[] }
  | { status: 'duplicate'; duplicate: DuplicateResult }
  | { status: 'invalid'; issues: DraftIssue[] }

export interface WriteOptions {
  now?: Date
  /** Existing catalogue for the duplicate check; loaded from the db when omitted. */
  index?: CatalogueIndex
}

const clean = (s: string | null | undefined): string | null => {
  const t = s?.trim()
  return t ? t : null
}
const isPaise = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0

function resolveUom(d: Pick<ItemDraft, 'unit' | 'uom' | 'loose'>): UomSpec {
  if (d.uom) return d.uom
  if (d.loose && (d.unit === 'kg' || d.unit === 'litre')) return looseSpec(d.unit)
  return simpleSpec(d.unit)
}

export function validateDraft(d: ItemDraft): { issues: DraftIssue[]; uom: UomSpec | null; barcode: string | null; openingMilli: number | null } {
  const issues: DraftIssue[] = []
  const name = d.name?.trim() ?? ''
  if (!name) issues.push('name_required')
  if (name.length > 200) issues.push('name_too_long')
  let uom: UomSpec | null = null
  if (!isUnit(d.unit)) issues.push('bad_unit')
  else {
    uom = resolveUom(d)
    if (!isValidUom(uom)) {
      issues.push('bad_uom')
      uom = null
    } else if (!hasUnit(uom, d.unit)) issues.push('unit_not_in_uom')
  }
  let barcode: string | null = null
  if (clean(d.barcode)) {
    const c = classifyBarcode(d.barcode!)
    if (!c.accepted) issues.push('bad_barcode')
    else barcode = c.code
  }
  if (d.hsn && !/^\d{2,8}$/.test(d.hsn.trim())) issues.push('bad_hsn')
  if (d.taxRateBp != null && !(Number.isInteger(d.taxRateBp) && d.taxRateBp >= 0 && d.taxRateBp <= 10000)) issues.push('bad_tax_rate')
  for (const p of [d.mrpPaise, d.retailPaise]) if (p != null && !isPaise(p)) issues.push('bad_price')
  let openingMilli: number | null = null
  if (d.openingStock) {
    try {
      openingMilli = uom ? toBaseMilli(uom, d.openingStock.unit, d.openingStock.qty) : null
      if (openingMilli !== null && openingMilli <= 0) issues.push('bad_opening_stock')
    } catch (e) {
      if (e instanceof UomError) issues.push('bad_opening_stock')
      else throw e
    }
  }
  return { issues: [...new Set(issues)], uom, barcode, openingMilli }
}

async function indexOf(db: LocalDb, ctx: CatalogueContext, opts: WriteOptions): Promise<CatalogueIndex> {
  return opts.index ?? new CatalogueIndex(await loadCatalogue(db, { storeId: ctx.storeId, now: opts.now }))
}

/**
 * Adds an item in one atomic local transaction: product create (+ mrp/retail price_version + opening stock_movement),
 * with the optimistic local rows. Refuses instead of creating when the duplicate policy says so:
 * - barcode_exists (active item already has the barcode): always refused;
 * - possible_duplicate (same phonetic name + brand + size): refused unless `allowDuplicate` (the human confirmed).
 * Nothing here touches the network.
 */
export async function createItem(writer: OpLogWriter, db: LocalDb, ctx: CatalogueContext, draft: ItemDraft, opts: WriteOptions = {}): Promise<CreateResult> {
  const v = validateDraft(draft)
  if (v.issues.length > 0 || !v.uom) return { status: 'invalid', issues: v.issues }

  const index = await indexOf(db, ctx, opts)
  const dup = findDuplicates(index, { name: draft.name, brand: draft.brand, barcode: v.barcode, size: draft.size })
  if (dup.code === 'barcode_exists' || (dup.code === 'possible_duplicate' && !draft.allowDuplicate)) return { status: 'duplicate', duplicate: dup }

  const now = opts.now ?? new Date()
  const nowIso = now.toISOString()
  const id = uuidv7(now.getTime())
  const payload: ProductPayload = {
    name: draft.name.trim(),
    localName: clean(draft.localName),
    brand: clean(draft.brand),
    category: clean(draft.category),
    barcode: v.barcode,
    sku: clean(draft.sku),
    packSku: null,
    hsn: clean(draft.hsn),
    unit: draft.unit,
    uom: v.uom,
    taxInclusive: draft.taxInclusive ?? true,
    taxRateBp: draft.taxRateBp ?? null,
    loose: draft.loose ?? false,
    pinned: draft.pinned ?? false,
    active: true,
  }
  const a = ctx.actorUserId
  let barcodeRace = false
  const ops = await writer.writeAllWith(async (tx) => {
    if (v.barcode) {
      // re-check under the write lock: another tab or a sync may have added the barcode since the in-memory check
      const rows = await tx.getAll<{ id: string }>('SELECT id FROM product WHERE barcode = ? AND (active IS NULL OR active != 0) LIMIT 1', [v.barcode])
      if (rows.length > 0) {
        barcodeRace = true
        return []
      }
    }
    const items = [writeItem({ entityType: 'product', entityId: id, opType: 'create', payload, actorUserId: a }, [productInsertEffect(ctx.tenantId, id, payload, nowIso)])]
    for (const [priceType, amount] of [['mrp', draft.mrpPaise], ['retail', draft.retailPaise]] as const) {
      if (amount == null) continue
      const pid = uuidv7(now.getTime())
      const pp = { productId: id, priceType, partyId: null, amountPaise: amount, effectiveFrom: nowIso }
      items.push(writeItem({ entityType: 'price_version', entityId: pid, opType: 'create', payload: pp, actorUserId: a }, [priceVersionInsertEffect(ctx.tenantId, pid, pp)]))
    }
    if (v.openingMilli) {
      const mid = uuidv7(now.getTime())
      items.push(
        writeItem(
          { entityType: 'stock_movement', entityId: mid, opType: 'create', payload: { productId: id, qtyMilli: v.openingMilli, reason: 'opening', occurredAt: nowIso }, actorUserId: a },
          [adjustStockBalance(ctx.tenantId, ctx.storeId, id, v.openingMilli)],
        ),
      )
    }
    return items
  })
  if (barcodeRace) {
    const fresh = await loadCatalogue(db, { storeId: ctx.storeId, now })
    return { status: 'duplicate', duplicate: findDuplicates(fresh, { name: draft.name, brand: draft.brand, barcode: v.barcode }) }
  }
  const created: CatalogueItem = {
    id,
    name: draft.name.trim(),
    localName: payload.localName ?? null,
    brand: payload.brand ?? null,
    category: payload.category ?? null,
    barcode: v.barcode,
    sku: payload.sku ?? null,
    packSku: null,
    hsn: payload.hsn ?? null,
    unit: draft.unit,
    uom: v.uom,
    taxInclusive: payload.taxInclusive ?? true,
    taxRateBp: payload.taxRateBp ?? null,
    loose: payload.loose ?? false,
    pinned: payload.pinned ?? false,
    active: true,
    mrpPaise: draft.mrpPaise ?? null,
    retailPaise: draft.retailPaise ?? null,
    stockMilli: v.openingMilli,
    oversold: false,
  }
  return { status: 'created', item: created, ops }
}

export type ItemPatch = Partial<Pick<ItemDraft, 'name' | 'localName' | 'brand' | 'category' | 'barcode' | 'sku' | 'hsn' | 'unit' | 'uom' | 'taxInclusive' | 'taxRateBp' | 'loose'>> & { active?: boolean }

export type UpdateResult =
  | { status: 'updated'; item: CatalogueItem; op: WrittenOp; changed: string[] }
  | { status: 'unchanged'; item: CatalogueItem }
  | { status: 'duplicate'; duplicate: DuplicateResult }
  | { status: 'invalid'; issues: DraftIssue[] }

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** Writes ONE update op holding only the fields that really changed (field-level merge on the server is by HLC). */
export async function updateItem(writer: OpLogWriter, db: LocalDb, ctx: CatalogueContext, current: CatalogueItem, patch: ItemPatch, opts: WriteOptions = {}): Promise<UpdateResult> {
  const merged: ItemDraft = {
    name: patch.name ?? current.name,
    unit: patch.unit ?? current.unit,
    uom: patch.uom ?? current.uom,
    loose: patch.loose ?? current.loose,
    barcode: patch.barcode === undefined ? current.barcode : patch.barcode,
    hsn: patch.hsn === undefined ? current.hsn : patch.hsn,
    taxRateBp: patch.taxRateBp === undefined ? current.taxRateBp : patch.taxRateBp,
  }
  const v = validateDraft(merged)
  if (v.issues.length > 0 || !v.uom) return { status: 'invalid', issues: v.issues }

  const diff: ProductPayload = {}
  const set = <K extends keyof ProductPayload>(key: K, value: ProductPayload[K], before: unknown) => {
    if (!same(value, before)) (diff as Record<string, unknown>)[key] = value
  }
  if (patch.name !== undefined) set('name', patch.name.trim(), current.name)
  if (patch.localName !== undefined) set('localName', clean(patch.localName), current.localName)
  if (patch.brand !== undefined) set('brand', clean(patch.brand), current.brand)
  if (patch.category !== undefined) set('category', clean(patch.category), current.category)
  if (patch.barcode !== undefined) set('barcode', v.barcode, current.barcode)
  if (patch.sku !== undefined) set('sku', clean(patch.sku), current.sku)
  if (patch.hsn !== undefined) set('hsn', clean(patch.hsn), current.hsn)
  if (patch.unit !== undefined) set('unit', patch.unit, current.unit)
  if (patch.uom !== undefined) set('uom', v.uom, current.uom)
  if (patch.taxInclusive !== undefined) set('taxInclusive', patch.taxInclusive, current.taxInclusive)
  if (patch.taxRateBp !== undefined) set('taxRateBp', patch.taxRateBp, current.taxRateBp)
  if (patch.loose !== undefined) set('loose', patch.loose, current.loose)
  if (patch.active !== undefined) set('active', patch.active, current.active)
  const changed = Object.keys(diff)
  if (changed.length === 0) return { status: 'unchanged', item: current }

  if (diff.barcode || diff.name !== undefined) {
    const index = await indexOf(db, ctx, opts)
    const dup = findDuplicates(index, { name: patch.name ?? current.name, brand: patch.brand ?? current.brand, barcode: diff.barcode ?? null }, { excludeId: current.id })
    if (dup.code === 'barcode_exists') return { status: 'duplicate', duplicate: dup }
  }
  const nowIso = (opts.now ?? new Date()).toISOString()
  const op = await writer.write({ entityType: 'product', entityId: current.id, opType: 'update', payload: diff, actorUserId: ctx.actorUserId }, [productUpdateEffect(current.id, diff, nowIso)])
  const next: CatalogueItem = { ...current }
  const target = next as unknown as Record<string, unknown>
  for (const [k, val] of Object.entries(diff)) target[k] = val
  return { status: 'updated', item: next, op, changed }
}

/** A new price_version effective now (or `effectiveFrom`); price history is append-only, nothing is edited. Paise per BASE unit. */
export async function setPrice(
  writer: OpLogWriter,
  ctx: CatalogueContext,
  productId: string,
  priceType: PriceType,
  amountPaise: number,
  opts: { effectiveFrom?: Date; partyId?: string | null } = {},
): Promise<WrittenOp> {
  if (!isPaise(amountPaise)) throw new RangeError('amountPaise must be a non-negative safe integer')
  const id = uuidv7()
  const payload = { productId, priceType, partyId: opts.partyId ?? null, amountPaise, effectiveFrom: (opts.effectiveFrom ?? new Date()).toISOString() }
  return writer.write({ entityType: 'price_version', entityId: id, opType: 'create', payload, actorUserId: ctx.actorUserId }, [priceVersionInsertEffect(ctx.tenantId, id, payload)])
}

export async function pinItem(writer: OpLogWriter, ctx: CatalogueContext, productId: string, pinned: boolean): Promise<WrittenOp> {
  const payload: ProductPayload = { pinned }
  return writer.write({ entityType: 'product', entityId: productId, opType: 'update', payload, actorUserId: ctx.actorUserId }, [productUpdateEffect(productId, payload, new Date().toISOString())])
}

/**
 * "Stock came in": a positive stock_movement with reason 'adjustment'. StockMovementPayload has no note field and a
 * purchase document (supplier, bill, cost) is a later session, so reason 'purchase' is NOT used here. The first
 * count of an item is entered at creation as reason 'opening'.
 */
export async function stockIn(
  writer: OpLogWriter,
  ctx: CatalogueContext,
  product: Pick<CatalogueItem, 'id' | 'uom'>,
  qty: string | number,
  unit: Unit,
  opts: { now?: Date } = {},
): Promise<WrittenOp & { qtyMilli: number }> {
  const qtyMilli = toBaseMilli(product.uom, unit, qty)
  if (qtyMilli <= 0) throw new RangeError('quantity must be positive')
  const id = uuidv7()
  const op = await writer.write(
    { entityType: 'stock_movement', entityId: id, opType: 'create', payload: { productId: product.id, qtyMilli, reason: 'adjustment', occurredAt: (opts.now ?? new Date()).toISOString() }, actorUserId: ctx.actorUserId },
    [adjustStockBalance(ctx.tenantId, ctx.storeId, product.id, qtyMilli)],
  )
  return { ...op, qtyMilli }
}
