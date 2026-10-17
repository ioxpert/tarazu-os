import { BillingError } from './errors'

/** Luhn checksum over a digit string. */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false
  let sum = 0
  let dbl = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (dbl) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    dbl = !dbl
  }
  return sum % 10 === 0
}

/** True when the text, ignoring spaces and dashes, is a 13-19 digit Luhn-valid number: a card number (PAN). */
export function looksLikePan(text: string): boolean {
  const compact = text.replace(/[\s-]/g, '')
  return /^\d{13,19}$/.test(compact) && luhnValid(compact)
}

/**
 * Card data is never stored (PCI scope stays at the terminal). A card tender may carry only a short reference: last 4
 * digits or the terminal's approval code. Anything that looks like a full card number is refused.
 */
export function assertSafeCardReference(reference: string | null | undefined): string | null {
  if (reference == null) return null
  const ref = reference.trim()
  if (ref === '') return null
  if (looksLikePan(ref)) throw new BillingError('card_reference_looks_like_pan')
  if (ref.length > 32) throw new BillingError('invalid_tender', 'reference too long')
  return ref
}
