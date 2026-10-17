import fc from 'fast-check'
import { clip, formatQty, formatRate, formatRupees, groupIndian, padLeft, textWidth, wrapText } from './format'

describe('formatRupees', () => {
  it.each([
    [0, '0.00'], [5, '0.05'], [100, '1.00'], [99999, '999.99'], [100000, '1,000.00'], [123456750, '12,34,567.50'],
    [-250, '-2.50'], [1000000000, '1,00,00,000.00'],
  ])('%i -> %s', (p, s) => expect(formatRupees(p)).toBe(s))
  it('groups like an Indian ledger', () => {
    expect(groupIndian('1234567')).toBe('12,34,567')
    expect(groupIndian('123')).toBe('123')
  })
  it('rejects non-integers', () => expect(() => formatRupees(1.5)).toThrow())
  it('round-trips', () =>
    fc.assert(
      fc.property(fc.integer({ min: -1e12, max: 1e12 }), (p) => {
        const s = formatRupees(p).replace(/,/g, '')
        return Math.round(parseFloat(s) * 100) === p
      }),
    ))
})

describe('formatQty / formatRate', () => {
  it('formats by unit', () => {
    expect(formatQty(2000, 'piece')).toBe('2')
    expect(formatQty(1500, 'kg')).toBe('1.5kg')
    expect(formatQty(250, 'litre')).toBe('0.25L')
    expect(formatQty(12000, 'packet')).toBe('12pkt')
    expect(formatQty(1234, 'g')).toBe('1.234g')
  })
  it('formats rates', () => {
    expect(formatRate(1800)).toBe('18')
    expect(formatRate(250)).toBe('2.5')
    expect(formatRate(25)).toBe('0.25')
  })
})

describe('width helpers', () => {
  it('counts combining marks as zero width', () => {
    expect(textWidth('कि')).toBe(1)
    expect(textWidth('abc')).toBe(3)
    expect(clip('abcdef', 3)).toBe('abc')
    expect(padLeft('ab', 4)).toBe('  ab')
  })
  it('strips control chars when wrapping', () => {
    expect(wrapText('a\x1bb\nc', 10)).toEqual(['a b c'])
  })
  it('wrapping never exceeds width and keeps all non-space characters', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), fc.integer({ min: 4, max: 48 }), (s, w) => {
        const lines = wrapText(s, w)
        const joined = lines.join('').replace(/\s/g, '')
        const orig = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s/g, '')
        return lines.length >= 1 && lines.every((l) => textWidth(l) <= w) && joined === orig
      }),
    )
  })
})
