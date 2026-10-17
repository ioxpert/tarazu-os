import { describe, expect, it } from 'vitest'
import { item, OpLogWriter } from './oplog'
import { makeSchemaDb } from './schemaDb'

const IDENTITY = { deviceId: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d', storeId: '11111111-1111-4111-8111-111111111111' }

describe('schema-driven test db', () => {
  it('has every table of the app schema', async () => {
    const { db } = await makeSchemaDb()
    const names = (await db.getAll<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name)
    for (const t of ['op_log', 'product', 'invoice', 'invoice_line', 'credit_note', 'shift', 'shift_close', 'held_bill', 'approver', 'share_queue']) {
      expect(names).toContain(t)
    }
  })

  it('writeAllWith builds items inside the transaction and consumes nothing when the builder throws', async () => {
    const { db } = await makeSchemaDb()
    const writer = new OpLogWriter(db, IDENTITY)
    await expect(
      writer.writeAllWith(async () => {
        throw new Error('stock check failed')
      }),
    ).rejects.toThrow('stock check failed')
    expect((await db.get<{ n: number }>('SELECT count(*) AS n FROM op_log')).n).toBe(0)
    const [w] = await writer.writeAllWith(async (tx) => {
      const rows = await tx.getAll<{ n: number }>('SELECT count(*) AS n FROM op_log')
      expect(rows[0].n).toBe(0)
      return [item({ entityType: 'product', entityId: '22222222-2222-4222-8222-222222222222', opType: 'create', payload: { name: 'x' } })]
    })
    expect(w.localSeq).toBe(1)
  })
})
