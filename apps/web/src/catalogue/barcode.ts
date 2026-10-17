/** Barcode normalisation and classification. Kirana items often carry shop-printed codes, so ANY 4-14 digit string is accepted. */

export type BarcodeKind = 'ean13' | 'ean8' | 'upca' | 'upce' | 'gtin14' | 'internal' | 'invalid'
export type ChecksumState = 'ok' | 'bad' | 'n/a'
export type BarcodeStatus = 'valid' | 'bad_checksum' | 'internal' | 'invalid'

export interface BarcodeInfo {
  /** Normalised digits ('' when nothing usable was scanned). */
  code: string
  kind: BarcodeKind
  status: BarcodeStatus
  checksum: ChecksumState
  /** True for valid, bad_checksum and internal: the merchant may still save it (the UI warns on bad_checksum). */
  accepted: boolean
  /** GS1 prefix (first three digits) of an EAN-13, information only. */
  gs1Prefix: string | null
  /** GS1 prefix 890 = India. Information only: never used to reject or trust a code. */
  originIndia: boolean
}

/** Strips whitespace/control characters and a leading AIM symbology identifier (']E0', ']C1', ']A0'...). */
export function normalizeBarcode(raw: string): string {
  let s = raw.replace(/[\s\u0000-\u001f\u007f]/g, '')
  s = s.replace(/^\][A-Za-z][0-9A-Za-z]/, '')
  return s
}

/** GS1 mod-10 over all digits, the last being the check digit. */
function gs1Valid(digits: string): boolean {
  let sum = 0
  for (let i = 0; i < digits.length - 1; i++) {
    const d = digits.charCodeAt(digits.length - 2 - i) - 48
    sum += d * (i % 2 === 0 ? 3 : 1)
  }
  return (10 - (sum % 10)) % 10 === digits.charCodeAt(digits.length - 1) - 48
}

export const isEan13Valid = (c: string) => /^\d{13}$/.test(c) && gs1Valid(c)
export const isEan8Valid = (c: string) => /^\d{8}$/.test(c) && gs1Valid(c)
export const isUpcAValid = (c: string) => /^\d{12}$/.test(c) && gs1Valid(c)
export const isGtin14Valid = (c: string) => /^\d{14}$/.test(c) && gs1Valid(c)

/** Expands an 8-digit UPC-E (number system 0/1) to its 12-digit UPC-A form, or null. */
export function upcEToUpcA(c: string): string | null {
  if (!/^[01]\d{7}$/.test(c)) return null
  const ns = c[0]
  const m = c.slice(1, 7)
  const check = c[7]
  const last = m[5]
  let body: string
  if ('012'.includes(last)) body = m.slice(0, 2) + last + '0000' + m.slice(2, 5)
  else if (last === '3') body = m.slice(0, 3) + '00000' + m.slice(3, 5)
  else if (last === '4') body = m.slice(0, 4) + '00000' + m[4]
  else body = m.slice(0, 5) + '0000' + last
  return ns + body + check
}
export const isUpcEValid = (c: string) => {
  const a = upcEToUpcA(c)
  return a !== null && gs1Valid(a)
}

/** Key used to compare codes: UPC-A (12) and EAN-13/GTIN-14 spellings of the same GTIN share a key. */
export function barcodeKey(code: string): string {
  const c = normalizeBarcode(code)
  return c.length >= 12 && /^\d+$/.test(c) ? c.replace(/^0+/, '') : c
}

export function classifyBarcode(raw: string): BarcodeInfo {
  const code = normalizeBarcode(raw)
  const none = (kind: BarcodeKind, status: BarcodeStatus, checksum: ChecksumState, accepted: boolean): BarcodeInfo => ({
    code, kind, status, checksum, accepted, gs1Prefix: null, originIndia: false,
  })
  if (!/^\d{4,14}$/.test(code)) return none('invalid', 'invalid', 'n/a', false)
  const result = (kind: BarcodeKind, ok: boolean): BarcodeInfo => ({
    code,
    kind,
    status: ok ? 'valid' : 'bad_checksum',
    checksum: ok ? 'ok' : 'bad',
    accepted: true,
    gs1Prefix: kind === 'ean13' ? code.slice(0, 3) : null,
    originIndia: kind === 'ean13' && code.startsWith('890'),
  })
  switch (code.length) {
    case 13:
      return result('ean13', isEan13Valid(code))
    case 12:
      return result('upca', isUpcAValid(code))
    case 14:
      return result('gtin14', isGtin14Valid(code))
    case 8:
      if (isEan8Valid(code)) return result('ean8', true)
      if (isUpcEValid(code)) return result('upce', true)
      return result('ean8', false)
    default:
      return none('internal', 'internal', 'n/a', true)
  }
}
