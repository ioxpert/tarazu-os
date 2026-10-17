import { describe, expect, it } from 'vitest'
import { OpLogWriter } from '../sync/oplog'
import { makeSchemaDb } from '../sync/schemaDb'
import { loadCatalogue } from './repo'
import { KEY_STARTER_PACK, seedStarterPack, type SeedProgress } from './seed'
import { loadStarterPack } from './starterPack'
import { isValidUom } from './uom'

const IDENT = { deviceId: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d', storeId: '11111111-1111-4111-8111-111111111111' }
const CTX = { tenantId: '99999999-9999-4999-8999-999999999999', storeId: IDENT.storeId, deviceId: IDENT.deviceId, actorUserId: null }
const NOW = new Date('2026-10-17T10:00:00.000Z')
const UNITS = new Set(['piece', 'packet', 'strip', 'bottle', 'dozen', 'kg', 'g', 'litre', 'ml', 'bag', 'box', 'case', 'carton', 'bundle'])

async function setup() {
  const { sqlite, db } = await makeSchemaDb()
  const writer = new OpLogWriter(db, IDENT, () => NOW.getTime())
  return { sqlite, db, writer }
}
const count = (sqlite: { prepare(s: string): { all(): unknown[] } }, sql: string) => (sqlite.prepare(sql).all()[0] as { n: number }).n

describe('seedStarterPack', () => {
  it('seeds the real grocery pack: products, mrp+retail prices, no stock, valid op payloads', async () => {
    const { sqlite, db, writer } = await setup()
    const pack = await loadStarterPack('grocery')
    const progress: SeedProgress[] = []
    const t0 = performance.now()
    const res = await seedStarterPack(writer, db, CTX, 'grocery', (p) => progress.push(p), { now: NOW })
    const ms = performance.now() - t0
    console.log(`[seed] ${pack.items.length} items in ${ms.toFixed(0)} ms (${count(sqlite, 'SELECT count(*) n FROM op_log')} ops)`)

    expect(res).toEqual({ total: pack.items.length, created: pack.items.length, skipped: 0 })
    const loose = pack.items.filter((i) => i.loose).length
    expect(count(sqlite, 'SELECT count(*) n FROM product')).toBe(pack.items.length)
    expect(count(sqlite, "SELECT count(*) n FROM price_version WHERE price_type = 'mrp'")).toBe(pack.items.length - loose)
    expect(count(sqlite, "SELECT count(*) n FROM price_version WHERE price_type = 'retail'")).toBe(pack.items.length)
    expect(count(sqlite, 'SELECT count(*) n FROM op_log')).toBe(pack.items.length * 2 + (pack.items.length - loose))
    expect(count(sqlite, "SELECT count(*) n FROM op_log WHERE entity_type = 'stock_movement'")).toBe(0)
    expect(count(sqlite, 'SELECT count(*) n FROM stock_balance')).toBe(0)
    expect(progress[0]).toEqual({ done: 0, total: pack.items.length })
    expect(progress.at(-1)).toEqual({ done: pack.items.length, total: pack.items.length })

    // payloads are what the server accepts
    const ops = sqlite.prepare('SELECT entity_type, entity_id, op_type, payload, local_seq FROM op_log ORDER BY local_seq').all() as Array<{ entity_type: string; entity_id: string; op_type: string; payload: string; local_seq: number }>
    const entityIds = new Set<string>()
    for (const op of ops) {
      expect(op.op_type).toBe('create')
      expect(entityIds.has(op.entity_id)).toBe(false)
      entityIds.add(op.entity_id)
      const p = JSON.parse(op.payload)
      if (op.entity_type === 'product') {
        expect(typeof p.name === 'string' && p.name.length > 0).toBe(true)
        expect(UNITS.has(p.unit)).toBe(true)
        expect(isValidUom(p.uom)).toBe(true)
        expect(p.packSku).toMatch(/^GRO-\d{4}$/)
        expect(p.taxRateBp).toBeGreaterThanOrEqual(0)
      } else {
        expect(op.entity_type).toBe('price_version')
        expect(['mrp', 'retail']).toContain(p.priceType)
        expect(Number.isSafeInteger(p.amountPaise) && p.amountPaise > 0).toBe(true)
        expect(p.effectiveFrom).toBe(NOW.toISOString())
        expect(entityIds.has(p.productId)).toBe(true) // the product op comes first
      }
    }

    // read model: items load with prices and null stock
    const items = await loadCatalogue(db, { storeId: IDENT.storeId, now: new Date(NOW.getTime() + 1000) })
    expect(items).toHaveLength(pack.items.length)
    const parle = items.find((i) => i.name === 'Parle-G Biscuit 56 g')!
    expect(parle).toMatchObject({ mrpPaise: 500, retailPaise: 500, stockMilli: null, packSku: expect.stringMatching(/^GRO-/), unit: 'packet', loose: false, active: true })
    const rice = items.find((i) => i.loose)!
    expect(rice.mrpPaise).toBeNull()
    expect(rice.retailPaise).toBeGreaterThan(0)

    const state = JSON.parse((sqlite.prepare("SELECT value FROM device_state WHERE id = ?").all(KEY_STARTER_PACK)[0] as { value: string }).value)
    expect(state).toEqual({ type: 'grocery', version: pack.version, seededAt: NOW.toISOString() })
    expect(ms).toBeLessThan(5000)
  })

  it('500 items seed in < 5 s', async () => {
    const { db, writer } = await setup()
    const pack = await loadStarterPack('grocery')
    const t0 = performance.now()
    const res = await seedStarterPack(writer, db, CTX, 'grocery', undefined, { pack: { ...pack, items: pack.items.slice(0, 500) }, now: NOW })
    const ms = performance.now() - t0
    console.log(`[seed] 500 items in ${ms.toFixed(0)} ms`)
    expect(res.created).toBe(500)
    expect(ms).toBeLessThan(5000)
  })

  it('is idempotent: a re-run creates nothing; a partial seed is completed', async () => {
    const { sqlite, db, writer } = await setup()
    const pack = await loadStarterPack('general')
    const half = { ...pack, items: pack.items.slice(0, 50) }
    await seedStarterPack(writer, db, CTX, 'general', undefined, { pack: half, now: NOW })
    const opsAfterHalf = count(sqlite, 'SELECT count(*) n FROM op_log')
    const again = await seedStarterPack(writer, db, CTX, 'general', undefined, { pack: half, now: NOW })
    expect(again).toEqual({ total: 50, created: 0, skipped: 50 })
    expect(count(sqlite, 'SELECT count(*) n FROM op_log')).toBe(opsAfterHalf)

    const full = await seedStarterPack(writer, db, CTX, 'general', undefined, { pack, now: NOW })
    expect(full.created).toBe(pack.items.length - 50)
    expect(count(sqlite, 'SELECT count(*) n FROM product')).toBe(pack.items.length)
    const last = await seedStarterPack(writer, db, CTX, 'general', undefined, { now: NOW })
    expect(last.created).toBe(0)
    expect(count(sqlite, 'SELECT count(DISTINCT id) n FROM product')).toBe(pack.items.length)
  })

  it('chunks are atomic: a failing chunk leaves earlier chunks and no half-written items', async () => {
    const { sqlite, db, writer } = await setup()
    const pack = await loadStarterPack('general')
    const items = pack.items.slice(0, 30)
    // a poisoned third chunk: name that makes the INSERT fail (NOT NULL is not enforced, so throw from the payload getter)
    const poison = { ...items[25], get name(): string { throw new Error('boom') } }
    const broken = { ...pack, items: [...items.slice(0, 25), poison, ...items.slice(26)] }
    await expect(seedStarterPack(writer, db, CTX, 'general', undefined, { pack: broken, now: NOW, chunkSize: 10 })).rejects.toThrow('boom')
    expect(count(sqlite, 'SELECT count(*) n FROM product')).toBe(20)
    expect(count(sqlite, "SELECT count(*) n FROM device_state WHERE id = 'starter_pack'")).toBe(0)
    const retry = await seedStarterPack(writer, db, CTX, 'general', undefined, { pack: { ...pack, items }, now: NOW, chunkSize: 10 })
    expect(retry.created).toBe(10)
    expect(count(sqlite, 'SELECT count(*) n FROM product')).toBe(30)
  })

  it('the two packs never collide when seeded into one device', async () => {
    const { sqlite, db, writer } = await setup()
    await seedStarterPack(writer, db, CTX, 'grocery', undefined, { now: NOW })
    await seedStarterPack(writer, db, CTX, 'general', undefined, { now: NOW })
    const g = (await loadStarterPack('grocery')).items.length
    const n = (await loadStarterPack('general')).items.length
    expect(count(sqlite, 'SELECT count(*) n FROM product')).toBe(g + n)
  })
})
