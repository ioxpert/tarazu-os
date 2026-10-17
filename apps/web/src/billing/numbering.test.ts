import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { OpLogWriter } from '../sync/oplog'
import { makeSchemaDb } from '../sync/schemaDb'
import { allocateNumber, creditNoteSeries, documentLabel, financialYear, invoiceSeries, istDate, peekNextNumber, seriesPrefix } from './numbering'

const DEVICE = 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d'

describe('financial year / IST date', () => {
  it('rolls over on 1 April', () => {
    expect(financialYear('2026-03-31')).toBe('2025-26')
    expect(financialYear('2026-04-01')).toBe('2026-27')
    expect(financialYear('2026-10-17')).toBe('2026-27')
    expect(financialYear('2027-03-31')).toBe('2026-27')
    expect(financialYear('2099-12-31')).toBe('2099-00')
  })
  it('IST is UTC+5:30', () => {
    expect(istDate(Date.parse('2026-10-17T18:29:59Z'))).toBe('2026-10-17')
    expect(istDate(Date.parse('2026-10-17T18:30:00Z'))).toBe('2026-10-18')
    expect(istDate(new Date('2027-03-31T18:30:00Z'))).toBe('2027-04-01')
  })
  it('every date maps to a FY that contains it', () => {
    fc.assert(
      fc.property(fc.date({ min: new Date('2000-01-01'), max: new Date('2060-01-01'), noInvalidDate: true }), (d) => {
        const date = istDate(d)
        const fy = financialYear(date)
        const start = Number(fy.slice(0, 4))
        expect(date >= `${start}-04-01` && date <= `${start + 1}-03-31`).toBe(true)
      }),
    )
  })
})

describe('series and labels', () => {
  it('builds series and display labels', () => {
    expect(seriesPrefix(DEVICE)).toBe('A1B2C3D4')
    expect(invoiceSeries(DEVICE, '2026-27')).toBe('A1B2C3D4-2026-27')
    expect(creditNoteSeries(DEVICE, '2026-27')).toBe('A1B2C3D4-CN-2026-27')
    expect(documentLabel('A1B2C3D4-2026-27', 17)).toBe('A1B2C3D4/2026-27/17')
    expect(documentLabel('A1B2C3D4-CN-2026-27', 3)).toBe('A1B2C3D4/CN/2026-27/3')
    expect(documentLabel('C1-2026-27', 5)).toBe('C1-2026-27/5')
  })
})

describe('allocateNumber', () => {
  it('is sequential per series, independent across series, and rolled back with the transaction', async () => {
    const { db } = await makeSchemaDb()
    const writer = new OpLogWriter(db, { deviceId: DEVICE, storeId: '11111111-1111-4111-8111-111111111111' })
    const seen: number[] = []
    await writer.writeAllWith(async (tx) => {
      seen.push(await allocateNumber(tx, 'S1'), await allocateNumber(tx, 'S1'), await allocateNumber(tx, 'S2'))
      return []
    })
    expect(seen).toEqual([1, 2, 1])
    expect(await peekNextNumber(db, 'S1')).toBe(3)
    await expect(
      writer.writeAllWith(async (tx) => {
        await allocateNumber(tx, 'S1')
        throw new Error('x')
      }),
    ).rejects.toThrow('x')
    expect(await peekNextNumber(db, 'S1')).toBe(3)
    expect(await db.writeTransaction((tx) => allocateNumber(tx, 'S1'))).toBe(3)
  })
})
