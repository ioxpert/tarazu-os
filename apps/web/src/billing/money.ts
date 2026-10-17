import { BillingError } from './errors'

/** Integer-only money helpers. Money is integer paise; nothing here ever produces a float. */

export function assertSafe(n: number, what = 'amount'): number {
  if (!Number.isSafeInteger(n)) throw new BillingError('amount_overflow', `${what} is not a safe integer: ${n}`)
  return n
}

/**
 * round(n / d), halves away from zero. n and d must be safe integers, d > 0. Uses the exact remainder, never a float
 * quotient, so the result is right for every safe n.
 */
export function divRoundHalfUp(n: number, d: number): number {
  assertSafe(n, 'numerator')
  assertSafe(d, 'denominator')
  if (d <= 0) throw new BillingError('amount_overflow', 'denominator must be positive')
  const sign = n < 0 ? -1 : 1
  const abs = Math.abs(n)
  const r = abs % d
  let q = (abs - r) / d
  if (r >= d - r) q += 1 // r * 2 >= d without risking overflow
  return sign * q
}

/**
 * round(a * b / d) half-up. When a * b would leave the safe-integer range the product is formed in BigInt; the
 * RESULT must still be a safe integer or this throws 'amount_overflow'.
 */
export function mulDiv(a: number, b: number, d: number): number {
  assertSafe(a, 'a')
  assertSafe(b, 'b')
  assertSafe(d, 'd')
  if (d <= 0) throw new BillingError('amount_overflow', 'divisor must be positive')
  const product = a * b
  if (Number.isSafeInteger(product)) return divRoundHalfUp(product, d)
  const p = BigInt(a) * BigInt(b)
  const neg = p < 0n
  const abs = neg ? -p : p
  const bd = BigInt(d)
  const r = abs % bd
  let q = abs / bd
  if (r * 2n >= bd) q += 1n
  const out = Number(neg ? -q : q)
  return assertSafe(out, 'result')
}
