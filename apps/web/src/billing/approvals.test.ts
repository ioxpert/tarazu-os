// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { makeSchemaDb } from '../sync/schemaDb'
import { cacheApprovers, MAX_PIN_FAILURES, MAX_VERIFIER_AGE_MS, PIN_LOCK_MS, verifyOwnerPin, verifyOwnerPinGuarded } from './approvals'

// Independent vectors: python3 hashlib.pbkdf2_hmac('sha256', b'1234', b'tarazu-test-salt', N, 32), base64.
const SALT = 'dGFyYXp1LXRlc3Qtc2FsdA==' // b'tarazu-test-salt'
const HASH_600K = 'pKJ1WBsh7r7gtyOuKBcZIENkmhppDVNMBfXWiS3SBNk='
const HASH_1K = '15kLm5ofQL18qxTv+pBzk8lFsgQy8K/oOBhbChX8RNU='
const OWNER = '44444444-4444-4444-8444-444444444444'
const OTHER = '55555555-5555-4555-8555-555555555555'

describe('verifyOwnerPin', () => {
  it('reports no_approvers_cached on a device that never fetched them', async () => {
    const { db } = await makeSchemaDb()
    expect(await verifyOwnerPin(db, null, '1234')).toEqual({ ok: false, error: 'no_approvers_cached' })
  })

  it('accepts the right PIN (fast 1,000-iteration vector) and rejects wrong ones', async () => {
    const { db } = await makeSchemaDb()
    await cacheApprovers(db, [{ userId: OWNER, displayName: 'Owner', pinSalt: SALT, pinHash: HASH_1K, iterations: 1000 }])
    expect(await verifyOwnerPin(db, null, '1234')).toEqual({ ok: true, approverUserId: OWNER, displayName: 'Owner' })
    expect(await verifyOwnerPin(db, OWNER, '1234')).toMatchObject({ ok: true, approverUserId: OWNER })
    expect(await verifyOwnerPin(db, null, '1235')).toEqual({ ok: false, error: 'wrong_pin' })
    expect(await verifyOwnerPin(db, null, '')).toEqual({ ok: false, error: 'wrong_pin' })
    expect(await verifyOwnerPin(db, OTHER, '1234')).toEqual({ ok: false, error: 'wrong_pin' })
  })

  it('matches the production-strength vector (600,000 iterations)', async () => {
    const { db } = await makeSchemaDb()
    await cacheApprovers(db, [{ userId: OWNER, displayName: 'Owner', pinSalt: SALT, pinHash: HASH_600K, iterations: 600000 }])
    expect((await verifyOwnerPin(db, null, '1234')).ok).toBe(true)
    expect((await verifyOwnerPin(db, null, '4321')).ok).toBe(false)
  }, 30_000)

  it('tries every cached owner when no user is named; refresh replaces the cache', async () => {
    const { db } = await makeSchemaDb()
    await cacheApprovers(db, [
      { userId: OTHER, displayName: 'Partner', pinSalt: SALT, pinHash: HASH_600K.replace('p', 'q'), iterations: 1000 },
      { userId: OWNER, displayName: 'Owner', pinSalt: SALT, pinHash: HASH_1K, iterations: 1000 },
    ])
    expect(await verifyOwnerPin(db, null, '1234')).toMatchObject({ ok: true, approverUserId: OWNER })
    await cacheApprovers(db, [])
    expect(await verifyOwnerPin(db, null, '1234')).toEqual({ ok: false, error: 'no_approvers_cached' })
  })

  it('never touches the network', async () => {
    const { db } = await makeSchemaDb()
    await cacheApprovers(db, [{ userId: OWNER, displayName: 'Owner', pinSalt: SALT, pinHash: HASH_1K, iterations: 1000 }])
    const orig = globalThis.fetch
    globalThis.fetch = (() => {
      throw new Error('network used')
    }) as typeof fetch
    try {
      expect((await verifyOwnerPin(db, null, '1234')).ok).toBe(true)
    } finally {
      globalThis.fetch = orig
    }
  })

  it('skips rows with garbage parameters instead of throwing', async () => {
    const { db } = await makeSchemaDb()
    await cacheApprovers(db, [
      { userId: OTHER, displayName: 'Bad', pinSalt: '%%%', pinHash: '%%%', iterations: 1000 },
      { userId: OWNER, displayName: 'Bad2', pinSalt: SALT, pinHash: HASH_1K, iterations: 0 },
    ])
    expect(await verifyOwnerPin(db, null, '1234')).toEqual({ ok: false, error: 'wrong_pin' })
  })
})

describe('verifyOwnerPinGuarded', () => {
  const T0 = Date.UTC(2026, 9, 17, 10, 0, 0)
  const setup = async () => {
    const { db } = await makeSchemaDb()
    await cacheApprovers(db, [{ userId: OWNER, displayName: 'Owner', pinSalt: SALT, pinHash: HASH_1K, iterations: 1000 }], T0)
    return db
  }

  it('locks approval on this device for 15 minutes after five wrong PINs, even for the right PIN', async () => {
    const db = await setup()
    for (let i = 0; i < MAX_PIN_FAILURES - 1; i++) {
      expect(await verifyOwnerPinGuarded(db, null, '0000', T0 + i)).toEqual({ ok: false, error: 'wrong_pin' })
    }
    const fifth = await verifyOwnerPinGuarded(db, null, '0000', T0 + 10)
    expect(fifth).toEqual({ ok: false, error: 'locked', lockedUntil: T0 + 10 + PIN_LOCK_MS })
    expect(await verifyOwnerPinGuarded(db, null, '1234', T0 + 1000)).toMatchObject({ ok: false, error: 'locked' })
    expect(await verifyOwnerPinGuarded(db, null, '1234', T0 + 10 + PIN_LOCK_MS + 1)).toMatchObject({ ok: true, approverUserId: OWNER })
  })

  it('a correct PIN resets the failure count', async () => {
    const db = await setup()
    for (let i = 0; i < 4; i++) await verifyOwnerPinGuarded(db, null, '0000', T0)
    expect((await verifyOwnerPinGuarded(db, null, '1234', T0)).ok).toBe(true)
    for (let i = 0; i < 4; i++) expect(await verifyOwnerPinGuarded(db, null, '0000', T0)).toEqual({ ok: false, error: 'wrong_pin' })
  })

  it('does not trust verifiers older than 30 days', async () => {
    const db = await setup()
    expect(await verifyOwnerPinGuarded(db, null, '1234', T0 + MAX_VERIFIER_AGE_MS + 1)).toEqual({ ok: false, error: 'approvers_stale' })
    expect((await verifyOwnerPinGuarded(db, null, '1234', T0 + MAX_VERIFIER_AGE_MS - 1)).ok).toBe(true)
  })

  it('still says no_approvers_cached on a device that never fetched, without counting a failure', async () => {
    const { db } = await makeSchemaDb()
    for (let i = 0; i < 6; i++) expect(await verifyOwnerPinGuarded(db, null, '1234', T0)).toEqual({ ok: false, error: 'no_approvers_cached' })
  })
})
