import { describe, expect, it } from 'vitest'
import { findDuplicates, parseSize } from './duplicates'
import { CatalogueIndex } from './search'
import { mkItem } from './testkit'

const items = [
  mkItem({ id: 'p56', name: 'Parle-G Biscuit 56 g', brand: 'Parle', barcode: '8901719101236', localName: 'पारले-जी बिस्कुट 56 ग्राम' }),
  mkItem({ id: 'p100', name: 'Parle-G Biscuit 100 g', brand: 'Parle' }),
  mkItem({ id: 'gold', name: 'Parle-G Gold Biscuit 100 g', brand: 'Parle' }),
  mkItem({ id: 'ts', name: 'Tata Salt 1 kg', brand: 'Tata' }),
  mkItem({ id: 'tt', name: 'Tata Tea Gold 250 g', brand: 'Tata' }),
  mkItem({ id: 'rock', name: 'Rock Salt 1 kg', brand: null }),
  mkItem({ id: 'plain', name: 'Mystery Snack', brand: null }),
  mkItem({ id: 'old', name: 'Retired Cola 600 ml', brand: 'Retro', active: false, barcode: '8901111111116' }),
]
const index = new CatalogueIndex(items)

describe('parseSize', () => {
  it.each([
    ['Parle-G Biscuit 56 g', 'g:56000'],
    ['Parle-G 56g', 'g:56000'],
    ['Parle G 56 gm', 'g:56000'],
    ['Rice 1 kg', 'g:1000000'],
    ['Rice 1000 g', 'g:1000000'],
    ['Oil 1 L', 'ml:1000000'],
    ['Oil 1000ml', 'ml:1000000'],
    ['Oil 1.5 Ltr', 'ml:1500000'],
    ['Soap 3 x 100 g', 'g:100000x3'],
    ['Pen 10 pcs', 'pc:10000'],
  ])('%s', (text, key) => expect(parseSize(text)?.key).toBe(key))
  it('does not read sizes out of plain words', () => {
    expect(parseSize('Parle-G Biscuit')).toBeNull()
    expect(parseSize('Maggi 2-Minute Noodles')).toBeNull()
    expect(parseSize('Dal 500gx')).toBeNull()
  })
})

describe('findDuplicates policy', () => {
  it('exact barcode blocks creation with barcode_exists', () => {
    const r = findDuplicates(index, { name: 'Totally different', barcode: ' 8901719101236 ' })
    expect(r.code).toBe('barcode_exists')
    expect(r.exactBarcode?.id).toBe('p56')
  })
  it('an inactive item does not block its barcode', () => {
    expect(findDuplicates(index, { name: 'Retired Cola 600 ml', barcode: '8901111111116' }).code).toBe('ok')
  })
  it('same phonetic name + brand + size is a possible_duplicate (UI asks)', () => {
    for (const name of ['parley gee biscuit 56g', 'Parle G Biscuits 56 gm', 'पारले जी बिस्कुट 56 ग्राम']) {
      const r = findDuplicates(index, { name, brand: 'Parle' })
      expect(r.code, name).toBe('possible_duplicate')
      expect(r.similar[0].item.id).toBe('p56')
      expect(r.similar[0].reason).toBe('same_name_brand_size')
    }
  })
  it('size can be given separately', () => {
    expect(findDuplicates(index, { name: 'Parle-G Biscuit', brand: 'Parle', size: '56 g' }).code).toBe('possible_duplicate')
    expect(findDuplicates(index, { name: 'Parle-G Biscuit', brand: 'Parle', size: '800 g' }).code).toBe('ok')
  })
  it('a different pack size or brand of the same product is NOT a duplicate', () => {
    expect(findDuplicates(index, { name: 'Parle-G Biscuit 200 g', brand: 'Parle' }).code).toBe('ok')
    expect(findDuplicates(index, { name: 'Parle-G Biscuit 200 g', brand: 'Parle' }).similar).toEqual([])
    expect(findDuplicates(index, { name: 'Salt 1 kg', brand: 'Catch' }).code).toBe('ok')
    expect(findDuplicates(index, { name: 'Tata Salt 1 kg', brand: 'Tata' }, { excludeId: 'ts' }).code).toBe('ok')
  })
  it('same name but size missing on one side is only a hint', () => {
    const r = findDuplicates(index, { name: 'Parle-G Biscuit', brand: 'Parle' })
    expect(r.code).toBe('ok')
    expect(r.similar.map((s) => s.reason)).toContain('same_name_size_unknown')
  })
  it('near-identical names with the same size are hints, not blockers', () => {
    const r = findDuplicates(index, { name: 'Parle-G Gold Biscuit 56 g', brand: 'Parle' })
    expect(r.code).toBe('ok')
    expect(r.similar.some((s) => s.item.id === 'p56' && s.reason === 'similar_name')).toBe(true)
  })
  it('brandless names compare on the full name; items without size or brand still dedupe', () => {
    expect(findDuplicates(index, { name: 'mystery snack' }).code).toBe('possible_duplicate')
    expect(findDuplicates(index, { name: 'Mystery Snack', brand: 'Acme' }).code).toBe('possible_duplicate')
  })
  it('accepts a plain array and never mutates', () => {
    expect(findDuplicates(items, { name: 'Tata Salt 1 kg', brand: 'Tata' }).code).toBe('possible_duplicate')
  })
})
