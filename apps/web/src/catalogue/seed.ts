import type { components } from '../api/schema'
import { item, type OpLogWriter } from '../sync/oplog'
import type { LocalDb } from '../sync/schemaDb'
import type { CatalogueContext } from './context'
import { priceVersionInsertEffect, productInsertEffect } from './localEffects'
import { loadStarterPack } from './starterPack'
import { starterPriceId, starterProductId } from './starterPack/ids'
import type { StarterItem, StarterPackFile, StoreType } from './starterPack/types'

type ProductPayload = components['schemas']['ProductPayload']

export const KEY_STARTER_PACK = 'starter_pack'

export interface SeedProgress {
  done: number
  total: number
}

export interface SeedOptions {
  /** Test seam: use this pack instead of lazy-loading the bundled one. */
  pack?: StarterPackFile
  now?: Date
  /** Items per transaction (default 200). Each chunk is atomic; a re-run skips what already exists. */
  chunkSize?: number
}

export interface SeedResult {
  total: number
  created: number
  skipped: number
}

export function starterProductPayload(it: StarterItem): ProductPayload {
  return {
    name: it.name,
    localName: it.localName,
    brand: it.brand,
    category: it.category,
    packSku: it.packSku,
    hsn: it.hsn,
    unit: it.unit,
    uom: it.uom,
    taxInclusive: it.taxInclusive,
    taxRateBp: it.indicativeTaxRateBp,
    loose: it.loose,
    pinned: false,
    active: true,
  }
}

/**
 * Seeds the bundled catalogue for a store type: a product create op per item, an `mrp` price_version (packaged goods)
 * and a `retail` price_version equal to it (loose goods get only `retail`: there is no printed MRP on a loose item),
 * all effective now, plus the optimistic local rows, in a few atomic chunks. Never creates stock (it starts unknown).
 *
 * Idempotent: product ids derive from (storeType, packSku), items whose id already exists locally are skipped, and
 * device_state `starter_pack` {type, version, seededAt} is written in the same transaction as the last chunk.
 */
export async function seedStarterPack(
  writer: OpLogWriter,
  db: LocalDb,
  ctx: CatalogueContext,
  storeType: StoreType,
  onProgress?: (p: SeedProgress) => void,
  opts: SeedOptions = {},
): Promise<SeedResult> {
  const pack = opts.pack ?? (await loadStarterPack(storeType))
  const now = opts.now ?? new Date()
  const nowIso = now.toISOString()
  const chunkSize = opts.chunkSize ?? 200
  const existing = new Set((await db.getAll<{ id: string }>('SELECT id FROM product')).map((r) => r.id))
  const todo = pack.items.filter((it) => !existing.has(starterProductId(storeType, it.packSku)))
  const total = pack.items.length
  let created = 0
  let stateWritten = false
  const stateValue = JSON.stringify({ type: storeType, version: pack.version, seededAt: nowIso })
  const stateEffect = { sql: 'INSERT OR REPLACE INTO device_state (id, value) VALUES (?, ?)', params: [KEY_STARTER_PACK, stateValue] }

  onProgress?.({ done: total - todo.length, total })
  for (let i = 0; i < todo.length; i += chunkSize) {
    const chunk = todo.slice(i, i + chunkSize)
    const last = i + chunkSize >= todo.length
    await writer.writeAllWith(async (tx) => {
      // re-check inside the transaction: a concurrent seed (two tabs) must not double-create
      const have = new Set((await tx.getAll<{ id: string }>('SELECT id FROM product')).map((r) => r.id))
      const items = chunk.flatMap((it) => {
        const id = starterProductId(storeType, it.packSku)
        if (have.has(id)) return []
        const out = [
          item({ entityType: 'product', entityId: id, opType: 'create', payload: starterProductPayload(it), actorUserId: ctx.actorUserId }, [
            productInsertEffect(ctx.tenantId, id, starterProductPayload(it), nowIso),
          ]),
        ]
        const prices: Array<'mrp' | 'retail'> = it.loose ? ['retail'] : ['mrp', 'retail']
        for (const priceType of prices) {
          const priceId = starterPriceId(storeType, it.packSku, priceType)
          const payload = { productId: id, priceType, partyId: null, amountPaise: it.mrpPaise, effectiveFrom: nowIso }
          out.push(
            item({ entityType: 'price_version', entityId: priceId, opType: 'create', payload, actorUserId: ctx.actorUserId }, [
              priceVersionInsertEffect(ctx.tenantId, priceId, payload),
            ]),
          )
        }
        return out
      })
      if (last && items.length > 0) {
        items[items.length - 1].effects = [...(items[items.length - 1].effects ?? []), stateEffect]
        stateWritten = true
      }
      created += items.filter((x) => x.op.entityType === 'product').length
      return items
    })
    onProgress?.({ done: total - todo.length + Math.min(i + chunkSize, todo.length), total })
  }
  if (!stateWritten) await db.execute(stateEffect.sql, stateEffect.params)
  return { total, created, skipped: total - created }
}
