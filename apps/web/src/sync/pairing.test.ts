import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiProblem } from '../auth/api'
import { createPairing, looksLikePairingCode, normalisePairingCode, redeemPairing } from './pairing'

const TENANT = '00000000-0000-4000-8000-000000000001'
const STORE = '11111111-1111-4111-8111-111111111111'

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
const sent = (f: ReturnType<typeof vi.fn>, n = 0) => JSON.parse((f.mock.calls[n][1] as RequestInit).body as string) as { code: string; deviceId: string; secret: string }

beforeEach(() => localStorage.clear())

describe('pairing codes', () => {
  it('recognises the server alphabet however it was typed, and nothing else', () => {
    for (const ok of ['ABCD-EFGH', 'abcd efgh', ' ab23cdef ', 'ABCDEFGH']) expect(looksLikePairingCode(ok)).toBe(true)
    for (const bad of ['', 'ABCD-EFG', 'ABCD-EFG0', 'ABCD-EFGI', 'tzd.a.b.c', 'ABCD-EFGHJ']) expect(looksLikePairingCode(bad)).toBe(false)
    expect(normalisePairingCode(' abcd  efgh ')).toBe('ABCD-EFGH')
    expect(normalisePairingCode('tzd.x')).toBeNull()
  })
})

describe('redeemPairing', () => {
  it('sends a fresh device id and a 256-bit base64url secret and returns the config from the answer', async () => {
    const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => {
      const b = JSON.parse(init!.body as string)
      return reply(201, { tenantId: TENANT, deviceId: b.deviceId, storeId: STORE, label: 'Counter', token: `tzd.${TENANT}.${b.deviceId}.${b.secret}` })
    })
    const cfg = await redeemPairing('/api', 'abcd efgh', fetchImpl as unknown as typeof fetch)
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/v1/pairing/redeem')
    const b = sent(fetchImpl as never)
    expect(b.code).toBe('ABCD-EFGH')
    expect(b.secret).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(cfg).toEqual({ apiBase: '/api', deviceToken: `tzd.${TENANT}.${b.deviceId}.${b.secret}`, deviceId: b.deviceId, storeId: STORE, tenantId: TENANT })
    expect(localStorage.getItem('tarazu.pairing.pending')).toBeNull()
  })

  it('retries a lost response with the same device id and secret, so the server can answer it again', async () => {
    const lost = vi.fn(async () => {
      throw new TypeError('network down')
    })
    await expect(redeemPairing('/api', 'ABCD-EFGH', lost as unknown as typeof fetch)).rejects.toThrow('network down')
    const pending = JSON.parse(localStorage.getItem('tarazu.pairing.pending') ?? 'null')
    expect(pending).toMatchObject({ code: 'ABCD-EFGH' })
    const ok = vi.fn(async (_u: string, init?: RequestInit) => {
      const b = JSON.parse(init!.body as string)
      return reply(200, { tenantId: TENANT, deviceId: b.deviceId, storeId: STORE, token: `tzd.${TENANT}.${b.deviceId}.${b.secret}` })
    })
    await redeemPairing('/api', 'abcd efgh', ok as unknown as typeof fetch)
    expect(sent(ok as never)).toEqual(pending)
    expect(localStorage.getItem('tarazu.pairing.pending')).toBeNull()
  })

  it('keeps the attempt across a network failure and a 5xx or 429, but drops it once the server refuses for good', async () => {
    const seen: string[] = []
    const answers = [() => reply(503, { code: 'x' }), () => reply(429, { code: 'too_many_requests' }), () => reply(404, { code: 'pairing_invalid' })]
    const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => {
      seen.push(JSON.parse(init!.body as string).deviceId)
      return answers[seen.length - 1]()
    })
    for (let i = 0; i < 3; i++) await expect(redeemPairing('/api', 'ABCD-EFGH', fetchImpl as unknown as typeof fetch)).rejects.toBeInstanceOf(ApiProblem)
    expect(new Set(seen).size).toBe(1) // same device id each time
    expect(localStorage.getItem('tarazu.pairing.pending')).toBeNull()
  })

  it('surfaces the server code and refuses input that is not a pairing code without calling the server', async () => {
    const fetchImpl = vi.fn()
    await expect(redeemPairing('/api', 'tzd.nope', fetchImpl as unknown as typeof fetch)).rejects.toMatchObject({ code: 'pairing_invalid' })
    expect(fetchImpl).not.toHaveBeenCalled()
    const used = vi.fn(async () => reply(409, { code: 'pairing_used', detail: 'used' }))
    await expect(redeemPairing('/api', 'ABCD-EFGH', used as unknown as typeof fetch)).rejects.toMatchObject({ status: 409, code: 'pairing_used' })
  })
})

describe('createPairing', () => {
  const config = { apiBase: '/api', deviceToken: 'tzd.t.d.s', storeId: STORE }
  const owner = { userId: '22222222-2222-4222-8222-222222222222', pin: '4821' }

  it('sends the device token, the owner and the PIN, and returns the code', async () => {
    const f = vi.fn(async () => reply(201, { code: 'ABCD-EFGH', expiresAt: '2026-01-01T00:10:00Z', storeId: STORE, label: 'Counter 2' }))
    const made = await createPairing(config, owner, ' Counter 2 ', f as unknown as typeof fetch)
    expect(made.code).toBe('ABCD-EFGH')
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/v1/identity/device-pairings')
    expect(init.headers).toMatchObject({ Authorization: 'Bearer tzd.t.d.s', 'X-Staff-Id': owner.userId, 'X-Staff-Pin': '4821' })
    expect(JSON.parse(init.body as string)).toEqual({ storeId: STORE, label: 'Counter 2' })
  })

  it('leaves the label out when blank and passes the server refusal on', async () => {
    const f = vi.fn(async () => reply(401, { code: 'invalid_pin', detail: 'Wrong staff id or PIN' }))
    await expect(createPairing(config, owner, '  ', f as unknown as typeof fetch)).rejects.toMatchObject({ status: 401, code: 'invalid_pin' })
    expect(JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ storeId: STORE })
  })
})
