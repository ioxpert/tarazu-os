import { describe, expect, it } from 'vitest'
import { OpLogWriter } from '../sync/oplog'
import { makeTestDb } from '../sync/testDb'
import { isUuidV7 } from '../sync/uuid7'
import { buildCatalogue, buildSale, percentile } from './testSale'

const ctx = {
  tenantId: 't', storeId: '11111111-1111-4111-8111-111111111111', deviceId: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
  productId: '22222222-2222-4222-8222-222222222222', partyId: '33333333-3333-4333-8333-333333333333', number: 1,
}

describe('test sale', () => {
  it('commits invoice + stock movement + khata entry atomically with their local effects', async () => {
    const { sqlite, db } = await makeTestDb()
    sqlite.exec(`CREATE TABLE invoice (id TEXT PRIMARY KEY, tenant_id, store_id, device_id, series, number, doc_type, invoice_date, party_id,
      subtotal_paise, discount_paise, tax_paise, round_off_paise, total_paise, created_at);
      CREATE TABLE invoice_line (id TEXT PRIMARY KEY, tenant_id, invoice_id, line_no, product_id, qty_milli, unit_price_paise,
      discount_paise, tax_rate_bp, tax_paise, line_total_paise)`)
    const writer = new OpLogWriter(db, ctx)
    await writer.writeAll(buildCatalogue(ctx))
    const out = await writer.writeAll(buildSale(ctx))
    expect(out.map((o) => o.entityType)).toEqual(['invoice', 'stock_movement', 'khata_entry'])
    expect(out.every((o) => isUuidV7(o.operationId))).toBe(true)
    expect(out.map((o) => o.localSeq)).toEqual([3, 4, 5])
    expect(sqlite.prepare('SELECT qty_milli, oversold FROM stock_balance').get()).toEqual({ qty_milli: -1000, oversold: 1 })
    expect(sqlite.prepare('SELECT balance_paise FROM khata_balance').get()).toEqual({ balance_paise: 5000 })
    expect(sqlite.prepare('SELECT count(*) AS n FROM invoice_line').get()).toEqual({ n: 1 })
  })

  it('computes nearest-rank percentiles', () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(percentile(v, 50)).toBe(50)
    expect(percentile(v, 95)).toBe(95)
    expect(percentile([], 95)).toBe(0)
  })
})
