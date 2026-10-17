import fc from 'fast-check'
import { emptyBitmap, setPixel } from './bitmap'
import * as E from './escpos'
import { compositionBill, dummyQr, hindiSale, plainSale, splitCreditSale } from './fixtures'
import { buildReceiptLayout, type ReceiptLayout } from './receipt'

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ')

describe('ESC/POS commands (golden hex)', () => {
  it('init / alignment / bold / size / feed / cut', () => {
    expect(hex(E.init())).toBe('1b 40')
    expect(hex(E.align('left'))).toBe('1b 61 00')
    expect(hex(E.align('center'))).toBe('1b 61 01')
    expect(hex(E.align('right'))).toBe('1b 61 02')
    expect(hex(E.bold(true))).toBe('1b 45 01')
    expect(hex(E.bold(false))).toBe('1b 45 00')
    expect(hex(E.doubleSize())).toBe('1d 21 11')
    expect(hex(E.normalSize())).toBe('1d 21 00')
    expect(hex(E.size(2, 1))).toBe('1d 21 10')
    expect(hex(E.feed(3))).toBe('1b 64 03')
    expect(hex(E.cut(true))).toBe('1d 56 01')
    expect(hex(E.cut(false))).toBe('1d 56 00')
    expect(() => E.size(9, 1)).toThrow()
  })
  it('code page selection', () => {
    expect(hex(E.selectCodepage('cp437'))).toBe('1b 74 00')
    expect(hex(E.selectCodepage('wpc1252'))).toBe('1b 74 10')
    expect(hex(E.selectCodepage('cp858'))).toBe('1b 74 13')
  })
  it('native QR: model 2, size, ECC, store, print', () => {
    expect(hex(E.qrNative('upi', { moduleSize: 6, ecc: 'M' }))).toBe(
      '1d 28 6b 04 00 31 41 32 00 ' + // model 2
        '1d 28 6b 03 00 31 43 06 ' + // module size 6
        '1d 28 6b 03 00 31 45 31 ' + // ECC M (49)
        '1d 28 6b 06 00 31 50 30 75 70 69 ' + // store "upi": pL = 3 + 3
        '1d 28 6b 03 00 31 51 30', // print
    )
  })
  it('native QR stores long payloads with a 16-bit length', () => {
    const b = E.qrNative('x'.repeat(300))
    const store = b.indexOf(0x50) // first 'P' (0x50) is the store function
    expect(b[store - 3]).toBe(303 & 0xff)
    expect(b[store - 2]).toBe(303 >> 8)
  })
  it('raster GS v 0 with width bytes and band split', () => {
    const bm = emptyBitmap(10, 3) // 2 bytes per row
    setPixel(bm, 0, 0)
    setPixel(bm, 9, 2)
    expect(hex(E.rasterBitmap(bm))).toBe('1d 76 30 00 02 00 03 00 80 00 00 00 00 40')
    const banded = E.rasterBitmap(emptyBitmap(8, 5), 2)
    expect(hex(banded)).toBe(
      '1d 76 30 00 01 00 02 00 00 00 ' + '1d 76 30 00 01 00 02 00 00 00 ' + '1d 76 30 00 01 00 01 00 00',
    )
  })
  it('chunks lines', () => {
    expect(E.chunkBytes(Uint8Array.of(1, 2, 3, 4, 5), 2).map((c) => [...c])).toEqual([[1, 2], [3, 4], [5]])
    expect(E.chunkBytes(new Uint8Array(0), 2)).toEqual([])
  })
})

describe('text encoding', () => {
  it('encodes Latin per code page', () => {
    expect(hex(E.encodeText('Café', 'cp437'))).toBe('43 61 66 82')
    expect(hex(E.encodeText('Café', 'wpc1252'))).toBe('43 61 66 e9')
    expect(hex(E.encodeText('€', 'cp858'))).toBe('d5')
    expect(hex(E.encodeText('€', 'cp437'))).toBe('3f') // not in CP437
  })
  it('replaces unsupported characters safely', () => {
    expect(new TextDecoder().decode(E.encodeText('₹100 “q” – x'))).toBe('Rs100 "q" - x')
    expect(hex(E.encodeText('ā', 'cp437'))).toBe('61') // macron stripped to base letter
    expect(hex(E.encodeText('आटा'))).toBe('3f 3f') // Devanagari: '?', matras dropped (use raster!)
    expect(hex(E.encodeText('😀'))).toBe('3f')
  })
  it('property: output is printable page bytes for every code page', () => {
    for (const cp of ['cp437', 'cp858', 'wpc1252'] as const) {
      fc.assert(fc.property(fc.string({ unit: 'binary', maxLength: 80 }), (s) => [...E.encodeText(s, cp)].every((b) => b >= 0x20 && b !== 0x7f)))
    }
  })
  it('property: ESC/GS/control bytes in user text never reach the stream', () =>
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 80 }), (s) => {
        const out = E.encodeText('\x1b@\x1d\x56\x00' + s + '\n\r\t')
        return [...out].every((b) => b >= 0x20 && b !== 0x7f && b !== 0x1b && b !== 0x1d)
      }),
    ))
  it('bytes above 0x7F come only from the selected page', () => {
    expect(hex(E.encodeText('éüñ£', 'cp858'))).toBe('82 81 a4 9c')
    expect(hex(E.encodeText('éüñ£', 'wpc1252'))).toBe('e9 fc f1 a3')
  })
})

function tiny(): ReceiptLayout {
  return {
    widthMm: 58, cols: 8, dots: 96, lang: 'en',
    blocks: [
      { kind: 'row', role: 'heading', cells: [{ text: 'Hi', width: 4, align: 'center' }], bold: true, scale: 2 },
      { kind: 'rule', char: '-' },
      { kind: 'row', role: 'kv', cells: [{ text: 'A', width: 4, align: 'left' }, { text: '1.00', width: 4, align: 'right' }], bold: false, scale: 1 },
      { kind: 'feed', lines: 1 },
    ],
  }
}

describe('receipt encoding', () => {
  it('full tiny receipt (golden hex)', () => {
    expect(hex(E.encodeReceiptText(tiny()))).toBe(
      [
        '1b 40', '1b 74 13', // init, CP858
        '1b 45 01', '1d 21 11', '20 48 69 0a', // bold + double, " Hi" (centred, right-trimmed)
        '1b 45 00', '1d 21 00', '2d 2d 2d 2d 2d 2d 2d 2d 0a', // rule of 8
        '41 20 20 20 31 2e 30 30 0a', // "A   1.00"

        '1b 64 01', '1b 64 02', '1d 56 01',
      ].join(' '),
    )
  })
  it('real receipts encode as ASCII-only text with init first and a cut last', () => {
    const bytes = E.encodeReceiptText(buildReceiptLayout(plainSale, { widthMm: 80, lang: 'en' }))
    expect(hex(bytes.subarray(0, 5))).toBe('1b 40 1b 74 13')
    expect(hex(bytes.subarray(bytes.length - 3))).toBe('1d 56 01')
    expect(E.layoutNeedsRaster(buildReceiptLayout(plainSale, { widthMm: 80, lang: 'en' }))).toBe(false)
    expect(hex(bytes)).toMatchSnapshot()
  })
  it('hostile item names cannot add ESC/GS commands', () => {
    const benign = E.encodeReceiptText(buildReceiptLayout({ ...compositionBill, lines: [{ ...compositionBill.lines[0], name: 'AAAA' }] }, { widthMm: 58, lang: 'en' }))
    const evil = E.encodeReceiptText(
      buildReceiptLayout({ ...compositionBill, lines: [{ ...compositionBill.lines[0], name: '\x1bp\x00\x19\x1d\x56\x00\x1b@' }] }, { widthMm: 58, lang: 'en' }),
    )
    const count = (b: Uint8Array) => [...b].filter((x) => x === 0x1b || x === 0x1d).length
    expect(count(evil)).toBe(count(benign))
  })
  it('QR: native when data is known, bitmap otherwise', () => {
    const native = E.encodeReceiptText(buildReceiptLayout(splitCreditSale, { widthMm: 58, lang: 'en', qrMatrix: dummyQr, qrData: 'upi://pay?pa=a@b' }))
    const hexN = hex(native)
    expect(hexN).toContain('1d 28 6b 04 00 31 41 32 00')
    expect(hexN).toContain('1d 28 6b 03 00 31 51 30')
    const bitmap = E.encodeReceiptText(buildReceiptLayout(splitCreditSale, { widthMm: 58, lang: 'en', qrMatrix: dummyQr }))
    expect(hex(bitmap)).not.toContain('1d 28 6b')
    expect(hex(bitmap)).toContain('1d 76 30 00 30 00') // 384 dots = 48 bytes wide, 1 band
  })
  it('detects text that needs the raster path', () => {
    expect(E.layoutNeedsRaster(buildReceiptLayout(hindiSale, { widthMm: 58, lang: 'hi' }))).toBe(true)
    expect(E.layoutNeedsRaster(buildReceiptLayout(plainSale, { widthMm: 58, lang: 'en+hi' }))).toBe(true)
    expect(E.needsRasterText('Rs ₹ “x” é')).toBe(false)
  })
  it('raster receipt', () => {
    const bm = emptyBitmap(16, 2)
    const out = E.encodeReceiptRaster(bm)
    expect(hex(out)).toBe('1b 40 1b 61 00 1d 76 30 00 02 00 02 00 00 00 00 00 1b 64 03 1d 56 01')
  })
})
