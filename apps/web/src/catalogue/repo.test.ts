import { describe, expect, it } from 'vitest'
import { OpLogWriter } from '../sync/oplog'
import { makeSchemaDb } from '../sync/schemaDb'
import { createItem, listCategories, loadCatalogue, loadItemsByBarcode, loadPopularity, pinItem, recentlySoldIds, setPrice, stockIn, updateItem, validateDraft } from './repo'
import { mkItem } from './testkit'
import { buildChain } from './uom'

const IDENT = { deviceId: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d', storeId: '11111111-1111-4111-8111-111111111111' }
const CTX = { tenantId: '99999999-9999-4999-8999-999999999999', storeId: IDENT.storeId, deviceId: IDENT.deviceId, actorUserId: null }
const NOW = new Date('2026-10-17T10:00:00.000Z')
const LATER = new Date('2026-10-17T10:00:01.000Z')

async function setup() {
  const { sqlite, db } = await makeSchemaDb()
  let t = NOW.getTime()
  const writer = new OpLogWriter(db, IDENT, () => t++)
  const ops = () => sqlite.prepare('SELECT entity_type, op_type, payload FROM op_log ORDER BY local_seq').all() as Array<{ entity_type: string; op_type: string; payload: string }>
  return { sqlite, db, writer, ops }
}

describe('createItem', () => {
  it('writes product + mrp + retail + opening stock atomically with local effects, in < 100 ms', async () => {
    const { db, writer, ops } = await setup()
    const t0 = performance.now()
    const r = await createItem(writer, db, CTX, {
      name: ' Parle-G Biscuit 56 g ', brand: 'Parle', category: 'biscuits', hsn: '1905', unit: 'packet', barcode: ' 8901719101236 ',
      mrpPaise: 500, retailPaise: 500, taxRateBp: 500,
      uom: buildChain([{ unit: 'carton', per: 12 }, { unit: 'packet' }]),
      openingStock: { qty: '2', unit: 'carton' },
    }, { now: NOW })
    const ms = performance.now() - t0
    expect(ms).toBeLessThan(100)
    if (r.status !== 'created') throw new Error(r.status)
    expect(ops().map((o) => `${o.entity_type}:${o.op_type}`)).toEqual(['product:create', 'price_version:create', 'price_version:create', 'stock_movement:create'])
    expect(JSON.parse(ops()[0].payload)).toMatchObject({ name: 'Parle-G Biscuit 56 g', barcode: '8901719101236', unit: 'packet', taxInclusive: true, active: true })
    expect(JSON.parse(ops()[3].payload)).toMatchObject({ productId: r.item.id, qtyMilli: 24000, reason: 'opening' })

    const [loaded] = await loadCatalogue(db, { storeId: IDENT.storeId, now: LATER })
    expect(loaded).toEqual(r.item)
    expect(loaded).toMatchObject({ mrpPaise: 500, retailPaise: 500, stockMilli: 24000, oversold: false, barcode: '8901719101236' })
  })

  it('minimal item: name + unit only, loose defaults to kg/g chain', async () => {
    const { db, writer, ops } = await setup()
    const a = await createItem(writer, db, CTX, { name: 'Mystery Snack', unit: 'piece' })
    const b = await createItem(writer, db, CTX, { name: 'Gur Loose', unit: 'kg', loose: true, retailPaise: 6500 })
    expect(a.status).toBe('created')
    if (b.status !== 'created') throw new Error(b.status)
    expect(b.item.uom).toEqual({ base: 'kg', units: [{ unit: 'g', qtyMilli: 1 }] })
    expect(ops().map((o) => o.entity_type)).toEqual(['product', 'product', 'price_version'])
  })

  it('refuses invalid drafts with codes and writes nothing', async () => {
    const { db, writer, ops } = await setup()
    const cases: Array<[Parameters<typeof createItem>[3], string]> = [
      [{ name: '  ', unit: 'piece' }, 'name_required'],
      [{ name: 'x', unit: 'furlong' as never }, 'bad_unit'],
      [{ name: 'x', unit: 'case', uom: { base: 'piece', units: [] } }, 'unit_not_in_uom'],
      [{ name: 'x', unit: 'piece', uom: { base: 'piece', units: [{ unit: 'piece', qtyMilli: 5 }] } }, 'bad_uom'],
      [{ name: 'x', unit: 'piece', barcode: '12' }, 'bad_barcode'],
      [{ name: 'x', unit: 'piece', hsn: 'abc' }, 'bad_hsn'],
      [{ name: 'x', unit: 'piece', taxRateBp: 20000 }, 'bad_tax_rate'],
      [{ name: 'x', unit: 'piece', mrpPaise: -1 }, 'bad_price'],
      [{ name: 'x', unit: 'piece', mrpPaise: 1.5 }, 'bad_price'],
      [{ name: 'x', unit: 'piece', openingStock: { qty: '0', unit: 'piece' } }, 'bad_opening_stock'],
      [{ name: 'x', unit: 'piece', openingStock: { qty: 'abc', unit: 'piece' } }, 'bad_opening_stock'],
      [{ name: 'x', unit: 'piece', openingStock: { qty: '1', unit: 'case' } }, 'bad_opening_stock'],
    ]
    for (const [draft, code] of cases) {
      const r = await createItem(writer, db, CTX, draft)
      expect(r.status, code).toBe('invalid')
      if (r.status === 'invalid') expect(r.issues).toContain(code)
    }
    expect(ops()).toHaveLength(0)
    expect(validateDraft({ name: 'ok', unit: 'piece', barcode: '4006381333932' }).issues).toEqual([]) // bad checksum is accepted (UI warns)
  })

  it('duplicate policy: barcode_exists always refuses; possible_duplicate refuses until the human confirms', async () => {
    const { db, writer, ops } = await setup()
    await createItem(writer, db, CTX, { name: 'Parle-G Biscuit 56 g', brand: 'Parle', unit: 'packet', barcode: '8901719101236' })
    const n = ops().length

    const sameBarcode = await createItem(writer, db, CTX, { name: 'Something else entirely', unit: 'piece', barcode: '8901719101236', allowDuplicate: true })
    expect(sameBarcode.status).toBe('duplicate')
    if (sameBarcode.status === 'duplicate') expect(sameBarcode.duplicate.code).toBe('barcode_exists')

    const similar = await createItem(writer, db, CTX, { name: 'parley gee biscuit 56g', brand: 'Parle', unit: 'packet' })
    expect(similar.status).toBe('duplicate')
    if (similar.status === 'duplicate') expect(similar.duplicate.similar[0].item.name).toBe('Parle-G Biscuit 56 g')
    expect(ops()).toHaveLength(n)

    const confirmed = await createItem(writer, db, CTX, { name: 'parley gee biscuit 56g', brand: 'Parle', unit: 'packet', allowDuplicate: true })
    expect(confirmed.status).toBe('created')

    // a different pack size is never a duplicate
    expect((await createItem(writer, db, CTX, { name: 'Parle-G Biscuit 100 g', brand: 'Parle', unit: 'packet' })).status).toBe('created')
  })

  it('a barcode added by someone else after the index was built is still caught under the write lock', async () => {
    const { db, writer, ops } = await setup()
    const staleIndex = (await import('./search')).CatalogueIndex
    const stale = new staleIndex()
    await createItem(writer, db, CTX, { name: 'First', unit: 'piece', barcode: '12345678' }, { index: stale })
    const n = ops().length
    const r = await createItem(writer, db, CTX, { name: 'Second', unit: 'piece', barcode: '12345678' }, { index: stale })
    expect(r.status).toBe('duplicate')
    expect(ops()).toHaveLength(n)
  })

  it('rolls back everything when a later op fails (atomic)', async () => {
    const { sqlite, db, writer } = await setup()
    sqlite.exec('CREATE TRIGGER no_stock BEFORE INSERT ON stock_balance BEGIN SELECT RAISE(ABORT, \'stock down\'); END')
    await expect(createItem(writer, db, CTX, { name: 'Atomic', unit: 'piece', mrpPaise: 100, openingStock: { qty: '5', unit: 'piece' } })).rejects.toThrow('stock down')
    expect((sqlite.prepare('SELECT count(*) n FROM op_log').all()[0] as { n: number }).n).toBe(0)
    expect((sqlite.prepare('SELECT count(*) n FROM product').all()[0] as { n: number }).n).toBe(0)
    expect((sqlite.prepare('SELECT count(*) n FROM price_version').all()[0] as { n: number }).n).toBe(0)
  })
})

describe('updateItem / setPrice / pinItem / stockIn', () => {
  async function withItem() {
    const s = await setup()
    const r = await createItem(s.writer, s.db, CTX, { name: 'Tata Salt 1 kg', brand: 'Tata', category: 'sugar-salt', unit: 'packet', hsn: '2501', mrpPaise: 2800 }, { now: NOW })
    if (r.status !== 'created') throw new Error(r.status)
    return { ...s, item: r.item }
  }

  it('sends only the changed fields as one update op and updates the local row', async () => {
    const { db, writer, ops, item } = await withItem()
    const before = ops().length
    const r = await updateItem(writer, db, CTX, item, { name: 'Tata Salt 1 kg', brand: 'Tata', hsn: '2501', category: 'masala', localName: 'टाटा नमक' }, { now: LATER })
    if (r.status !== 'updated') throw new Error(r.status)
    expect(r.changed.sort()).toEqual(['category', 'localName'])
    expect(ops()).toHaveLength(before + 1)
    expect(JSON.parse(ops().at(-1)!.payload)).toEqual({ category: 'masala', localName: 'टाटा नमक' })
    expect(ops().at(-1)!.op_type).toBe('update')
    const [loaded] = await loadCatalogue(db, { storeId: IDENT.storeId, now: LATER })
    expect(loaded).toMatchObject({ category: 'masala', localName: 'टाटा नमक', name: 'Tata Salt 1 kg' })
    expect(r.item).toEqual(loaded)
  })

  it('no change = no op; invalid and duplicate-barcode edits are refused', async () => {
    const { db, writer, ops, item } = await withItem()
    const n = ops().length
    expect((await updateItem(writer, db, CTX, item, { name: item.name, hsn: '2501' })).status).toBe('unchanged')
    expect((await updateItem(writer, db, CTX, item, { name: '' })).status).toBe('invalid')
    await createItem(writer, db, CTX, { name: 'Other', unit: 'piece', barcode: '8901234567890' })
    const dup = await updateItem(writer, db, CTX, item, { barcode: '8901234567890' })
    expect(dup.status).toBe('duplicate')
    expect(ops()).toHaveLength(n + 1)
    const ok = await updateItem(writer, db, CTX, item, { barcode: '8901234567890'.replace('0', '1') })
    expect(ok.status).toBe('updated')
    const cleared = await updateItem(writer, db, CTX, { ...item, barcode: '123456' }, { barcode: null })
    expect(cleared.status).toBe('updated')
  })

  it('setPrice appends a new price_version; the newest effective one wins, future ones wait, history stays', async () => {
    const { sqlite, db, writer, item } = await withItem()
    await setPrice(writer, CTX, item.id, 'retail', 2700)
    const future = new Date(Date.now() + 86_400_000)
    await setPrice(writer, CTX, item.id, 'retail', 3100, { effectiveFrom: future })
    await setPrice(writer, CTX, item.id, 'retail', 2650)
    const now = new Date(Date.now() + 5000)
    const [a] = await loadCatalogue(db, { storeId: IDENT.storeId, now })
    expect(a.retailPaise).toBe(2650)
    expect(a.mrpPaise).toBe(2800)
    const [b] = await loadCatalogue(db, { storeId: IDENT.storeId, now: new Date(future.getTime() + 1000) })
    expect(b.retailPaise).toBe(3100)
    expect((sqlite.prepare("SELECT count(*) n FROM price_version WHERE price_type = 'retail'").all()[0] as { n: number }).n).toBe(3)
    await expect(setPrice(writer, CTX, item.id, 'retail', -5)).rejects.toThrow(RangeError)
    await expect(setPrice(writer, CTX, item.id, 'retail', 1.5)).rejects.toThrow(RangeError)
  })

  it('customer prices and other stores stock never leak into the item', async () => {
    const { sqlite, db, item } = await withItem()
    sqlite.prepare("INSERT INTO price_version (id, tenant_id, product_id, party_id, price_type, amount_paise, effective_from, hlc) VALUES ('c1', 't', ?, 'p1', 'retail', 1, '2020-01-01T00:00:00Z', 'x')").run(item.id)
    sqlite.prepare("INSERT INTO price_version (id, tenant_id, product_id, party_id, price_type, amount_paise, effective_from, hlc) VALUES ('c2', 't', ?, NULL, 'wholesale', 1, '2020-01-01T00:00:00Z', 'x')").run(item.id)
    sqlite.prepare("INSERT INTO stock_balance (id, tenant_id, store_id, product_id, qty_milli, oversold, movement_count) VALUES ('s:p', 't', 'other-store', ?, 9000, 0, 1)").run(item.id)
    const [it] = await loadCatalogue(db, { storeId: IDENT.storeId, now: LATER })
    expect(it.retailPaise).toBeNull()
    expect(it.stockMilli).toBeNull()
  })

  it('later hlc wins when two prices share an effective time', async () => {
    const { sqlite, db, item } = await withItem()
    for (const [id, hlc, amount] of [['h1', '2026-10-17T10:00:00.000Z-0000-aaaaaaaa', 111], ['h2', '2026-10-17T10:00:00.000Z-0001-aaaaaaaa', 222], ['h0', '2026-10-17T09:59:59.000Z-0000-bbbbbbbb', 333]] as const) {
      sqlite.prepare("INSERT INTO price_version (id, tenant_id, product_id, party_id, price_type, amount_paise, effective_from, hlc) VALUES (?, 't', ?, NULL, 'retail', ?, '2026-10-17T10:00:00.000Z', ?)").run(id, item.id, amount, hlc)
    }
    const [it] = await loadCatalogue(db, { storeId: IDENT.storeId, now: LATER })
    expect(it.retailPaise).toBe(222)
  })

  it('pinItem writes a one-field update', async () => {
    const { db, writer, ops, item } = await withItem()
    await pinItem(writer, CTX, item.id, true)
    expect(JSON.parse(ops().at(-1)!.payload)).toEqual({ pinned: true })
    expect((await loadCatalogue(db, { storeId: IDENT.storeId, now: LATER }))[0].pinned).toBe(true)
    await pinItem(writer, CTX, item.id, false)
    expect((await loadCatalogue(db, { storeId: IDENT.storeId, now: LATER }))[0].pinned).toBe(false)
  })

  it("stockIn is an 'adjustment' movement converted to base units, and moves the balance", async () => {
    const s = await setup()
    const r = await createItem(s.writer, s.db, CTX, { name: 'Eggs', unit: 'piece', uom: { base: 'piece', units: [{ unit: 'dozen', qtyMilli: 12000 }] } })
    if (r.status !== 'created') throw new Error(r.status)
    const out = await stockIn(s.writer, CTX, r.item, '2.5', 'dozen')
    expect(out.qtyMilli).toBe(30000)
    expect(JSON.parse(s.ops().at(-1)!.payload)).toMatchObject({ productId: r.item.id, qtyMilli: 30000, reason: 'adjustment' })
    await stockIn(s.writer, CTX, r.item, 6, 'piece')
    const [it] = await loadCatalogue(s.db, { storeId: IDENT.storeId, now: LATER })
    expect(it.stockMilli).toBe(36000)
    await expect(stockIn(s.writer, CTX, r.item, '0', 'piece')).rejects.toThrow(RangeError)
    await expect(stockIn(s.writer, CTX, r.item, '1', 'case')).rejects.toThrow()
  })
})

describe('loading', () => {
  it('falls back safely on a broken uom/unit and maps ints to booleans', async () => {
    const { sqlite, db } = await setup()
    sqlite.prepare("INSERT INTO product (id, tenant_id, name, unit, uom, tax_inclusive, loose, pinned, active) VALUES ('p1', 't', 'Broken', 'bottle', '{not json', 0, 1, 1, 0)").run()
    sqlite.prepare("INSERT INTO product (id, tenant_id, name, unit, uom) VALUES ('p2', 't', 'Bare', NULL, NULL)").run()
    const items = await loadCatalogue(db, { storeId: IDENT.storeId })
    const p1 = items.find((i) => i.id === 'p1')!
    expect(p1).toMatchObject({ uom: { base: 'bottle', units: [] }, taxInclusive: false, loose: true, pinned: true, active: false, stockMilli: null })
    const p2 = items.find((i) => i.id === 'p2')!
    expect(p2).toMatchObject({ unit: 'piece', uom: { base: 'piece', units: [] }, taxInclusive: true, active: true })
  })

  it('loadItemsByBarcode matches UPC-A / EAN-13 spellings and ignores inactive items', async () => {
    const { sqlite, db } = await setup()
    sqlite.prepare("INSERT INTO product (id, tenant_id, name, barcode, unit, active) VALUES ('a', 't', 'A', '036000291452', 'piece', 1)").run()
    sqlite.prepare("INSERT INTO product (id, tenant_id, name, barcode, unit, active) VALUES ('b', 't', 'B', '111111', 'piece', 0)").run()
    expect((await loadItemsByBarcode(db, { storeId: 's' }, '0036000291452')).map((i) => i.id)).toEqual(['a'])
    expect(await loadItemsByBarcode(db, { storeId: 's' }, '111111')).toEqual([])
  })

  it('listCategories counts active items per tile, biggest first, unknown ids keep their id', () => {
    const items = [
      mkItem({ id: '1', name: 'a', category: 'biscuits' }), mkItem({ id: '2', name: 'b', category: 'biscuits' }),
      mkItem({ id: '3', name: 'c', category: 'dairy' }), mkItem({ id: '4', name: 'd', category: 'custom-shelf' }),
      mkItem({ id: '5', name: 'e', category: 'dairy', active: false }), mkItem({ id: '6', name: 'f', category: null }),
    ]
    expect(listCategories(items).map((c) => [c.id, c.count, c.en])).toEqual([['biscuits', 2, 'Biscuits & Cookies'], ['custom-shelf', 1, 'custom-shelf'], ['dairy', 1, 'Dairy']])
  })

  it('popularity and recent items come from invoice_line with cheap SQL', async () => {
    const { sqlite, db } = await setup()
    const inv = sqlite.prepare('INSERT INTO invoice (id, tenant_id, invoice_date, created_at) VALUES (?, ?, ?, ?)')
    const line = sqlite.prepare('INSERT INTO invoice_line (id, tenant_id, invoice_id, line_no, product_id, qty_milli) VALUES (?, ?, ?, ?, ?, 1000)')
    inv.run('i1', 't', '2026-10-16', '2026-10-16T09:00:00Z')
    inv.run('i2', 't', '2026-10-17', '2026-10-17T09:00:00Z')
    inv.run('old', 't', '2025-01-01', '2025-01-01T09:00:00Z')
    line.run('i1:1', 't', 'i1', 1, 'A'); line.run('i1:2', 't', 'i1', 2, 'B')
    line.run('i2:1', 't', 'i2', 1, 'A'); line.run('i2:2', 't', 'i2', 2, 'C')
    line.run('old:1', 't', 'old', 1, 'Z')
    const pop = await loadPopularity(db, { now: NOW })
    expect([...pop]).toEqual([['A', 2], ['B', 1], ['C', 1]])
    expect(await recentlySoldIds(db, 2)).toEqual(['A', 'C'])
  })
})
