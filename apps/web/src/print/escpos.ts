import { matrixToBitmap, emptyBitmap, getPixel, rowBytes, setPixel, type Bitmap } from './bitmap'
import { byteFor, CODEPAGE_ESC_T, type Codepage } from './codepages'
import { rowText, type ReceiptLayout } from './receipt'

/**
 * ESC/POS encoder. Pure: every function returns bytes. Thermal printers have only Latin code pages built in, so
 * Devanagari (Hindi) cannot be printed natively: such receipts MUST go through encodeReceiptRaster (a bitmap rendered
 * with system fonts by rasterize.ts). encodeReceiptText is only for receipts where needsRaster() is false.
 */
export type { Codepage } from './codepages'

const ESC = 0x1b
const GS = 0x1d
const LF = 0x0a

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
const u8 = (...b: number[]) => Uint8Array.from(b)

/** ESC @ : reset the printer. */
export const init = (): Uint8Array => u8(ESC, 0x40)
/** ESC t n : select character code page. */
export const selectCodepage = (cp: Codepage): Uint8Array => u8(ESC, 0x74, CODEPAGE_ESC_T[cp])
/** ESC a n : 0 left, 1 center, 2 right. */
export const align = (a: 'left' | 'center' | 'right'): Uint8Array => u8(ESC, 0x61, a === 'left' ? 0 : a === 'center' ? 1 : 2)
/** ESC E n : emphasis. */
export const bold = (on: boolean): Uint8Array => u8(ESC, 0x45, on ? 1 : 0)
/** GS ! n : character size, width and height multipliers 1..8. */
export const size = (w: number, h: number): Uint8Array => {
  if (w < 1 || w > 8 || h < 1 || h > 8) throw new RangeError('size multipliers are 1..8')
  return u8(GS, 0x21, ((w - 1) << 4) | (h - 1))
}
export const doubleSize = (): Uint8Array => size(2, 2)
export const normalSize = (): Uint8Array => size(1, 1)
/** ESC d n : print and feed n lines. */
export const feed = (n: number): Uint8Array => u8(ESC, 0x64, Math.max(0, Math.min(255, n)))
export const lineFeed = (): Uint8Array => u8(LF)
/** GS V m : cut. partial = 1, full = 0. */
export const cut = (partial = true): Uint8Array => u8(GS, 0x56, partial ? 1 : 0)

const TRANSLIT: Record<string, string> = {
  '₹': 'Rs', '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...', '•': '*', '×': 'x',
  ' ': ' ', '₨': 'Rs', '‐': '-', '‑': '-', '′': "'", '″': '"',
}

/** Bytes for one code point in the page, with safe replacement; never returns control bytes. */
function encodeChar(ch: string, cp: Codepage): number[] {
  const code = ch.codePointAt(0)!
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return [0x20] // controls (ESC, GS, NUL, CR...) become a space
  const direct = byteFor(cp, code)
  if (direct >= 0) return [direct]
  const t = TRANSLIT[ch]
  if (t !== undefined) return [...t].map((c) => byteFor(cp, c.codePointAt(0)!)).map((b) => (b >= 0 ? b : 0x3f))
  const base = ch.normalize('NFD').replace(/\p{M}/gu, '')
  if (base && base !== ch) {
    const bs: number[] = []
    for (const c of base) {
      const b = byteFor(cp, c.codePointAt(0)!)
      bs.push(b >= 0 ? b : 0x3f)
    }
    return bs
  }
  if (/^\p{M}$/u.test(ch)) return [] // stray combining mark: drop
  return [0x3f]
}

/** Encode text for the page. Control characters (incl. ESC/GS/newlines) are replaced by spaces; unknown chars by '?'. */
export function encodeText(text: string, cp: Codepage = 'cp858'): Uint8Array {
  const bytes: number[] = []
  for (const ch of text) bytes.push(...encodeChar(ch, cp))
  return Uint8Array.from(bytes)
}

/** True when the text uses scripts the Latin pages cannot print (Devanagari, Gurmukhi, Gujarati...). */
export function needsRasterText(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (c <= 0x24f) continue
    if (c >= 0x2000 && c <= 0x206f) continue // general punctuation
    if (c >= 0x20a0 && c <= 0x20cf) continue // currency symbols
    if (c >= 0x2500 && c <= 0x25ff) continue // box drawing
    if (c >= 0x0300 && c <= 0x036f) continue // Latin combining accents
    return true
  }
  return false
}

export function layoutNeedsRaster(layout: ReceiptLayout): boolean {
  return layout.blocks.some((b) => b.kind === 'row' && needsRasterText(rowText(b)))
}

export interface QrNativeOptions {
  /** Module size in dots, 1..16. */
  moduleSize?: number
  ecc?: 'L' | 'M' | 'Q' | 'H'
}

/** Native QR: GS ( k model 2, size, ECC, store data, print. `data` is stored by length, so any bytes are safe. */
export function qrNative(data: string, opts: QrNativeOptions = {}): Uint8Array {
  const payload = new TextEncoder().encode(data)
  if (payload.length === 0 || payload.length > 7000) throw new RangeError('QR payload must be 1..7000 bytes')
  const moduleSize = Math.max(1, Math.min(16, opts.moduleSize ?? 6))
  const ecc = { L: 48, M: 49, Q: 50, H: 51 }[opts.ecc ?? 'M']
  const len = payload.length + 3
  return concat([
    u8(GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00), // model 2
    u8(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, moduleSize),
    u8(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, ecc),
    u8(GS, 0x28, 0x6b, len & 0xff, len >> 8, 0x31, 0x50, 0x30),
    payload,
    u8(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30), // print stored symbol
  ])
}

/** GS v 0 raster bitmap, split into bands of at most `bandRows` rows (cheap printers overflow on tall single images). */
export function rasterBitmap(b: Bitmap, bandRows = 128): Uint8Array {
  const stride = rowBytes(b.widthPx)
  const parts: Uint8Array[] = []
  for (let y = 0; y < b.heightPx; y += bandRows) {
    const h = Math.min(bandRows, b.heightPx - y)
    parts.push(u8(GS, 0x76, 0x30, 0x00, stride & 0xff, stride >> 8, h & 0xff, h >> 8))
    parts.push(b.data.subarray(y * stride, (y + h) * stride))
  }
  return concat(parts)
}

/** Split a byte stream into chunks of at most `size` bytes (for slow links); never returns empty chunks. */
export function chunkBytes(bytes: Uint8Array, chunkSize: number): Uint8Array[] {
  if (chunkSize < 1) throw new RangeError('chunk size must be >= 1')
  const out: Uint8Array[] = []
  for (let i = 0; i < bytes.length; i += chunkSize) out.push(bytes.subarray(i, Math.min(bytes.length, i + chunkSize)))
  return out
}

/** Centre a (narrower) bitmap on a canvas `widthPx` wide. */
function centerOn(b: Bitmap, widthPx: number): Bitmap {
  if (b.widthPx >= widthPx) return b
  const out = emptyBitmap(widthPx, b.heightPx)
  const dx = Math.floor((widthPx - b.widthPx) / 2)
  for (let y = 0; y < b.heightPx; y++) for (let x = 0; x < b.widthPx; x++) if (getPixel(b, x, y)) setPixel(out, x + dx, y)
  return out
}

export interface TextEncodeOptions {
  codepage?: Codepage
  /** Cut after printing (default true). */
  cut?: boolean
  /** Fixed QR module size in dots; default derived from the matrix and paper width. */
  qrModuleSize?: number
}

/** All-Latin receipt as native text. Use layoutNeedsRaster() first; non-Latin glyphs would come out as '?'. */
export function encodeReceiptText(layout: ReceiptLayout, opts: TextEncodeOptions = {}): Uint8Array {
  const cp = opts.codepage ?? 'cp858'
  const parts: Uint8Array[] = [init(), selectCodepage(cp)]
  let isBold = false
  let isDouble = false
  const setStyle = (b: boolean, d: boolean) => {
    if (b !== isBold) parts.push(bold(b))
    if (d !== isDouble) parts.push(d ? doubleSize() : normalSize())
    isBold = b
    isDouble = d
  }
  for (const blk of layout.blocks) {
    if (blk.kind === 'row') {
      setStyle(blk.bold, blk.scale === 2)
      parts.push(encodeText(rowText(blk), cp), lineFeed())
    } else if (blk.kind === 'rule') {
      setStyle(false, false)
      parts.push(encodeText(blk.char.repeat(layout.cols), cp), lineFeed())
    } else if (blk.kind === 'qr') {
      setStyle(false, false)
      parts.push(align('center'))
      const n = blk.matrix.length
      if (blk.data !== null) {
        const moduleSize = opts.qrModuleSize ?? Math.max(1, Math.min(8, Math.floor(layout.dots / (n + 8))))
        parts.push(qrNative(blk.data, { moduleSize }), lineFeed())
      } else {
        const dots = opts.qrModuleSize ?? Math.max(1, Math.floor(layout.dots / (n + 4)))
        parts.push(rasterBitmap(centerOn(matrixToBitmap(blk.matrix, dots), layout.dots)), lineFeed())
      }
      parts.push(align('left'))
    } else {
      setStyle(false, false)
      parts.push(feed(blk.lines))
    }
  }
  setStyle(false, false)
  if (opts.cut !== false) parts.push(feed(2), cut(true))
  return concat(parts)
}

/** Whole receipt as one raster image (the path for Hindi and any non-Latin text). */
export function encodeReceiptRaster(bitmap: Bitmap, opts: { cut?: boolean; bandRows?: number } = {}): Uint8Array {
  const parts = [init(), align('left'), rasterBitmap(bitmap, opts.bandRows), feed(3)]
  if (opts.cut !== false) parts.push(cut(true))
  return concat(parts)
}
