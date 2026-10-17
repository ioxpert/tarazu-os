import type { components } from '../api/schema'
import type { LocalDb } from '../sync/schemaDb'

export type ApproverFromApi = components['schemas']['Approver']

export type VerifyResult =
  | { ok: true; approverUserId: string; displayName: string }
  | { ok: false; error: 'wrong_pin' | 'no_approvers_cached' }

/** Replace the cached approvers with the list from GET /v1/identity/approvers (device-local table, not an op). */
export async function cacheApprovers(db: LocalDb, approvers: readonly ApproverFromApi[], now: Date | number = Date.now()): Promise<void> {
  const fetchedAt = new Date(now).toISOString()
  await db.writeTransaction(async (tx) => {
    await tx.execute('DELETE FROM approver')
    for (const a of approvers) {
      await tx.execute(
        'INSERT OR REPLACE INTO approver (id, display_name, pin_salt, pin_hash, iterations, fetched_at) VALUES (?, ?, ?, ?, ?, ?)',
        [a.userId, a.displayName, a.pinSalt, a.pinHash, a.iterations, fetchedAt],
      )
    }
  })
}

interface ApproverRow {
  id: string
  display_name: string
  pin_salt: string
  pin_hash: string
  iterations: number
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const bin = atob(text)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** PBKDF2-HMAC-SHA256(utf8(pin), salt, iterations) -> 32 bytes, via WebCrypto (the same recipe as the server). */
export async function derivePinHash(pin: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256)
  return new Uint8Array(bits)
}

function equalConstantTime(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

const MAX_ITERATIONS = 5_000_000

/**
 * Check an owner PIN against the cached verifiers. `userId` limits the check to that approver; null tries every
 * cached owner (the first match is the approver). Fully offline: no fetch. 'no_approvers_cached' means the device
 * has never fetched approvers (the UI says "connect once to enable approvals").
 */
export async function verifyOwnerPin(db: Pick<LocalDb, 'getAll'>, userId: string | null, pin: string): Promise<VerifyResult> {
  const all = await db.getAll<ApproverRow>('SELECT id, display_name, pin_salt, pin_hash, iterations FROM approver')
  if (all.length === 0) return { ok: false, error: 'no_approvers_cached' }
  const candidates = userId === null ? all : all.filter((a) => a.id === userId)
  if (pin.length === 0) return { ok: false, error: 'wrong_pin' }
  for (const a of candidates) {
    const iterations = Number(a.iterations)
    if (!Number.isInteger(iterations) || iterations < 1 || iterations > MAX_ITERATIONS) continue
    let expected: Uint8Array
    let salt: Uint8Array<ArrayBuffer>
    try {
      expected = fromBase64(a.pin_hash)
      salt = fromBase64(a.pin_salt)
    } catch {
      continue
    }
    const actual = await derivePinHash(pin, salt, iterations)
    if (equalConstantTime(actual, expected)) return { ok: true, approverUserId: a.id, displayName: a.display_name }
  }
  return { ok: false, error: 'wrong_pin' }
}
