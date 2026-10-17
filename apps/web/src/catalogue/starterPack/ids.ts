import type { StoreType } from './types'

/** cyrb128: small deterministic 128-bit string hash (sync, no crypto needed; ids only have to be stable and well spread). */
function hash128(str: string): [number, number, number, number] {
  let h1 = 1779033703
  let h2 = 3144134277
  let h3 = 1013904242
  let h4 = 2773480762
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i)
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067)
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233)
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213)
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179)
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067)
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233)
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213)
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179)
  h1 ^= h2 ^ h3 ^ h4
  h2 ^= h1
  h3 ^= h1
  h4 ^= h1
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0]
}

/** UUID-shaped id (version nibble 8 = custom, RFC 4122 variant) derived only from the seed text. */
export function deterministicUuid(seed: string): string {
  const hex = hash128(seed).map((n) => n.toString(16).padStart(8, '0')).join('')
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export function starterProductId(type: StoreType, packSku: string): string {
  return deterministicUuid(`tarazu/starter/${type}/${packSku}`)
}

export function starterPriceId(type: StoreType, packSku: string, priceType: 'mrp' | 'retail'): string {
  return deterministicUuid(`tarazu/starter/${type}/${packSku}/price/${priceType}`)
}
