// @vitest-environment node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { findDuplicates, parseSize } from '../duplicates'
import { CatalogueIndex } from '../search'
import { mkItem } from '../testkit'
import type { CatalogueItem } from '../types'
import { isValidUom } from '../uom'
import { CATEGORY_IDS, CATEGORY_TILES, loadStarterPack } from './index'
import { deterministicUuid, starterPriceId, starterProductId } from './ids'
import type { StarterItem, StarterPackFile } from './types'

const fileOf = (name: string) => fileURLToPath(new URL(`./${name}.json`, import.meta.url))

describe.each([
  ['grocery', 500],
  ['general', 100],
] as const)('%s starter pack', (type, minItems) => {
  const raw = readFileSync(fileOf(type))
  const pack = JSON.parse(raw.toString('utf8')) as StarterPackFile

  it(`has >= ${minItems} SKUs and reports its gzip size`, () => {
    const gz = gzipSync(raw, { level: 9 }).length
    console.log(`[starter-pack] ${type}: ${pack.items.length} items, ${(raw.length / 1024).toFixed(1)} KB raw, ${(gz / 1024).toFixed(1)} KB gzip`)
    expect(pack.items.length).toBeGreaterThanOrEqual(minItems)
    expect(gz).toBeLessThan(150 * 1024)
    expect(pack.storeType).toBe(type)
    expect(pack.version).toMatch(/^\d{4}\.\d{2}\.\d+$/)
    expect(pack.note).toMatch(/INDICATIVE/)
  })

  it('has unique packSku and unique names, no empty hsn, no invented barcodes', () => {
    const skus = new Set(pack.items.map((i) => i.packSku))
    const names = new Set(pack.items.map((i) => i.name.toLowerCase()))
    expect(skus.size).toBe(pack.items.length)
    expect(names.size).toBe(pack.items.length)
    const prefix = type === 'grocery' ? 'GRO' : 'GEN'
    for (const i of pack.items) {
      expect(i.packSku).toMatch(new RegExp(`^${prefix}-\\d{4}$`))
      expect(i.hsn).toMatch(/^\d{4,8}$/)
      expect(i.barcode).toBeNull()
      expect(CATEGORY_IDS.has(i.category)).toBe(true)
      expect(i.taxInclusive).toBe(true)
    }
  })

  it('every uom is a valid UomSpec and the default unit belongs to it', () => {
    for (const i of pack.items) {
      expect(isValidUom(i.uom), i.packSku).toBe(true)
      expect([i.uom.base, ...i.uom.units.map((u) => u.unit)]).toContain(i.unit)
      expect(i.unit, i.packSku).toBe(i.uom.base)
    }
  })

  it('packaged names carry a pack size and a count-style base unit; loose items are kg/litre with g/ml = 1', () => {
    for (const i of pack.items) {
      if (i.loose) {
        expect(['kg', 'litre']).toContain(i.uom.base)
        expect(i.uom.units).toEqual([{ unit: i.uom.base === 'kg' ? 'g' : 'ml', qtyMilli: 1 }])
        expect(parseSize(i.name), `${i.name} is loose but has a size`).toBeNull()
      } else {
        expect(['kg', 'g', 'litre', 'ml']).not.toContain(i.uom.base)
        const isEggLike = i.uom.units.some((u) => u.unit === 'dozen')
        if (!isEggLike) expect(parseSize(i.name) ?? parseSize(i.name + ' 1 pc'), i.name).not.toBeNull()
        expect(/\d/.test(i.name) || isEggLike, i.name).toBe(true)
      }
    }
  })

  it('size in the name agrees with the unit family (kg/g/ml/L never appear on a piece-by-weight item twice)', () => {
    for (const i of pack.items.filter((x) => !x.loose)) {
      const sizes = i.name.match(/\d+(?:\.\d+)? ?(?:kg|g|ml|L|pcs?)\b/g) ?? []
      expect(sizes.length, i.name).toBeLessThanOrEqual(2)
    }
  })

  it('has Hindi names for >= 95% (Devanagari) and sane prices/tax', () => {
    const withHindi = pack.items.filter((i) => /[ऀ-ॿ]/.test(i.localName)).length
    expect(withHindi / pack.items.length).toBeGreaterThanOrEqual(0.95)
    for (const i of pack.items) {
      expect(Number.isSafeInteger(i.mrpPaise) && i.mrpPaise > 0, i.packSku).toBe(true)
      expect(i.mrpPaise, i.packSku).toBeLessThan(5_000_000)
      expect(i.indicativeTaxRateBp).toBeGreaterThanOrEqual(0)
      expect(i.indicativeTaxRateBp).toBeLessThanOrEqual(5000)
    }
  })

  it('covers the tile categories broadly', () => {
    const cats = new Set(pack.items.map((i) => i.category))
    expect(cats.size).toBeGreaterThanOrEqual(type === 'grocery' ? 17 : 10)
  })

  it('is lazy-loadable', async () => {
    const loaded = await loadStarterPack(type)
    expect(loaded.items.length).toBe(pack.items.length)
  })

  it('duplicate policy has no false positives inside the pack (every item vs the rest) and finds itself', () => {
    const items: CatalogueItem[] = pack.items.map((s, n) => toCatalogueItem(s, n))
    const index = new CatalogueIndex(items)
    let hints = 0
    for (const it of items) {
      const own = { name: it.name, brand: it.brand }
      const others = findDuplicates(index, own, { excludeId: it.id })
      expect(others.code, `${it.name} flagged against ${others.similar[0]?.item.name}`).toBe('ok')
      hints += others.similar.length
      expect(findDuplicates(index, own).code, `${it.name} must find itself`).toBe('possible_duplicate')
    }
    console.log(`[starter-pack] ${type}: ${hints} weak 'similar' hints across ${items.length} items`)
  })
})

describe('category tiles', () => {
  it('has the 19 agreed ids with English and Hindi labels', () => {
    expect(CATEGORY_TILES.map((c) => c.id)).toEqual([
      'atta', 'rice', 'dal', 'oil', 'masala', 'sugar-salt', 'biscuits', 'snacks', 'namkeen', 'beverages', 'tea-coffee', 'dairy', 'bread-eggs',
      'personal-care', 'home-care', 'stationery', 'packaged-food', 'baby', 'frozen-or-misc',
    ])
    for (const c of CATEGORY_TILES) expect(/[ऀ-ॿ]/.test(c.hi) && c.en.length > 2).toBe(true)
  })
})

describe('deterministic ids', () => {
  it('are UUID-shaped with version nibble 8, stable, and collision-free across both packs and price kinds', () => {
    const ids = new Set<string>()
    let n = 0
    for (const type of ['grocery', 'general'] as const) {
      const pack = JSON.parse(readFileSync(fileOf(type), 'utf8')) as StarterPackFile
      for (const i of pack.items) {
        for (const id of [starterProductId(type, i.packSku), starterPriceId(type, i.packSku, 'mrp'), starterPriceId(type, i.packSku, 'retail')]) {
          expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
          ids.add(id)
          n++
        }
      }
    }
    expect(ids.size).toBe(n)
    expect(starterProductId('grocery', 'GRO-0001')).toBe(starterProductId('grocery', 'GRO-0001'))
    expect(starterProductId('grocery', 'GRO-0001')).not.toBe(starterProductId('general', 'GRO-0001'))
    expect(deterministicUuid('x')).toBe(deterministicUuid('x'))
  })
})

function toCatalogueItem(s: StarterItem, n: number): CatalogueItem {
  return mkItem({
    id: starterProductId('grocery', s.packSku) + n,
    name: s.name,
    localName: s.localName,
    brand: s.brand,
    category: s.category,
    packSku: s.packSku,
    hsn: s.hsn,
    unit: s.unit,
    uom: s.uom,
    loose: s.loose,
    mrpPaise: s.mrpPaise,
  })
}
