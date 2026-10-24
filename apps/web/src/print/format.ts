import type { Unit } from '../catalogue/types'

/** Tiny formatting helpers private to the print chunk (kept apart from lib/numfmt so print has no startup coupling). */

/** Indian digit grouping of a non-negative integer string: 1234567 -> 12,34,567. */
export function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits
  const head = digits.slice(0, -3)
  const tail = digits.slice(-3)
  return head.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + tail
}

/** Paise -> "12,34,567.50" (always two decimals, '-' prefix when negative). No currency symbol: CP437 has no rupee sign. */
export function formatRupees(paise: number): string {
  if (!Number.isSafeInteger(paise)) throw new RangeError('paise must be a safe integer')
  const neg = paise < 0
  const abs = Math.abs(paise)
  const rupees = Math.floor(abs / 100)
  const frac = String(abs % 100).padStart(2, '0')
  return `${neg ? '-' : ''}${groupIndian(String(rupees))}.${frac}`
}

/** Basis points -> "18", "2.5", "0.25". */
export function formatRate(bp: number): string {
  const whole = Math.trunc(bp / 100)
  const frac = Math.abs(bp % 100)
  if (frac === 0) return String(whole)
  return `${whole}.${String(frac).padStart(2, '0').replace(/0+$/, '')}`
}

const SHORT: Record<Unit, string> = {
  piece: '',
  packet: 'pkt',
  strip: 'strip',
  bottle: 'btl',
  dozen: 'dz',
  kg: 'kg',
  g: 'g',
  litre: 'L',
  ml: 'ml',
  bag: 'bag',
  box: 'box',
  case: 'case',
  carton: 'ctn',
  bundle: 'bndl',
  quintal: 'qtl',
}

/** Milli-units -> "2", "1.5kg", "0.25L" (up to 3 decimals, trailing zeros trimmed, short unit suffix; pieces have none). */
export function formatQty(qtyMilli: number, unit: Unit): string {
  const neg = qtyMilli < 0
  const abs = Math.abs(qtyMilli)
  const whole = Math.floor(abs / 1000)
  const frac = String(abs % 1000).padStart(3, '0').replace(/0+$/, '')
  const num = `${neg ? '-' : ''}${groupIndian(String(whole))}${frac ? '.' + frac : ''}`
  return num + SHORT[unit]
}

/** Terminal width of one code point: combining marks (Devanagari matras, virama) take no column. */
function cpWidth(ch: string): number {
  return /^\p{M}$/u.test(ch) ? 0 : 1
}

/** Display width in monospace columns. */
export function textWidth(s: string): number {
  let w = 0
  for (const ch of s) w += cpWidth(ch)
  return w
}

/** Cut to at most `width` columns (never splits a base character from its marks). */
export function clip(s: string, width: number): string {
  let w = 0
  let out = ''
  for (const ch of s) {
    const cw = cpWidth(ch)
    if (w + cw > width) break
    w += cw
    out += ch
  }
  return out
}

export function padRight(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - textWidth(s)))
}
export function padLeft(s: string, width: number): string {
  return ' '.repeat(Math.max(0, width - textWidth(s))) + s
}
export function padCenter(s: string, width: number): string {
  const gap = Math.max(0, width - textWidth(s))
  const left = Math.floor(gap / 2)
  return ' '.repeat(left) + s + ' '.repeat(gap - left)
}

/**
 * Wrap on spaces to `width` columns; words longer than a line are hard-split. Every returned line has
 * textWidth <= width, and at least one (possibly empty) line is returned.
 */
export function wrapText(text: string, width: number): string[] {
  if (width < 1) throw new RangeError('width must be >= 1')
  const lines: string[] = []
  // control characters (incl. newlines and ESC/GS) become spaces so user text can never inject structure
  const words = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').split(/ +/).filter((w) => w.length > 0)
  let cur = ''
  for (let word of words) {
    while (textWidth(word) > width) {
      if (cur) {
        lines.push(cur)
        cur = ''
      }
      const head = clip(word, width)
      lines.push(head)
      word = word.slice(head.length)
    }
    if (!word) continue
    if (cur === '') cur = word
    else if (textWidth(cur) + 1 + textWidth(word) <= width) cur += ' ' + word
    else {
      lines.push(cur)
      cur = word
    }
  }
  if (cur || lines.length === 0) lines.push(cur)
  return lines
}
