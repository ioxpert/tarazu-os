import { describe, expect, it, vi } from 'vitest'
import { TarazuConnector, UPLOAD_BATCH, UploadError, type CrudBatchLike, type CrudEntryLike, type SyncSignals, type UploadDb } from './connector'

function opEntry(i: number, extra: Record<string, unknown> = {}): CrudEntryLike {
  return {
    table: 'op_log',
    op: 'PUT',
    id: `op-${i}`,
    opData: {
      store_id: 'store',
      device_id: 'device',
      actor_user_id: null,
      local_seq: i,
      hlc: '2026-10-17T10:00:00.000Z-0000-a1b2c3d4',
      idempotency_key: `device:${i}`,
      entity_type: 'product',
      entity_id: `ent-${i}`,
      op_type: 'create',
      schema_version: 1,
      payload: JSON.stringify({ name: `p${i}` }),
      ...extra,
    },
  }
}

/** A queue that serves batches lazily and only forgets entries when a batch is completed. */
function fakeDb(entries: () => Generator<CrudEntryLike>) {
  const queue = entries()
  let peeked: CrudEntryLike[] = []
  let completed = 0
  let maxBatch = 0
  const executed: { sql: string; params?: unknown[] }[] = []
  const db: UploadDb = {
    async getCrudBatch(limit = 100) {
      // un-completed entries are served again, like ps_crud
      while (peeked.length <= limit) {
        const n = queue.next()
        if (n.done) break
        peeked.push(n.value)
      }
      if (peeked.length === 0) return null
      const crud = peeked.slice(0, limit)
      maxBatch = Math.max(maxBatch, crud.length)
      return {
        crud,
        haveMore: peeked.length > crud.length,
        complete: async () => {
          completed += crud.length
          peeked = peeked.slice(crud.length)
        },
      } satisfies CrudBatchLike
    },
    async execute(sql, params) {
      executed.push({ sql, params })
    },
  }
  return { db, stats: () => ({ completed, maxBatch, executed }) }
}

function signals(): SyncSignals & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = { auth: [], upload: [], issues: [], uploaded: [] }
  return {
    calls,
    setAuthProblem: (c) => calls.auth.push(c),
    setUploadProblem: (p) => calls.upload.push(p),
    issuesChanged: () => calls.issues.push(true),
    uploaded: (n) => calls.uploaded.push(n),
  }
}

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const ackAll = (ops: { operationId: string }[]) => ({
  accepted: ops.length,
  duplicates: 0,
  rejected: 0,
  deferred: 0,
  flagged: 0,
  results: ops.map((o) => ({ operationId: o.operationId, status: 'applied' })),
})

function connector(fetchImpl: typeof fetch, s = signals()) {
  return { c: new TarazuConnector({ apiBase: '/api', deviceToken: 'tzd.t.d.secret', signals: s, fetchImpl }), s }
}

describe('TarazuConnector.uploadData', () => {
  it('drains 100,000 queued ops in batches of at most 500 without loading the queue at once', async () => {
    const TOTAL = 100_000
    const { db, stats } = fakeDb(function* () {
      for (let i = 1; i <= TOTAL; i++) yield opEntry(i)
    })
    let requests = 0
    let seq = 0
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const { operations } = JSON.parse(init!.body as string) as { operations: { operationId: string; localSeq: number }[] }
      requests++
      expect(operations.length).toBeLessThanOrEqual(UPLOAD_BATCH)
      for (const o of operations) expect(o.localSeq).toBe(++seq) // queue order preserved
      return ok(ackAll(operations))
    }) as unknown as typeof fetch
    const { c, s } = connector(fetchImpl)
    await c.uploadData(db)
    expect(seq).toBe(TOTAL)
    expect(requests).toBe(TOTAL / UPLOAD_BATCH)
    expect(stats().completed).toBe(TOTAL)
    expect(stats().maxBatch).toBe(UPLOAD_BATCH)
    expect(s.calls.uploaded.reduce((a, b) => (a as number) + (b as number), 0)).toBe(TOTAL)
  }, 60_000)

  it('sends the contract shape with a bearer token and parsed payload', async () => {
    const { db } = fakeDb(function* () {
      yield opEntry(1, { actor_user_id: 'user-1' })
    })
    const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string)
      expect(init!.headers).toMatchObject({ Authorization: 'Bearer tzd.t.d.secret' })
      expect(body.operations[0]).toEqual({
        operationId: 'op-1',
        storeId: 'store',
        deviceId: 'device',
        actorUserId: 'user-1',
        localSeq: 1,
        hlc: '2026-10-17T10:00:00.000Z-0000-a1b2c3d4',
        idempotencyKey: 'device:1',
        entityType: 'product',
        entityId: 'ent-1',
        opType: 'create',
        schemaVersion: 1,
        payload: { name: 'p1' },
      })
      return ok(ackAll(body.operations))
    }) as unknown as typeof fetch
    await connector(fetchImpl).c.uploadData(db)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('completes optimistic local-effect CRUD without sending it', async () => {
    const { db, stats } = fakeDb(function* () {
      yield { table: 'stock_balance', op: 'PUT', id: 's:p', opData: { qty_milli: -1000 } }
      yield { table: 'khata_balance', op: 'PATCH', id: 'x', opData: {} }
    })
    const fetchImpl = vi.fn() as unknown as typeof fetch
    await connector(fetchImpl).c.uploadData(db)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(stats().completed).toBe(2)
  })

  it('records rejected and flagged results as local issues but still completes the batch', async () => {
    const { db, stats } = fakeDb(function* () {
      for (let i = 1; i <= 3; i++) yield opEntry(i)
    })
    const fetchImpl = vi.fn(async () =>
      ok({
        accepted: 3, duplicates: 0, rejected: 1, deferred: 0, flagged: 1,
        results: [
          { operationId: 'op-1', status: 'applied' },
          { operationId: 'op-2', status: 'rejected', code: 'invalid_payload', message: 'Field name is required' },
          { operationId: 'op-3', status: 'flagged', code: 'oversold' },
        ],
      }),
    ) as unknown as typeof fetch
    const { c, s } = connector(fetchImpl)
    await c.uploadData(db)
    const inserts = stats().executed.filter((e) => e.sql.includes('op_issue'))
    expect(inserts.map((e) => e.params?.slice(0, 3))).toEqual([
      ['op-2', 'rejected', 'invalid_payload'],
      ['op-3', 'flagged', 'oversold'],
    ])
    expect(s.calls.issues).toHaveLength(1)
    expect(stats().completed).toBe(3)
  })

  it.each([500, 502, 503, 429])('keeps the queue and throws on HTTP %i so PowerSync retries', async (status) => {
    const { db, stats } = fakeDb(function* () {
      yield opEntry(1)
    })
    const fetchImpl = vi.fn(async () => ok({ title: 'x' }, status)) as unknown as typeof fetch
    const { c, s } = connector(fetchImpl)
    await expect(c.uploadData(db)).rejects.toBeInstanceOf(UploadError)
    expect(stats().completed).toBe(0)
    expect(s.calls.auth).toEqual([])
    expect(s.calls.upload).toEqual([]) // transient: not "action required"
  })

  it('keeps the queue and rethrows on a network failure', async () => {
    const { db, stats } = fakeDb(function* () {
      yield opEntry(1)
    })
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    await expect(connector(fetchImpl).c.uploadData(db)).rejects.toThrow('Failed to fetch')
    expect(stats().completed).toBe(0)
  })

  it.each([['device_revoked'], ['invalid_token']])('stops for good on 401 %s: marks auth, keeps data, no further requests', async (code) => {
    const { db, stats } = fakeDb(function* () {
      yield opEntry(1)
    })
    const fetchImpl = vi.fn(async () => ok({ status: 401, code, detail: 'no' }, 401)) as unknown as typeof fetch
    const { c, s } = connector(fetchImpl)
    await expect(c.uploadData(db)).rejects.toBeInstanceOf(UploadError)
    expect(s.calls.auth).toEqual([code])
    expect(stats().completed).toBe(0)

    await expect(c.uploadData(db)).rejects.toMatchObject({ code: 'blocked' }) // no hot loop to the server
    expect(await c.fetchCredentials()).toBeNull()
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('treats a 403 device_revoked like a revocation', async () => {
    const { db } = fakeDb(function* () {
      yield opEntry(1)
    })
    const fetchImpl = vi.fn(async () => ok({ code: 'device_revoked', detail: 'x' }, 403)) as unknown as typeof fetch
    const { c, s } = connector(fetchImpl)
    await expect(c.uploadData(db)).rejects.toBeInstanceOf(UploadError)
    expect(s.calls.auth).toEqual(['device_revoked'])
  })

  it('surfaces other 4xx refusals (local_only_mode, 422) without completing, then clears on success', async () => {
    const { db, stats } = fakeDb(function* () {
      yield opEntry(1)
    })
    let refuse = true
    const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) => {
      if (refuse) return ok({ code: 'local_only_mode', detail: 'This merchant is in local-only mode' }, 403)
      return ok(ackAll(JSON.parse(init!.body as string).operations))
    }) as unknown as typeof fetch
    const { c, s } = connector(fetchImpl)
    await expect(c.uploadData(db)).rejects.toMatchObject({ code: 'local_only_mode', status: 403 })
    expect(s.calls.upload[0]).toMatchObject({ status: 403, code: 'local_only_mode' })
    expect(stats().completed).toBe(0)

    refuse = false
    await c.uploadData(db)
    expect(stats().completed).toBe(1)
    expect(s.calls.upload.at(-1)).toBeNull()
  })

  it('never drops a local row it cannot read', async () => {
    const { db, stats } = fakeDb(function* () {
      yield opEntry(1, { payload: '{not json' })
    })
    const fetchImpl = vi.fn() as unknown as typeof fetch
    await expect(connector(fetchImpl).c.uploadData(db)).rejects.toMatchObject({ code: 'corrupt_local_op' })
    expect(stats().completed).toBe(0)
  })
})

describe('TarazuConnector.fetchCredentials', () => {
  it('returns the PowerSync endpoint and token', async () => {
    const fetchImpl = vi.fn(async (url: unknown) => {
      expect(url).toBe('/api/v1/sync/credentials')
      return ok({ endpoint: 'http://ps', token: 'jwt', expiresAt: '2026-10-17T10:05:00Z' })
    }) as unknown as typeof fetch
    const creds = await connector(fetchImpl).c.fetchCredentials()
    expect(creds).toMatchObject({ endpoint: 'http://ps', token: 'jwt' })
    expect(creds?.expiresAt?.toISOString()).toBe('2026-10-17T10:05:00.000Z')
  })

  it('blocks on a revoked device and throws on temporary failure', async () => {
    const revoked = vi.fn(async () => ok({ code: 'device_revoked' }, 401)) as unknown as typeof fetch
    const { c, s } = connector(revoked)
    await expect(c.fetchCredentials()).rejects.toBeInstanceOf(UploadError)
    expect(s.calls.auth).toEqual(['device_revoked'])

    const down = vi.fn(async () => ok({}, 503)) as unknown as typeof fetch
    await expect(connector(down).c.fetchCredentials()).rejects.toMatchObject({ status: 503 })
  })
})
