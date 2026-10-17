/** RFC 9562 UUIDv7: 48-bit unix millis, version 7, 74 random bits. Operation ids sort by creation time. */

let lastMs = 0

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n))
}

/**
 * The timestamp never goes backwards inside one JS realm: if the wall clock steps back (or two ids are minted
 * in the same millisecond) the previous millisecond plus one is used, so ids from one device sort in creation order.
 */
export function uuidv7(nowMs: number = Date.now()): string {
  const ms = Math.max(nowMs, lastMs + 1)
  lastMs = ms
  const b = randomBytes(16)
  b[0] = Math.floor(ms / 2 ** 40) & 0xff
  b[1] = Math.floor(ms / 2 ** 32) & 0xff
  b[2] = Math.floor(ms / 2 ** 24) & 0xff
  b[3] = Math.floor(ms / 2 ** 16) & 0xff
  b[4] = Math.floor(ms / 2 ** 8) & 0xff
  b[5] = ms & 0xff
  b[6] = (b[6] & 0x0f) | 0x70
  b[8] = (b[8] & 0x3f) | 0x80
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isUuidV7(value: string): boolean {
  return V7.test(value)
}

/** Millisecond timestamp encoded in a UUIDv7. */
export function uuidv7Time(id: string): number {
  return parseInt(id.replace(/-/g, '').slice(0, 12), 16)
}
