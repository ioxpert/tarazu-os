import { classifyBarcode } from './barcode'
import { loadItemsByBarcode } from './repo'
import { CATEGORY_TILES } from './starterPack/categories'
import { loadSyncConfig, type SyncConfig } from '../sync/config'
import type { LocalDb } from '../sync/schemaDb'
import type { CatalogueItem, UomSpec, Unit } from './types'
import { isUnit, isValidUom, simpleSpec } from './uom'

/** Pre-fill for the add-item form, from the platform product master. Every field stays editable. */
export interface ItemPrefill {
  barcode: string
  name: string
  localName: string | null
  brand: string | null
  category: string | null
  hsn: string | null
  mrpPaise: number | null
  unit: Unit
  uom: UomSpec
}

export type LookupResult =
  | { source: 'local'; item: CatalogueItem }
  | { source: 'master'; draft: ItemPrefill }
  | { source: 'none' }
  | { source: 'offline'; reason: 'timeout' | 'network' | 'server_error' | 'unauthorized' | 'no_config' | 'bad_response' }

export interface LookupOptions {
  storeId: string
  timeoutMs?: number
  config?: Pick<SyncConfig, 'apiBase' | 'deviceToken'> | null
}

const MASTER_PATTERN = /^[0-9]{6,14}$/

function mapCategory(raw: string | null | undefined): string | null {
  if (!raw) return null
  const t = raw.trim().toLowerCase()
  const hit = CATEGORY_TILES.find((c) => c.id === t || c.en.toLowerCase() === t)
  return hit ? hit.id : null
}

export function prefillFromMaster(barcode: string, m: Record<string, unknown>): ItemPrefill | null {
  if (typeof m.name !== 'string' || !m.name.trim()) return null
  const unit: Unit = isUnit(m.unit) ? m.unit : 'piece'
  const uom = isValidUom(m.uom) ? m.uom : simpleSpec(unit)
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  return {
    barcode,
    name: m.name.trim(),
    localName: str(m.localName),
    brand: str(m.brand),
    category: mapCategory(str(m.category)),
    hsn: str(m.hsn),
    mrpPaise: typeof m.mrpPaise === 'number' && Number.isSafeInteger(m.mrpPaise) && m.mrpPaise >= 0 ? m.mrpPaise : null,
    unit: uom.base === unit || uom.units.some((u) => u.unit === unit) ? unit : uom.base,
    uom,
  }
}

/**
 * Scanned a barcode: this device's catalogue first (no network), else the platform master. Only the barcode leaves
 * the device (path parameter + the device bearer token); no store, item or customer data is sent. Never throws:
 * a slow or absent network returns { source: 'offline' } within `timeoutMs` (default 1500) so the add-item form can
 * open empty immediately.
 */
export async function lookupBarcode(db: LocalDb, barcode: string, fetchImpl: typeof fetch, opts: LookupOptions): Promise<LookupResult> {
  const info = classifyBarcode(barcode)
  if (!info.accepted) return { source: 'none' }
  try {
    const local = await loadItemsByBarcode(db, { storeId: opts.storeId }, info.code)
    if (local.length > 0) return { source: 'local', item: local[0] }
  } catch {
    // a broken local read must not block adding the item: fall through to the master
  }
  if (!MASTER_PATTERN.test(info.code)) return { source: 'none' }
  const config = opts.config === undefined ? loadSyncConfig() : opts.config
  if (!config) return { source: 'offline', reason: 'no_config' }

  const timeoutMs = opts.timeoutMs ?? 1500
  const ctl = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<LookupResult>((resolve) => {
    timer = setTimeout(() => {
      ctl.abort()
      resolve({ source: 'offline', reason: 'timeout' })
    }, timeoutMs)
  })
  const request = (async (): Promise<LookupResult> => {
    try {
      const res = await fetchImpl(`${config.apiBase}/v1/catalogue/master/${info.code}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${config.deviceToken}`, Accept: 'application/json' },
        credentials: 'omit',
        cache: 'no-store',
        signal: ctl.signal,
      })
      if (res.status === 404) return { source: 'none' }
      if (res.status === 401 || res.status === 403) return { source: 'offline', reason: 'unauthorized' }
      if (!res.ok) return { source: 'offline', reason: 'server_error' }
      const body = (await res.json()) as Record<string, unknown>
      const draft = prefillFromMaster(info.code, body)
      return draft ? { source: 'master', draft } : { source: 'offline', reason: 'bad_response' }
    } catch {
      return { source: 'offline', reason: ctl.signal.aborted ? 'timeout' : 'network' }
    }
  })()
  try {
    return await Promise.race([request, timeout])
  } finally {
    clearTimeout(timer)
  }
}
