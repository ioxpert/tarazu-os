import { describe, expect, it } from 'vitest'
import type { CatalogueItem } from '../catalogue/types'
import { makeSchemaDb } from '../sync/schemaDb'
import { cartLineFromItem, loadCustomerRate, manualPrice, pickUnitPrice } from './pricing'

const PRODUCT = '22222222-2222-4222-8222-222222222221'
const PARTY = '33333333-3333-4333-8333-333333333333'
const OTHER = '33333333-3333-4333-8333-333333333334'

const item = (over: Partial<CatalogueItem> = {}): CatalogueItem => ({
  id: PRODUCT, name: 'Biscuit', localName: 'बिस्कुट', brand: null, category: null, barcode: null, sku: null, packSku: null, hsn: '19053100',
  unit: 'piece', uom: { base: 'piece', units: [] }, taxInclusive: true, taxRateBp: 1800, loose: false, pinned: false, active: true,
  mrpPaise: 1000, retailPaise: 900, stockMilli: null, oversold: false, ...over,
})

describe('pickUnitPrice', () => {
  it('customer > retail > mrp > none', () => {
    expect(pickUnitPrice(item(), 800)).toEqual({ unitPricePaise: 800, priceSource: 'customer' })
    expect(pickUnitPrice(item(), null)).toEqual({ unitPricePaise: 900, priceSource: 'retail' })
    expect(pickUnitPrice(item({ retailPaise: null }), null)).toEqual({ unitPricePaise: 1000, priceSource: 'mrp' })
    expect(pickUnitPrice(item({ retailPaise: null, mrpPaise: null }), null)).toBeNull()
    expect(pickUnitPrice(item(), 0)).toEqual({ unitPricePaise: 0, priceSource: 'customer' })
  })
  it('manual always wins and is marked manual', () => {
    expect(manualPrice(750)).toEqual({ unitPricePaise: 750, priceSource: 'manual' })
    expect(() => manualPrice(-1)).toThrow()
    const l = cartLineFromItem(item(), { qtyMilli: 1000, manualUnitPricePaise: 750, customerRatePaise: 800, rules: [], gstMode: 'regular', onDate: '2026-10-17' })
    expect(l).toMatchObject({ unitPricePaise: 750, priceSource: 'manual' })
  })
})

describe('loadCustomerRate', () => {
  async function seed() {
    const { sqlite, db } = await makeSchemaDb()
    const ins = (id: string, party: string, type: string, amount: number, from: string, hlc: string) =>
      sqlite.exec(`INSERT INTO price_version (id, tenant_id, product_id, party_id, price_type, amount_paise, effective_from, hlc)
        VALUES ('${id}', 't', '${PRODUCT}', ${party === '' ? 'NULL' : `'${party}'`}, '${type}', ${amount}, '${from}', '${hlc}')`)
    ins('1', PARTY, 'customer', 800, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00.000Z-0000-aaaaaaaa')
    ins('2', PARTY, 'customer', 780, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z-0000-aaaaaaaa')
    ins('3', PARTY, 'customer', 700, '2027-01-01T00:00:00Z', '2026-09-01T00:00:00.000Z-0000-aaaaaaaa')
    ins('4', OTHER, 'customer', 600, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00.000Z-0000-aaaaaaaa')
    ins('5', '', 'retail', 500, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00.000Z-0000-aaaaaaaa')
    return db
  }
  it('latest effective <= now for that party only; future and other prices ignored', async () => {
    const db = await seed()
    expect(await loadCustomerRate(db, PRODUCT, PARTY, Date.parse('2026-10-17T00:00:00Z'))).toBe(780)
    expect(await loadCustomerRate(db, PRODUCT, PARTY, Date.parse('2026-03-01T00:00:00Z'))).toBe(800)
    expect(await loadCustomerRate(db, PRODUCT, PARTY, Date.parse('2027-02-01T00:00:00Z'))).toBe(700)
    expect(await loadCustomerRate(db, PRODUCT, OTHER, new Date('2026-10-17'))).toBe(600)
    expect(await loadCustomerRate(db, PRODUCT, PARTY, Date.parse('2025-01-01T00:00:00Z'))).toBeNull()
    expect(await loadCustomerRate(db, 'nope', PARTY, Date.now())).toBeNull()
  })
  it('same effective instant: the later HLC wins', async () => {
    const { sqlite, db } = await makeSchemaDb()
    const ins = (id: string, amount: number, hlc: string) =>
      sqlite.exec(`INSERT INTO price_version (id, tenant_id, product_id, party_id, price_type, amount_paise, effective_from, hlc)
        VALUES ('${id}', 't', '${PRODUCT}', '${PARTY}', 'customer', ${amount}, '2026-06-01T00:00:00Z', '${hlc}')`)
    ins('a', 700, '2026-06-01T00:00:00.000Z-0000-aaaaaaaa')
    ins('b', 720, '2026-06-02T00:00:00.000Z-0000-bbbbbbbb')
    ins('c', 710, '2026-06-01T12:00:00.000Z-0003-cccccccc')
    expect(await loadCustomerRate(db, PRODUCT, PARTY, Date.parse('2026-10-01T00:00:00Z'))).toBe(720)
  })
})

describe('cartLineFromItem', () => {
  it('resolves the tax rule rate for regular merchants, none for composition', () => {
    const rules = [{ hsnPrefix: '1905', rateBp: 500, cessBp: 0, effectiveFrom: '2017-07-01' }]
    const a = cartLineFromItem(item(), { qtyMilli: 2000, rules, gstMode: 'regular', onDate: '2026-10-17', lineId: 'L1' })!
    expect(a).toMatchObject({ lineId: 'L1', taxRateBp: 500, taxRateSource: 'rule', unitPricePaise: 900, priceSource: 'retail', qtyMilli: 2000, unit: 'piece' })
    const b = cartLineFromItem(item(), { qtyMilli: 1000, rules, gstMode: 'composition', onDate: '2026-10-17' })!
    expect(b).toMatchObject({ taxRateBp: 0, taxRateSource: 'none' })
    const c = cartLineFromItem(item({ hsn: null }), { qtyMilli: 1000, rules, gstMode: 'regular', onDate: '2026-10-17' })!
    expect(c).toMatchObject({ taxRateBp: 1800, taxRateSource: 'item' })
    expect(cartLineFromItem(item({ retailPaise: null, mrpPaise: null }), { qtyMilli: 1, rules, gstMode: 'regular', onDate: '2026-10-17' })).toBeNull()
  })
})
