import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { assertSafeCardReference, looksLikePan, luhnValid } from './card'
import { qrMatrix } from './qr'
import { buildUpiUri, isValidVpa, upiAmount } from './upi'

describe('buildUpiUri', () => {
  it('builds a dynamic link with exactly two decimals and fixed parameter order', () => {
    expect(buildUpiUri({ vpa: 'sharma.store@okhdfc', name: 'Sharma Store', amountPaise: 123456, note: 'Bill A1B2C3D4/2026-27/17' })).toBe(
      'upi://pay?pa=sharma.store@okhdfc&pn=Sharma%20Store&am=1234.56&cu=INR&tn=Bill%20A1B2C3D4%2F2026-27%2F17',
    )
    expect(buildUpiUri({ vpa: 'ab@upi', name: 'A', amountPaise: 500 })).toBe('upi://pay?pa=ab@upi&pn=A&am=5.00&cu=INR')
    expect(buildUpiUri({ vpa: 'ab@upi', name: 'A', amountPaise: 5 })).toContain('am=0.05')
    expect(buildUpiUri({ vpa: 'ab@upi', name: 'A', amountPaise: 1_00_00_000 })).toContain('am=100000.00')
  })
  it('static link has no amount', () => {
    const u = buildUpiUri({ vpa: 'shop-1@ybl', name: 'Kirana & Co' })
    expect(u).toBe('upi://pay?pa=shop-1@ybl&pn=Kirana%20%26%20Co&cu=INR')
    expect(u).not.toContain('am=')
  })
  it('encodes awkward names and notes so the query cannot be broken', () => {
    const u = buildUpiUri({ vpa: 'ab@upi', name: 'A&pa=evil@x', amountPaise: 100, note: 'x=1&am=1' })
    expect(new URL(u.replace('upi://', 'https://')).searchParams.getAll('pa')).toEqual(['ab@upi'])
    expect(new URL(u.replace('upi://', 'https://')).searchParams.get('pn')).toBe('A&pa=evil@x')
    expect(new URL(u.replace('upi://', 'https://')).searchParams.getAll('am')).toEqual(['1.00'])
    expect(new URL(u.replace('upi://', 'https://')).searchParams.get('tn')).toBe('x=1&am=1')
  })
  it('validates the VPA against the contract pattern', () => {
    for (const bad of ['', 'a@', '@upi', 'a b@upi', 'a@up1', 'x@y', 'a@@upi', 'a@upi.com', 'ab'])
      expect(() => buildUpiUri({ vpa: bad, name: 'A' }), bad).toThrow(/invalid_vpa/)
    expect(isValidVpa('9876543210@paytm')).toBe(true)
  })
  it('rejects non-positive or fractional amounts', () => {
    for (const a of [0, -1, 1.5, NaN]) expect(() => buildUpiUri({ vpa: 'ab@upi', name: 'A', amountPaise: a })).toThrow(/invalid_amount/)
  })
  it('amount text is always rupees.2dp and parses back to the paise', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 9_000_000_000_000 }), (p) => {
        const t = upiAmount(p)
        expect(t).toMatch(/^\d+\.\d{2}$/)
        expect(Math.round(Number(t) * 100)).toBe(p)
      }),
    )
  })
})

describe('qrMatrix', () => {
  it('returns a square boolean matrix with finder patterns', () => {
    const m = qrMatrix(buildUpiUri({ vpa: 'ab@upi', name: 'A', amountPaise: 100 }))
    expect(m.length).toBeGreaterThanOrEqual(21)
    expect(m.every((r) => r.length === m.length)).toBe(true)
    expect(m.every((r) => r.every((c) => typeof c === 'boolean'))).toBe(true)
    // top-left finder: 7x7 ring, dark corners
    expect([m[0][0], m[0][6], m[6][0], m[6][6], m[3][3]]).toEqual([true, true, true, true, true])
    expect(m[1][1]).toBe(false)
    const n = m.length
    expect([m[0][n - 1], m[n - 1][0]]).toEqual([true, true])
  })
  it('is deterministic and grows with content', () => {
    expect(qrMatrix('hello')).toEqual(qrMatrix('hello'))
    expect(qrMatrix('x'.repeat(200)).length).toBeGreaterThan(qrMatrix('x').length)
  })
})

describe('card reference safety', () => {
  it('luhn', () => {
    expect(luhnValid('4111111111111111')).toBe(true)
    expect(luhnValid('4111111111111112')).toBe(false)
    expect(luhnValid('79927398713')).toBe(true)
  })
  it('rejects a full PAN in any common formatting, accepts last-4 and approval codes', () => {
    for (const pan of ['4111111111111111', '4111 1111 1111 1111', '4111-1111-1111-1111', '5500005555555559', '378282246310005', '6011111111111117', '3530111333300000', '6200000000000005'])
      expect(() => assertSafeCardReference(pan), pan).toThrow(/card_reference_looks_like_pan/)
    expect(assertSafeCardReference('1111')).toBe('1111')
    expect(assertSafeCardReference('AUTH-483920')).toBe('AUTH-483920')
    expect(assertSafeCardReference('  ')).toBeNull()
    expect(assertSafeCardReference(null)).toBeNull()
    expect(assertSafeCardReference('412345678901')).toBe('412345678901') // 12 digits: a terminal RRN, not a PAN
    expect(looksLikePan('4111111111111112')).toBe(false) // 16 digits but fails Luhn
  })
  it('every Luhn-valid 13-19 digit number is refused', () => {
    const body = fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 12, maxLength: 18 })
    fc.assert(
      fc.property(body, (digits) => {
        const partial = digits.join('')
        let check = 0
        for (let c = 0; c < 10; c++) if (luhnValid(partial + c)) check = c
        expect(looksLikePan(partial + check)).toBe(true)
        expect(() => assertSafeCardReference(partial + check)).toThrow()
      }),
      { numRuns: 500 },
    )
  })
})
