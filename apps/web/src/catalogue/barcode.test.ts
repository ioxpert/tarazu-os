import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { barcodeKey, classifyBarcode, isEan13Valid, normalizeBarcode, upcEToUpcA } from './barcode'

function ean13With(body12: string): string {
  let sum = 0
  for (let i = 0; i < 12; i++) sum += Number(body12[i]) * (i % 2 === 0 ? 1 : 3)
  return body12 + String((10 - (sum % 10)) % 10)
}

describe('normalizeBarcode', () => {
  it('strips whitespace, control chars and the AIM prefix', () => {
    expect(normalizeBarcode(' 8901 063\r\n')).toBe('8901063')
    expect(normalizeBarcode(']E08901063092280')).toBe('8901063092280')
    expect(normalizeBarcode(']C112345678')).toBe('12345678')
    expect(normalizeBarcode('\u001d4006381333931')).toBe('4006381333931')
  })
})

describe('classifyBarcode', () => {
  it('validates real EAN-13 codes and flags India (890)', () => {
    const c = classifyBarcode('4006381333931')
    expect(c).toMatchObject({ kind: 'ean13', status: 'valid', checksum: 'ok', originIndia: false, gs1Prefix: '400' })
    const india = ean13With('890106309228')
    expect(classifyBarcode(india)).toMatchObject({ kind: 'ean13', status: 'valid', originIndia: true, gs1Prefix: '890' })
  })
  it('reports a bad checksum but still accepts it', () => {
    const c = classifyBarcode('4006381333932')
    expect(c).toMatchObject({ status: 'bad_checksum', checksum: 'bad', accepted: true })
  })
  it('EAN-8, UPC-A, UPC-E, GTIN-14', () => {
    expect(classifyBarcode('96385074')).toMatchObject({ kind: 'ean8', status: 'valid' })
    expect(classifyBarcode('036000291452')).toMatchObject({ kind: 'upca', status: 'valid' })
    expect(upcEToUpcA('01234565')).toBe('012345000065')
    expect(classifyBarcode('01234565').status).toBe('valid')
    expect(classifyBarcode('01234505')).toMatchObject({ kind: 'upce', status: 'valid' })
    expect(classifyBarcode('10012345678902')).toMatchObject({ kind: 'gtin14', status: 'valid' })
    expect(classifyBarcode('10012345678903').status).toBe('bad_checksum')
  })
  it('accepts shop codes of 4-14 digits and rejects the rest', () => {
    for (const c of ['1234', '12345', '1234567', '123456789']) {
      expect(classifyBarcode(c)).toMatchObject({ kind: 'internal', status: 'internal', checksum: 'n/a', accepted: true })
    }
    for (const c of ['', '123', 'ABC123', '123456789012345', '12-34']) expect(classifyBarcode(c).accepted).toBe(false)
  })
  it('every generated EAN-13 validates; flipping the check digit breaks it (property)', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[0-9]{12}$/), (body) => {
        const code = ean13With(body)
        expect(isEan13Valid(code)).toBe(true)
        const bad = body + String((Number(code[12]) + 1) % 10)
        expect(isEan13Valid(bad)).toBe(false)
        expect(classifyBarcode(bad).status).toBe('bad_checksum')
      }),
    )
  })
  it('barcodeKey equates UPC-A and its EAN-13 form', () => {
    expect(barcodeKey('036000291452')).toBe(barcodeKey('0036000291452'))
    expect(barcodeKey(' 12345 ')).toBe('12345')
    expect(barcodeKey('0012')).toBe('0012')
  })
})
