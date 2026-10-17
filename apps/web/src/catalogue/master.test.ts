import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeSchemaDb } from '../sync/schemaDb'
import { lookupBarcode, prefillFromMaster } from './master'

const CONFIG = { apiBase: '/api', deviceToken: 'tzd.t.d.secret' }
const OPTS = { storeId: 's1', config: CONFIG }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const MASTER = { barcode: '8901719101236', name: 'Parle-G Biscuit 56 g', localName: 'पारले-जी बिस्कुट', brand: 'Parle', category: 'Biscuits', hsn: '1905', mrpPaise: 500, unit: 'packet', uom: { base: 'packet', units: [] } }

afterEach(() => vi.useRealTimers())

async function emptyDb() {
  return (await makeSchemaDb()).db
}

describe('lookupBarcode', () => {
  it('finds a local item first and never touches the network', async () => {
    const { sqlite, db } = await makeSchemaDb()
    sqlite.prepare("INSERT INTO product (id, tenant_id, name, barcode, unit, active) VALUES ('p1', 't', 'Local Item', '8901719101236', 'packet', 1)").run()
    const fetchImpl = vi.fn()
    const r = await lookupBarcode(db, ' 8901719101236\n', fetchImpl as unknown as typeof fetch, OPTS)
    expect(r.source).toBe('local')
    if (r.source === 'local') expect(r.item.name).toBe('Local Item')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('asks the master with only the barcode and the device token, and returns a pre-filled draft', async () => {
    const fetchImpl = vi.fn(async () => json(MASTER))
    const r = await lookupBarcode(await emptyDb(), '8901719101236', fetchImpl as unknown as typeof fetch, OPTS)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/v1/catalogue/master/8901719101236')
    expect(init.method).toBe('GET')
    expect(init.body).toBeUndefined()
    expect(init.credentials).toBe('omit')
    expect(init.headers).toEqual({ Authorization: 'Bearer tzd.t.d.secret', Accept: 'application/json' })
    expect(r).toEqual({
      source: 'master',
      draft: { barcode: '8901719101236', name: 'Parle-G Biscuit 56 g', localName: 'पारले-जी बिस्कुट', brand: 'Parle', category: 'biscuits', hsn: '1905', mrpPaise: 500, unit: 'packet', uom: { base: 'packet', units: [] } },
    })
  })

  it('404 = none, 401 = offline(unauthorized), 5xx = offline(server_error), bad body = offline(bad_response)', async () => {
    const db = await emptyDb()
    const run = (res: Response | Error) => lookupBarcode(db, '8901719101236', (async () => { if (res instanceof Error) throw res; return res }) as unknown as typeof fetch, OPTS)
    expect(await run(json({ title: 'nope' }, 404))).toEqual({ source: 'none' })
    expect(await run(json({}, 401))).toEqual({ source: 'offline', reason: 'unauthorized' })
    expect(await run(json({}, 503))).toEqual({ source: 'offline', reason: 'server_error' })
    expect(await run(json({ nothing: 1 }))).toEqual({ source: 'offline', reason: 'bad_response' })
    expect(await run(new Response('<html>', { status: 200 }))).toEqual({ source: 'offline', reason: 'network' })
    expect(await run(new TypeError('Failed to fetch'))).toEqual({ source: 'offline', reason: 'network' })
  })

  it('never throws, even if fetch throws synchronously', async () => {
    const r = await lookupBarcode(await emptyDb(), '8901719101236', (() => { throw new Error('boom') }) as unknown as typeof fetch, OPTS)
    expect(r).toEqual({ source: 'offline', reason: 'network' })
  })

  it('a hung network returns offline within the 1.5 s budget (< 2 s total) and aborts the request', async () => {
    const db = await emptyDb()
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const fetchImpl = vi.fn((_u: string, init: RequestInit) => {
      signal = init.signal as AbortSignal
      return new Promise<Response>(() => undefined) // never settles, ignores abort
    })
    const started = Date.now()
    const p = lookupBarcode(db, '8901719101236', fetchImpl as unknown as typeof fetch, OPTS)
    await vi.advanceTimersByTimeAsync(1499)
    let settled = false
    void p.then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    expect(await p).toEqual({ source: 'offline', reason: 'timeout' })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a custom timeout is honoured and a fast reply leaves no timer behind', async () => {
    vi.useFakeTimers()
    const db = await emptyDb()
    const slow = lookupBarcode(db, '8901719101236', (() => new Promise(() => undefined)) as unknown as typeof fetch, { ...OPTS, timeoutMs: 300 })
    await vi.advanceTimersByTimeAsync(300)
    expect(await slow).toEqual({ source: 'offline', reason: 'timeout' })
    const fast = await lookupBarcode(db, '8901719101236', (async () => json(MASTER)) as unknown as typeof fetch, OPTS)
    expect(fast.source).toBe('master')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not call the network for codes the master cannot hold or without a device config', async () => {
    const db = await emptyDb()
    const fetchImpl = vi.fn()
    expect(await lookupBarcode(db, '12345', fetchImpl as unknown as typeof fetch, OPTS)).toEqual({ source: 'none' }) // shop code
    expect(await lookupBarcode(db, 'abc', fetchImpl as unknown as typeof fetch, OPTS)).toEqual({ source: 'none' })
    expect(await lookupBarcode(db, '8901719101236', fetchImpl as unknown as typeof fetch, { storeId: 's1', config: null })).toEqual({ source: 'offline', reason: 'no_config' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reads the device config from storage when none is passed', async () => {
    localStorage.setItem('tarazu.sync.config', JSON.stringify({ apiBase: '/api', deviceToken: 'tzd.x', deviceId: 'd', storeId: 's', tenantId: 't' }))
    try {
      const fetchImpl = vi.fn(async () => json(MASTER))
      const r = await lookupBarcode(await emptyDb(), '8901719101236', fetchImpl as unknown as typeof fetch, { storeId: 's1' })
      expect(r.source).toBe('master')
      expect((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ Authorization: 'Bearer tzd.x' })
    } finally {
      localStorage.clear()
    }
  })
})

describe('prefillFromMaster', () => {
  it('maps categories to tiles, repairs bad unit/uom, drops junk', () => {
    expect(prefillFromMaster('8901719101236', { name: ' X ', category: 'Atta & Flour', unit: 'furlong', uom: { base: 'nope', units: [] }, mrpPaise: -4, brand: '  ' })).toEqual({
      barcode: '8901719101236', name: 'X', localName: null, brand: null, category: 'atta', hsn: null, mrpPaise: null, unit: 'piece', uom: { base: 'piece', units: [] },
    })
    expect(prefillFromMaster('1', { name: 'Y', category: 'weird shelf' })?.category).toBeNull()
    expect(prefillFromMaster('1', { name: 'Y', unit: 'case', uom: { base: 'piece', units: [] } })?.unit).toBe('piece')
    expect(prefillFromMaster('1', { name: '' })).toBeNull()
  })
})
