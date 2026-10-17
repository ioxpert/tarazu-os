import { describe, expect, it } from 'vitest'
import { evaluateDiscount, needsBackdateApproval } from './discount'
import { priceCart } from './calc'
import { DEFAULT_POLICY, loadPolicy, savePolicy } from './policy'
import { makeSchemaDb } from '../sync/schemaDb'
import { defaultProfile, getJson, getState, loadProfile, saveProfile, setJson } from './settings'
import { line } from './testKit'

describe('settings', () => {
  it('round-trips the profile over defaults', async () => {
    const { db } = await makeSchemaDb()
    expect(await loadProfile(db)).toEqual(defaultProfile())
    expect(defaultProfile().gstMode).toBe('non_gst')
    const p = { ...defaultProfile(), businessName: 'Sharma Store', gstMode: 'regular' as const, gstin: '27ABCDE1234F1Z5', upiVpa: 'sharma@okhdfc' }
    await saveProfile(db, p)
    expect(await loadProfile(db)).toEqual(p)
    // an older stored profile missing newer fields still loads fully
    await setJson(db, 'profile', { businessName: 'Old' })
    expect(await loadProfile(db)).toEqual({ ...defaultProfile(), businessName: 'Old' })
  })
  it('validates the profile', async () => {
    const { db } = await makeSchemaDb()
    await expect(saveProfile(db, { ...defaultProfile(), gstMode: 'regular' })).rejects.toThrow(/invalid_profile/)
    await expect(saveProfile(db, { ...defaultProfile(), gstin: 'bad' })).rejects.toThrow(/invalid_profile/)
    await expect(saveProfile(db, { ...defaultProfile(), upiVpa: 'bad' })).rejects.toThrow(/invalid_vpa/)
    expect(await getState(db, 'profile')).toBeNull()
  })
  it('tolerates corrupt JSON', async () => {
    const { db } = await makeSchemaDb()
    await db.execute("INSERT INTO device_state (id, value) VALUES ('profile', '{nope')")
    expect(await getJson(db, 'profile')).toBeNull()
    expect(await loadProfile(db)).toEqual(defaultProfile())
  })
})

describe('policy and discount evaluation', () => {
  const CTX = { gstMode: 'non_gst' as const, rounding: 'none' as const, onDate: '2026-10-17' }
  it('policy defaults to 5% and persists', async () => {
    const { db } = await makeSchemaDb()
    expect(await loadPolicy(db)).toEqual(DEFAULT_POLICY)
    expect(DEFAULT_POLICY.maxCashierDiscountBp).toBe(500)
    await savePolicy(db, { maxCashierDiscountBp: 1000, requireApprovalBackdate: false })
    expect(await loadPolicy(db)).toEqual({ maxCashierDiscountBp: 1000, requireApprovalBackdate: false })
    await expect(savePolicy(db, { maxCashierDiscountBp: 10001, requireApprovalBackdate: true })).rejects.toThrow()
  })
  it('exactly at the limit needs no approval; one paisa above does', () => {
    const lines = [line({ qtyMilli: 1000, unitPricePaise: 100000 })]
    const at = priceCart({ lines, billDiscount: { kind: 'amount', paise: 5000 } }, CTX)
    expect(evaluateDiscount(at, DEFAULT_POLICY)).toEqual({ totalDiscountPaise: 5000, percentBp: 500, needsApproval: false })
    const over = priceCart({ lines, billDiscount: { kind: 'amount', paise: 5001 } }, CTX)
    expect(evaluateDiscount(over, DEFAULT_POLICY)).toMatchObject({ totalDiscountPaise: 5001, needsApproval: true, percentBp: 500 })
  })
  it('line and bill discounts are summed against the bill gross', () => {
    const lines = [line({ qtyMilli: 1000, unitPricePaise: 60000, discount: { kind: 'percent', bp: 1000 } }), line({ qtyMilli: 1000, unitPricePaise: 40000 })]
    const b = priceCart({ lines, billDiscount: { kind: 'amount', paise: 1000 } }, CTX)
    expect(evaluateDiscount(b, { maxCashierDiscountBp: 700 })).toEqual({ totalDiscountPaise: 7000, percentBp: 700, needsApproval: false })
    expect(evaluateDiscount(b, { maxCashierDiscountBp: 699 }).needsApproval).toBe(true)
  })
  it('no discount, empty bill, zero policy', () => {
    const b = priceCart({ lines: [line({ qtyMilli: 1000, unitPricePaise: 100 })], billDiscount: null }, CTX)
    expect(evaluateDiscount(b, DEFAULT_POLICY)).toEqual({ totalDiscountPaise: 0, percentBp: 0, needsApproval: false })
    expect(evaluateDiscount({ lines: [] }, DEFAULT_POLICY).needsApproval).toBe(false)
    const d = priceCart({ lines: [line({ qtyMilli: 1000, unitPricePaise: 100 })], billDiscount: { kind: 'amount', paise: 1 } }, CTX)
    expect(evaluateDiscount(d, { maxCashierDiscountBp: 0 }).needsApproval).toBe(true)
  })
  it('back-dated bills', () => {
    expect(needsBackdateApproval('2026-10-16', '2026-10-17', { requireApprovalBackdate: true })).toBe(true)
    expect(needsBackdateApproval('2026-10-17', '2026-10-17', { requireApprovalBackdate: true })).toBe(false)
    expect(needsBackdateApproval('2026-10-16', '2026-10-17', { requireApprovalBackdate: false })).toBe(false)
  })
})
