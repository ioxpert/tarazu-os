import { describe, expect, it } from 'vitest'
import { isUuidV7, uuidv7, uuidv7Time } from './uuid7'

describe('uuidv7', () => {
  it('has version 7 and RFC variant bits', () => {
    for (let i = 0; i < 50; i++) expect(isUuidV7(uuidv7())).toBe(true)
  })

  it('rejects other versions', () => {
    expect(isUuidV7(crypto.randomUUID())).toBe(false)
    expect(isUuidV7('not-a-uuid')).toBe(false)
  })

  it('encodes the timestamp', () => {
    const t = Date.parse('2026-10-17T10:00:00.000Z') + 1_000_000
    expect(uuidv7Time(uuidv7(t))).toBeGreaterThanOrEqual(t)
  })

  it('sorts in creation order even in one millisecond and when the clock steps back', () => {
    const now = Date.now() + 10_000_000
    const ids = [uuidv7(now), uuidv7(now), uuidv7(now - 5_000), uuidv7(now + 1)]
    expect([...ids].sort()).toEqual(ids)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
