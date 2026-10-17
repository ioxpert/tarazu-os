import { describe, expect, it } from 'vitest'
import { compare, parse } from './hlc'
import { item, OpLogWriter } from './oplog'
import { makeTestDb } from './testDb'
import { isUuidV7 } from './uuid7'

const IDENTITY = { deviceId: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d', storeId: '11111111-1111-4111-8111-111111111111' }
const PRODUCT = '22222222-2222-4222-8222-222222222222'

describe('OpLogWriter', () => {
  it('writes a well-formed op: UUIDv7 id, local sequence, HLC, idempotency key, schema version', async () => {
    const { sqlite, db } = await makeTestDb()
    const writer = new OpLogWriter(db, IDENTITY, () => Date.parse('2026-10-17T10:00:00.000Z'))
    const written = await writer.write({
      entityType: 'product',
      entityId: PRODUCT,
      opType: 'create',
      payload: { name: 'Tata Salt' },
      actorUserId: null,
    })
    expect(isUuidV7(written.operationId)).toBe(true)
    expect(written.localSeq).toBe(1)
    expect(written.idempotencyKey).toBe(`${IDENTITY.deviceId}:1`)
    expect(written.hlc).toBe('2026-10-17T10:00:00.000Z-0000-a1b2c3d4')

    const row = sqlite.prepare('SELECT * FROM op_log').get() as Record<string, unknown>
    expect(row).toMatchObject({
      id: written.operationId,
      device_id: IDENTITY.deviceId,
      store_id: IDENTITY.storeId,
      entity_type: 'product',
      op_type: 'create',
      schema_version: 1,
      local_seq: 1,
    })
    expect(JSON.parse(row.payload as string)).toEqual({ name: 'Tata Salt' })
  })

  it('keeps local_seq strictly increasing and HLC monotonic across writes, even if the clock goes backwards', async () => {
    const { db } = await makeTestDb()
    const clock = [10_000, 10_000, 5_000, 20_000]
    const writer = new OpLogWriter(db, IDENTITY, () => clock.shift()! + Date.parse('2026-10-17T00:00:00.000Z'))
    const out = []
    for (let i = 0; i < 4; i++) {
      out.push(await writer.write({ entityType: 'product', entityId: PRODUCT, opType: 'update', payload: { name: `n${i}` } }))
    }
    expect(out.map((o) => o.localSeq)).toEqual([1, 2, 3, 4])
    const hlcs = out.map((o) => parse(o.hlc))
    for (let i = 1; i < hlcs.length; i++) {
      expect(compare(hlcs[i], hlcs[i - 1])).toBeGreaterThan(0)
    }
    expect(new Set(out.map((o) => o.operationId)).size).toBe(4)
    expect([...out.map((o) => o.operationId)].sort()).toEqual(out.map((o) => o.operationId))
  })

  it('continues the sequence after a restart (state lives in device_state)', async () => {
    const { db } = await makeTestDb()
    await new OpLogWriter(db, IDENTITY).write({ entityType: 'party', entityId: PRODUCT, opType: 'create', payload: { name: 'A' } })
    const second = await new OpLogWriter(db, IDENTITY).write({ entityType: 'party', entityId: PRODUCT, opType: 'update', payload: { name: 'B' } })
    expect(second.localSeq).toBe(2)
  })

  it('commits ops and local effects atomically, with consecutive sequence numbers', async () => {
    const { sqlite, db } = await makeTestDb()
    const writer = new OpLogWriter(db, IDENTITY)
    const out = await writer.writeAll([
      item(
        { entityType: 'stock_movement', entityId: PRODUCT, opType: 'create', payload: { productId: PRODUCT, qtyMilli: -1000, reason: 'sale' } },
        [{ sql: 'INSERT INTO stock_balance (id, qty_milli) VALUES (?, ?)', params: ['s:p', -1000] }],
      ),
      item({ entityType: 'khata_entry', entityId: PRODUCT, opType: 'create', payload: { partyId: PRODUCT, direction: 'debit', amountPaise: 500 } }),
    ])
    expect(out.map((o) => o.localSeq)).toEqual([1, 2])
    expect(sqlite.prepare('SELECT count(*) AS n FROM op_log').get()).toEqual({ n: 2 })
    expect(sqlite.prepare('SELECT qty_milli FROM stock_balance').get()).toEqual({ qty_milli: -1000 })
  })

  it('rolls everything back, including the sequence, when a local effect fails', async () => {
    const { sqlite, db } = await makeTestDb()
    const writer = new OpLogWriter(db, IDENTITY)
    await expect(
      writer.write(
        { entityType: 'product', entityId: PRODUCT, opType: 'create', payload: { name: 'x' } },
        [{ sql: 'INSERT INTO no_such_table VALUES (1)' }],
      ),
    ).rejects.toThrow()
    expect(sqlite.prepare('SELECT count(*) AS n FROM op_log').get()).toEqual({ n: 0 })
    expect(sqlite.prepare('SELECT count(*) AS n FROM device_state').get()).toEqual({ n: 0 })
    const ok = await writer.write({ entityType: 'product', entityId: PRODUCT, opType: 'create', payload: { name: 'x' } })
    expect(ok.localSeq).toBe(1)
  })
})
