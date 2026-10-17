import type { components } from '../api/schema'
import type { LocalEffect } from '../sync/oplog'

type ProductPayload = components['schemas']['ProductPayload']
type PriceVersionPayload = components['schemas']['PriceVersionPayload']

const b = (v: boolean | undefined, dflt: boolean) => ((v ?? dflt) ? 1 : 0)

/** Optimistic local `product` row for a create op (server sync replaces it). INSERT OR REPLACE: PowerSync tables are views. */
export function productInsertEffect(tenantId: string, id: string, p: ProductPayload, nowIso: string): LocalEffect {
  return {
    sql: `INSERT OR REPLACE INTO product (id, tenant_id, name, barcode, sku, hsn, unit, local_name, brand, category, pack_sku,
            uom, tax_inclusive, tax_rate_bp, loose, pinned, active, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      id, tenantId, p.name, p.barcode ?? null, p.sku ?? null, p.hsn ?? null, p.unit ?? 'piece', p.localName ?? null,
      p.brand ?? null, p.category ?? null, p.packSku ?? null, p.uom ? JSON.stringify(p.uom) : null,
      b(p.taxInclusive, true), p.taxRateBp ?? null, b(p.loose, false), b(p.pinned, false), b(p.active, true), nowIso,
    ],
  }
}

const COLUMN: Record<string, string> = {
  name: 'name', barcode: 'barcode', sku: 'sku', hsn: 'hsn', unit: 'unit', localName: 'local_name', brand: 'brand',
  category: 'category', packSku: 'pack_sku', uom: 'uom', taxInclusive: 'tax_inclusive', taxRateBp: 'tax_rate_bp',
  loose: 'loose', pinned: 'pinned', active: 'active',
}

/** Optimistic local UPDATE for exactly the fields in an update op. */
export function productUpdateEffect(id: string, p: ProductPayload, nowIso: string): LocalEffect {
  const sets: string[] = []
  const params: unknown[] = []
  for (const [key, value] of Object.entries(p)) {
    const col = COLUMN[key]
    if (!col) continue
    sets.push(`${col} = ?`)
    params.push(key === 'uom' ? (value ? JSON.stringify(value) : null) : typeof value === 'boolean' ? (value ? 1 : 0) : value)
  }
  sets.push('updated_at = ?')
  params.push(nowIso, id)
  return { sql: `UPDATE product SET ${sets.join(', ')} WHERE id = ?`, params }
}

/**
 * Optimistic local `price_version` row. Its hlc is read back from the op just written for this entity (effects run
 * right after their op's op_log insert, in the same transaction), so "later hlc wins" holds for local rows too.
 */
export function priceVersionInsertEffect(tenantId: string, id: string, p: PriceVersionPayload): LocalEffect {
  return {
    sql: `INSERT OR REPLACE INTO price_version (id, tenant_id, product_id, party_id, price_type, amount_paise, effective_from, hlc)
          VALUES (?, ?, ?, ?, ?, ?, ?,
            (SELECT hlc FROM op_log WHERE entity_type = 'price_version' AND entity_id = ? ORDER BY local_seq DESC LIMIT 1))`,
    params: [id, tenantId, p.productId, p.partyId ?? null, p.priceType, p.amountPaise, p.effectiveFrom, id],
  }
}
