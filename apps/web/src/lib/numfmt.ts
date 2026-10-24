import type { Unit } from '../catalogue/types'

/** Group the digits of a non-negative integer string the Indian way: 1234567 -> 12,34,567. */
export function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits
  const tail = digits.slice(-3)
  const head = digits.slice(0, -3)
  return head.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + tail
}

export interface RupeeFormatOptions {
  /** Currency prefix. Default the rupee sign; pass 'Rs ' for thermal printers without the glyph, '' for none. */
  symbol?: string
  /** 'always' (default) keeps two decimals; 'auto' drops ".00" on whole rupees (a non-whole amount always shows paise). */
  paise?: 'auto' | 'always'
}

/** formatRupees(123456750) = '₹12,34,567.50'. Negative amounts render as '-₹1,234.00'. */
export function formatRupees(paise: number, opts: RupeeFormatOptions = {}): string {
  if (!Number.isSafeInteger(paise)) throw new RangeError('paise must be a safe integer')
  const symbol = opts.symbol ?? '₹'
  const mode = opts.paise ?? 'always'
  const abs = Math.abs(paise)
  const rupees = Math.floor(abs / 100)
  const frac = abs % 100
  const whole = groupIndian(String(rupees))
  const showFrac = mode === 'always' || frac !== 0
  const text = showFrac ? `${whole}.${String(frac).padStart(2, '0')}` : whole
  return `${paise < 0 ? '-' : ''}${symbol}${text}`
}

const UNIT_ABBR: Record<Unit, string> = {
  piece: 'pc',
  packet: 'pkt',
  strip: 'strip',
  bottle: 'btl',
  dozen: 'doz',
  kg: 'kg',
  g: 'g',
  litre: 'L',
  ml: 'ml',
  bag: 'bag',
  box: 'box',
  case: 'case',
  carton: 'ctn',
  bundle: 'bdl',
  quintal: 'qtl',
}

/** Milli-units as a plain number text: 1500 -> '1.5', 12000 -> '12', 250 -> '0.25'. At most 3 decimals, trimmed. */
export function formatQtyNumber(milli: number): string {
  if (!Number.isSafeInteger(milli)) throw new RangeError('milli must be a safe integer')
  const abs = Math.abs(milli)
  const whole = Math.floor(abs / 1000)
  const frac = String(abs % 1000)
    .padStart(3, '0')
    .replace(/0+$/, '')
  return `${milli < 0 ? '-' : ''}${groupIndian(String(whole))}${frac ? '.' + frac : ''}`
}

/** formatQty(1500, 'kg') = '1.5 kg'. The unit is the universal abbreviation, not translated text. */
export function formatQty(milli: number, unit: Unit): string {
  return `${formatQtyNumber(milli)} ${UNIT_ABBR[unit]}`
}

const GROUPED = /^(\d{1,3}(,\d{3})+|\d{1,2}(,\d{2})+,\d{3})$/

/**
 * Strict rupee text -> paise, or null when it is not a clean amount. Accepts an optional leading rupee sign or "Rs",
 * digits with optional valid Indian/western comma grouping, and at most two decimals. Rejects empty, negative,
 * ".5", "5.", "1,2", "1.234", "1e3", letters and anything beyond a safe integer.
 */
export function parseRupeesToPaise(text: string): number | null {
  let t = text.trim().replace(/^(₹|rs\.?)\s*/i, '')
  if (t === '') return null
  const dot = t.indexOf('.')
  let fracText = ''
  if (dot >= 0) {
    fracText = t.slice(dot + 1)
    t = t.slice(0, dot)
    if (!/^\d{1,2}$/.test(fracText)) return null
  }
  if (!(/^\d+$/.test(t) || GROUPED.test(t))) return null
  const whole = t.replace(/,/g, '')
  if (whole.length > 14) return null
  const rupees = Number(whole)
  const frac = fracText === '' ? 0 : Number(fracText.padEnd(2, '0'))
  const paise = rupees * 100 + frac
  return Number.isSafeInteger(paise) ? paise : null
}
