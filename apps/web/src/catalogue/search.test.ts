import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { CatalogueIndex, withinOneEdit } from './search'
import { mkItem, syntheticCatalogue } from './testkit'

const ITEMS = [
  mkItem({ id: 'parle-g', name: 'Parle-G Biscuit 56 g', localName: 'पारले-जी बिस्कुट 56 ग्राम', brand: 'Parle', category: 'biscuits', barcode: '8901719101236' }),
  mkItem({ id: 'parle-g-100', name: 'Parle-G Biscuit 100 g', localName: 'पारले-जी बिस्कुट 100 ग्राम', brand: 'Parle', category: 'biscuits' }),
  mkItem({ id: 'parle-gold', name: 'Parle-G Gold Biscuit 100 g', localName: 'पारले-जी गोल्ड बिस्कुट', brand: 'Parle', category: 'biscuits' }),
  mkItem({ id: 'monaco', name: 'Parle Monaco Biscuit 75 g', localName: 'पारले मोनैको', brand: 'Parle', category: 'biscuits' }),
  mkItem({ id: 'maggi', name: 'Maggi 2-Minute Noodles Masala 70 g', localName: 'मैगी 2-मिनट नूडल्स मसाला 70 ग्राम', brand: 'Maggi', category: 'packaged-food' }),
  mkItem({ id: 'maggi-atta', name: 'Maggi Atta Noodles 72 g', localName: 'मैगी आटा नूडल्स', brand: 'Maggi', category: 'packaged-food' }),
  mkItem({ id: 'tata-salt', name: 'Tata Salt 1 kg', localName: 'टाटा नमक 1 किलो', brand: 'Tata', category: 'sugar-salt', sku: 'TS-1KG' }),
  mkItem({ id: 'tata-tea', name: 'Tata Tea Gold 250 g', localName: 'टाटा टी गोल्ड', brand: 'Tata', category: 'tea-coffee' }),
  mkItem({ id: 'amul-500', name: 'Amul Butter 500 g', localName: 'अमूल बटर 500 ग्राम', brand: 'Amul', category: 'dairy' }),
  mkItem({ id: 'amul-100', name: 'Amul Butter 100 g', localName: 'अमूल बटर 100 ग्राम', brand: 'Amul', category: 'dairy' }),
  mkItem({ id: 'amul-cheese', name: 'Amul Cheese Slices 200 g', localName: 'अमूल चीज़ स्लाइस', brand: 'Amul', category: 'dairy' }),
  mkItem({ id: 'inactive', name: 'Parle-G Old Pack 40 g', brand: 'Parle', category: 'biscuits', active: false }),
]

describe('CatalogueIndex examples', () => {
  const idx = new CatalogueIndex(ITEMS)
  it.each(['parle g', 'parley gee', 'पारले जी', 'Parle-G', 'parle jee', 'पारले जी बिस्कुट'])('%s -> Parle-G first', (q) => {
    const r = idx.search(q)
    expect(r[0].brand).toBe('Parle')
    expect(r[0].name.startsWith('Parle-G Biscuit')).toBe(true)
  })
  it.each(['maggi', 'magi', 'मैगी', 'maggie', 'Maggi noodles'])('%s -> Maggi', (q) => {
    expect(idx.search(q)[0].brand).toBe('Maggi')
  })
  it.each(['tata salt', 'tata namak', 'टाटा नमक', 'tata nmak'])('%s -> Tata Salt first', (q) => {
    expect(idx.search(q)[0].id).toBe('tata-salt')
  })
  it('amul butter 500 puts the 500 g pack first and finds the 100 g too', () => {
    const r = idx.search('amul butter 500').map((i) => i.id)
    expect(r[0]).toBe('amul-500')
    expect(idx.search('amul butter').map((i) => i.id).slice(0, 2).sort()).toEqual(['amul-100', 'amul-500'])
  })
  it('exact barcode and sku first, equivalent UPC/EAN spellings', () => {
    expect(idx.search('8901719101236')[0].id).toBe('parle-g')
    expect(idx.search(' 8901719101236\n')[0].id).toBe('parle-g')
    expect(idx.search('ts-1kg')[0].id).toBe('tata-salt')
    expect(idx.byBarcode('08901719101236').map((i) => i.id)).toEqual(['parle-g'])
  })
  it('token prefix and edit-distance-1 fuzzy (tokens of 4+ chars)', () => {
    expect(idx.search('parl')[0].brand).toBe('Parle')
    expect(idx.search('tata sa')[0].id).toBe('tata-salt')
    expect(idx.search('bttr')).toEqual([])
    expect(idx.search('buter')[0].name).toContain('Butter')
    expect(idx.search('mxnxco')).toEqual([])
    expect(idx.search('monaco')[0].id).toBe('monaco')
    expect(idx.search('monako')[0].id).toBe('monaco')
  })
  it('all tokens must match, filters by category and hides inactive items', () => {
    expect(idx.search('parle qwertyx')).toEqual([])
    expect(idx.search('tata', { categoryId: 'sugar-salt' }).map((i) => i.id)).toEqual(['tata-salt'])
    expect(idx.search('old pack')).toEqual([])
    expect(idx.search('old pack', { includeInactive: true }).map((i) => i.id)).toEqual(['inactive'])
  })
  it('popularity and pinned boost ranking; ties are stable', () => {
    expect(idx.search('parle', { popularity: { monaco: 500 } })[0].id).toBe('monaco')
    const pinned = new CatalogueIndex([...ITEMS.slice(0, 3), { ...ITEMS[3], pinned: true }])
    expect(pinned.search('parle')[0].id).toBe('monaco')
    const a = idx.search('parle').map((i) => i.id)
    expect(idx.search('parle').map((i) => i.id)).toEqual(a)
    // equal-scoring twins keep insertion order
    const twins = new CatalogueIndex([mkItem({ id: 'b', name: 'Foo Bar' }), mkItem({ id: 'a', name: 'Foo Bar' })])
    expect(twins.search('foo bar').map((i) => i.id)).toEqual(['b', 'a'])
  })
  it('empty query lists pinned then popular', () => {
    const p = new CatalogueIndex([ITEMS[0], { ...ITEMS[1], pinned: true }, ITEMS[2]])
    p.setPopularity(new Map([['parle-gold', 9]]))
    expect(p.search('').map((i) => i.id)).toEqual(['parle-g-100', 'parle-gold'])
  })
  it('limit is honoured', () => {
    expect(idx.search('parle', { limit: 2 })).toHaveLength(2)
  })
})

describe('incremental updates', () => {
  it('upsert adds, changes and removes without a rebuild', () => {
    const idx = new CatalogueIndex()
    idx.upsert(mkItem({ id: '1', name: 'Dettol Soap 75 g' }))
    expect(idx.search('dettol')).toHaveLength(1)
    idx.upsert(mkItem({ id: '1', name: 'Dettol Liquid Handwash 200 ml' }))
    expect(idx.search('soap')).toEqual([])
    expect(idx.search('handwash')).toHaveLength(1)
    idx.upsert(mkItem({ id: '2', name: 'Dettol Antiseptic 100 ml' }))
    expect(idx.search('dettol')).toHaveLength(2)
    idx.remove('1')
    expect(idx.search('dettol').map((i) => i.id)).toEqual(['2'])
    expect(idx.search('handwash')).toEqual([])
    idx.remove('2')
    idx.remove('nope')
    expect(idx.size).toBe(0)
    expect(idx.search('dettol')).toEqual([])
  })
  it('a stock-only change keeps the position and the new object', () => {
    const idx = new CatalogueIndex([mkItem({ id: 'a', name: 'Foo' }), mkItem({ id: 'b', name: 'Foo' })])
    idx.upsert(mkItem({ id: 'a', name: 'Foo', stockMilli: 5000 }))
    const r = idx.search('foo')
    expect(r.map((i) => i.id)).toEqual(['a', 'b'])
    expect(r[0].stockMilli).toBe(5000)
  })
  it('index state equals a fresh build after random upserts/removes (property)', () => {
    const pool = syntheticCatalogue(40, 3)
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.boolean(), fc.integer({ min: 0, max: 39 })), { maxLength: 60 }), fc.constantFrom('tata', 'amul butter', 'biscuit', 'masala', 'gold'), (ops, q) => {
        const live = new CatalogueIndex()
        const model = new Map<string, (typeof pool)[number]>()
        for (const [add, i] of ops) {
          if (add) {
            live.upsert(pool[i])
            model.set(pool[i].id, pool[i])
          } else {
            live.remove(pool[i].id)
            model.delete(pool[i].id)
          }
        }
        const fresh = new CatalogueIndex([...model.values()])
        const ids = (x: CatalogueIndex) => x.search(q, { limit: 100 }).map((i) => i.id).sort()
        expect(ids(live)).toEqual(ids(fresh))
        expect(live.size).toBe(model.size)
      }),
      { numRuns: 60 },
    )
  })
})

describe('withinOneEdit', () => {
  it('matches a brute-force edit distance <= 1 (property)', () => {
    const brute = (a: string, b: string) => {
      if (a === b) return true
      for (let i = 0; i <= a.length; i++) {
        for (const c of 'abc') {
          if (a.slice(0, i) + c + a.slice(i) === b) return true
          if (i < a.length && a.slice(0, i) + c + a.slice(i + 1) === b) return true
        }
        if (i < a.length && a.slice(0, i) + a.slice(i + 1) === b) return true
        if (i + 1 < a.length && a.slice(0, i) + a[i + 1] + a[i] + a.slice(i + 2) === b) return true
      }
      return false
    }
    fc.assert(fc.property(fc.stringMatching(/^[abc]{0,6}$/), fc.stringMatching(/^[abc]{0,6}$/), (a, b) => withinOneEdit(a, b) === brute(a, b)))
  })
})

function p95(samples: number[]): number {
  const s = [...samples].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]
}

describe('performance', () => {
  const queries = ['parle g', 'पारले जी', 'tata sal', 'amul butter 500', 'maggi', 'magi', 'colgate', 'surf excel 1', 'biscut', 'a', 'gold', 'dettol soap', 'masla', 'क']
  for (const [n, assertMs] of [[5000, 100], [20000, null]] as const) {
    it(`search P95 on ${n} items`, () => {
      const items = syntheticCatalogue(n)
      const t0 = performance.now()
      const idx = new CatalogueIndex(items)
      const build = performance.now() - t0
      const times: number[] = []
      for (let round = 0; round < 20; round++) {
        for (const q of queries) {
          const t = performance.now()
          idx.search(q, { limit: 30 })
          times.push(performance.now() - t)
        }
      }
      const p = p95(times)
      console.log(`[perf] ${n} items: build ${build.toFixed(0)} ms, search P95 ${p.toFixed(2)} ms, max ${Math.max(...times).toFixed(2)} ms`)
      if (assertMs) expect(p).toBeLessThan(assertMs)
      else expect(p).toBeLessThan(500)
    })
  }
})
