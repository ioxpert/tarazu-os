import fc from 'fast-check'
import type { ReceiptData } from '../billing/types'
import { compositionBill, creditNote, dummyQr, hindiSale, longNames, plainSale, splitCreditSale } from './fixtures'
import { textWidth } from './format'
import { buildReceiptLayout, layoutLines, rowText, type ReceiptLayout } from './receipt'

const text = (d: ReceiptData, widthMm: 58 | 80, lang: 'en' | 'hi' | 'en+hi' = 'en', extra = {}) =>
  layoutLines(buildReceiptLayout(d, { widthMm, lang, ...extra })).join('\n') + '\n'

describe('receipt layout snapshots', () => {
  const cases: Array<[string, ReceiptData]> = [
    ['plain sale', plainSale],
    ['discounted split-tender with credit', splitCreditSale],
    ['composition bill of supply', compositionBill],
    ['credit note', creditNote],
    ['long item names', longNames],
  ]
  for (const [name, data] of cases) {
    for (const w of [58, 80] as const) {
      it(`${name} @${w}mm`, () => expect(text(data, w, 'en', name.startsWith('discounted') ? { qrMatrix: dummyQr, qrAmountPaise: 7800 } : {})).toMatchSnapshot())
    }
  }
  it('Hindi names, hi @80mm', () => expect(text(hindiSale, 80, 'hi')).toMatchSnapshot())
  it('Hindi names, en+hi @58mm', () => expect(text(hindiSale, 58, 'en+hi')).toMatchSnapshot())
})

describe('receipt layout rules', () => {
  it('column counts follow the paper', () => {
    const a = buildReceiptLayout(plainSale, { widthMm: 58, lang: 'en' })
    const b = buildReceiptLayout(plainSale, { widthMm: 80, lang: 'en' })
    expect([a.cols, a.dots, b.cols, b.dots]).toEqual([32, 384, 48, 576])
  })
  it('58 mm drops the tax table to one compact line; 80 mm keeps it', () => {
    const n58 = buildReceiptLayout(plainSale, { widthMm: 58, lang: 'en' }).blocks.filter((b) => b.kind === 'row' && (b.role === 'taxhead'))
    const n80 = buildReceiptLayout(plainSale, { widthMm: 80, lang: 'en' }).blocks.filter((b) => b.kind === 'row' && b.role === 'taxhead')
    expect(n58).toHaveLength(0)
    expect(n80).toHaveLength(1)
    expect(text(plainSale, 58)).toContain('GST: 5% 10.71, 18% 12.13')
  })
  it('composition bill has no tax lines and carries the composition note', () => {
    const t = text(compositionBill, 80)
    expect(t).toMatch(/Bill of Supply/)
    expect(t).toMatch(/Composition taxable person/)
    expect(t).not.toMatch(/CGST|SGST/)
  })
  it('total is double size and bold; owes row is bold', () => {
    const l = buildReceiptLayout(splitCreditSale, { widthMm: 80, lang: 'en' })
    const total = l.blocks.find((b) => b.kind === 'row' && b.role === 'total')
    const owes = l.blocks.find((b) => b.kind === 'row' && b.role === 'owes')
    expect(total).toMatchObject({ scale: 2, bold: true })
    expect(owes).toMatchObject({ bold: true })
  })
  it('QR block only for sales with a matrix; carries the raw data when given', () => {
    expect(buildReceiptLayout(plainSale, { widthMm: 58, lang: 'en' }).blocks.some((b) => b.kind === 'qr')).toBe(false)
    expect(buildReceiptLayout(creditNote, { widthMm: 58, lang: 'en', qrMatrix: dummyQr }).blocks.some((b) => b.kind === 'qr')).toBe(false)
    const l = buildReceiptLayout(plainSale, { widthMm: 58, lang: 'en', qrMatrix: dummyQr, qrData: 'upi://pay?pa=x', staticQr: true })
    expect(l.blocks.find((b) => b.kind === 'qr')).toMatchObject({ data: 'upi://pay?pa=x' })
    expect(layoutLines(l).join('\n')).toContain('sharma@upi')
  })
  it('dates are IST regardless of timezone', () => expect(text(plainSale, 58)).toContain('17-10-2026 14:35'))
})

const arbLine = fc.record({
  name: fc.string({ minLength: 1, maxLength: 90 }),
  localName: fc.option(fc.string({ maxLength: 40 }), { nil: null }),
  qtyMilli: fc.integer({ min: 1, max: 999_999 }),
  unit: fc.constantFrom('piece', 'kg', 'g', 'litre', 'packet', 'case') as fc.Arbitrary<'piece'>,
  unitPricePaise: fc.integer({ min: 1, max: 9_999_00 }),
  discountPaise: fc.integer({ min: 0, max: 50_00 }),
  taxRateBp: fc.constantFrom(0, 500, 1800),
  lineTotalPaise: fc.integer({ min: 1, max: 9_999_999 }),
})
const arbData = fc.record({
  lines: fc.array(arbLine, { minLength: 1, maxLength: 12 }),
  totalPaise: fc.integer({ min: 0, max: 99_999_999 }),
  creditPaise: fc.integer({ min: 0, max: 99_999 }),
  name: fc.string({ maxLength: 60 }),
}).map(({ lines, totalPaise, creditPaise, name }): ReceiptData => ({
  ...splitCreditSale, business: { ...splitCreditSale.business, businessName: name }, lines, totalPaise, creditPaise,
}))

describe('layout properties', () => {
  it('no line exceeds the column width; amounts stay right-aligned', () =>
    fc.assert(
      fc.property(arbData, fc.constantFrom(58, 80) as fc.Arbitrary<58 | 80>, fc.constantFrom('en', 'hi', 'en+hi') as fc.Arbitrary<'en'>, (d, w, lang) => {
        const l: ReceiptLayout = buildReceiptLayout(d, { widthMm: w, lang })
        for (const b of l.blocks) {
          if (b.kind !== 'row') continue
          const width = Math.floor(l.cols / b.scale)
          if (b.cells.reduce((s, c) => s + c.width, 0) > width) return false
          if (textWidth(rowText(b)) * b.scale > l.cols) return false
          for (const c of b.cells) if (/^-?[\d,]+\.\d\d$/.test(c.text) && c.align !== 'right') return false
        }
        return true
      }),
    ))
  it('is deterministic and the line count is stable', () =>
    fc.assert(
      fc.property(arbData, (d) => {
        const a = layoutLines(buildReceiptLayout(d, { widthMm: 58, lang: 'en' }))
        const b = layoutLines(buildReceiptLayout(d, { widthMm: 58, lang: 'en' }))
        return a.length === b.length && a.join('\n') === b.join('\n')
      }),
    ))
})
