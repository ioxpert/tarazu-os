import { ApiProblem } from '../auth/api'
import type { components } from '../api/schema'
import type { SyncConfig } from './config'

/**
 * Pairing a counter with a short one-time code the owner made (docs/adr/0015). The counter picks its own device id and
 * 256-bit secret and sends them with the code, so a lost response is safe to retry: the same three values get the same
 * answer. The pending attempt is kept until the server answers for good, so a reload mid-request retries with the same values.
 */
type Paired = components['schemas']['Paired']

const PENDING_KEY = 'tarazu.pairing.pending'
/** Same alphabet as the server: no 0, O, 1, I. */
const CODE = /^[A-HJ-NP-Z2-9]{8}$/i
/** The server ignores case, spaces and dashes, so does the client. */
const squash = (text: string) => text.replace(/[\s-]/g, '')

export function looksLikePairingCode(text: string): boolean {
  return CODE.test(squash(text))
}

/** `ABCD-EFGH`: what the server normalises to, so a retry is recognised as the same code however it was typed. */
export function normalisePairingCode(text: string): string | null {
  const c = squash(text)
  return CODE.test(c) ? `${c.slice(0, 4)}-${c.slice(4)}`.toUpperCase() : null
}

interface Pending {
  code: string
  deviceId: string
  secret: string
}

function newSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function loadPending(): Pending | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY)
    return raw ? (JSON.parse(raw) as Pending) : null
  } catch {
    return null
  }
}

function savePending(p: Pending): void {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(p))
  } catch {
    /* storage unavailable: a retry after a reload picks fresh values, and the owner makes a new code */
  }
}

function clearPending(): void {
  try {
    localStorage.removeItem(PENDING_KEY)
  } catch {
    /* nothing to clear */
  }
}

/** Trades the code for this device's credential. Throws ApiProblem for a server refusal, anything else for a network failure. */
export async function redeemPairing(apiBase: string, rawCode: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<SyncConfig> {
  const code = normalisePairingCode(rawCode)
  if (!code) throw new ApiProblem(404, 'pairing_invalid', 'Not a pairing code')
  const earlier = loadPending()
  const attempt: Pending = earlier && earlier.code === code ? earlier : { code, deviceId: crypto.randomUUID(), secret: newSecret() }
  savePending(attempt)
  const res = await fetchImpl(`${apiBase}/v1/pairing/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: attempt.code, deviceId: attempt.deviceId, secret: attempt.secret }),
  })
  if (!res.ok) {
    let problem: { code?: string; detail?: string } = {}
    try {
      problem = (await res.json()) as typeof problem
    } catch {
      /* not json */
    }
    // the server answered for good (wrong, expired, used, malformed): these values are spent. 429/5xx may succeed later.
    if (res.status >= 400 && res.status < 500 && res.status !== 429) clearPending()
    throw new ApiProblem(res.status, problem.code ?? String(res.status), problem.detail ?? `Request failed (${res.status})`)
  }
  const paired = (await res.json()) as Paired
  clearPending()
  return { apiBase, deviceToken: paired.token, deviceId: paired.deviceId, storeId: paired.storeId, tenantId: paired.tenantId }
}

export type PairingCreated = components['schemas']['PairingCreated']

/**
 * Owner side: asks the server for a code another counter can type. Runs from a paired counter (device credential) and
 * names the acting owner with their PIN, which the server checks and rate-limits (ADR 0004/0008). Online only.
 */
export async function createPairing(
  config: Pick<SyncConfig, 'apiBase' | 'deviceToken' | 'storeId'>,
  owner: { userId: string; pin: string },
  label: string,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): Promise<PairingCreated> {
  const res = await fetchImpl(`${config.apiBase}/v1/identity/device-pairings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.deviceToken}`,
      'X-Staff-Id': owner.userId,
      'X-Staff-Pin': owner.pin,
    },
    body: JSON.stringify({ storeId: config.storeId, label: label.trim() || undefined }),
  })
  if (!res.ok) {
    let problem: { code?: string; detail?: string } = {}
    try {
      problem = (await res.json()) as typeof problem
    } catch {
      /* not json */
    }
    throw new ApiProblem(res.status, problem.code ?? String(res.status), problem.detail ?? `Request failed (${res.status})`)
  }
  return (await res.json()) as PairingCreated
}
