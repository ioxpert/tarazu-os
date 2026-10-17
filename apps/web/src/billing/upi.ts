import { BillingError } from './errors'
import { VPA_PATTERN } from './settings'

export interface UpiLink {
  vpa: string
  /** Payee name shown in the customer's UPI app. */
  name: string
  /** Omit for a static QR (the customer types the amount); give it for a dynamic, bill-specific QR. */
  amountPaise?: number
  /** Transaction note, e.g. the invoice label. */
  note?: string
}

export function isValidVpa(vpa: string): boolean {
  return VPA_PATTERN.test(vpa)
}

/** Paise as the exact 2-decimal rupee string UPI wants: 123456 -> '1234.56'. */
export function upiAmount(paise: number): string {
  if (!Number.isSafeInteger(paise) || paise <= 0) throw new BillingError('invalid_amount')
  return `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, '0')}`
}

const enc = (s: string) => encodeURIComponent(s)

/**
 * NPCI UPI linking: upi://pay?pa=<vpa>&pn=<name>&am=<amount>&cu=INR&tn=<note>. Parameter order is fixed; text values
 * are percent-encoded (spaces as %20, never '+'); the '@' of the VPA stays literal as in the NPCI examples. pn is cut
 * to 50 chars and tn to 80 so the QR stays small and apps do not reject it.
 */
export function buildUpiUri(link: UpiLink): string {
  if (!isValidVpa(link.vpa)) throw new BillingError('invalid_vpa')
  const name = link.name.trim().slice(0, 50)
  const parts = [`pa=${enc(link.vpa).replace('%40', '@')}`, `pn=${enc(name)}`]
  if (link.amountPaise !== undefined) parts.push(`am=${upiAmount(link.amountPaise)}`)
  parts.push('cu=INR')
  const note = link.note?.trim().slice(0, 80)
  if (note) parts.push(`tn=${enc(note)}`)
  return `upi://pay?${parts.join('&')}`
}
