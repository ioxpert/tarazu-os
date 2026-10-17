import { describe, expect, it } from 'vitest'
import { makeSchemaDb } from '../sync/schemaDb'
import { loadTaxRules, resolveLineTax, resolveTaxRule, resolveTaxRuleFromDb, type TaxRule } from './tax'

const rule = (hsnPrefix: string, rateBp: number, effectiveFrom: string): TaxRule => ({ hsnPrefix, rateBp, cessBp: 0, effectiveFrom })

describe('resolveTaxRule (mirrors server TaxRules.resolve)', () => {
  const rules = [
    rule('10', 0, '2017-07-01'),
    rule('1006', 500, '2017-07-01'),
    rule('1006', 1200, '2026-12-01'),
    rule('100610', 2800, '2027-01-01'),
  ]
  it('longest effective prefix wins, then latest effective_from', () => {
    expect(resolveTaxRule(rules, '10061010', '2026-10-17')?.rateBp).toBe(500)
    expect(resolveTaxRule(rules, '10061010', '2026-12-01')?.rateBp).toBe(1200)
    expect(resolveTaxRule(rules, '10061010', '2027-01-01')?.rateBp).toBe(2800)
    expect(resolveTaxRule(rules, '10019000', '2026-10-17')?.rateBp).toBe(0)
  })
  it('a not-yet-effective longer prefix does not shadow a shorter one', () => {
    expect(resolveTaxRule(rules, '10061010', '2026-12-31')?.rateBp).toBe(1200)
  })
  it('effective_from is inclusive and nothing before the first rule resolves', () => {
    expect(resolveTaxRule(rules, '1006', '2017-07-01')?.rateBp).toBe(500)
    expect(resolveTaxRule(rules, '1006', '2017-06-30')).toBeNull()
  })
  it('rejects malformed HSN like the server (2-8 digits only)', () => {
    for (const h of [null, undefined, '', '1', '123456789', '10a6', '10 06'])
      expect(resolveTaxRule(rules, h, '2026-10-17'), String(h)).toBeNull()
    expect(resolveTaxRule(rules, '10', '2026-10-17')?.rateBp).toBe(0)
  })
  it('accepts a timestamp for the date (only the day counts)', () => {
    expect(resolveTaxRule(rules, '1006', '2026-12-01T00:00:00Z')?.rateBp).toBe(1200)
  })
})

describe('resolveLineTax', () => {
  const rules = [rule('1006', 500, '2017-07-01')]
  it('rule > item > none', () => {
    expect(resolveLineTax({ hsn: '1006', taxRateBp: 1800 }, rules, '2026-10-17')).toEqual({ rateBp: 500, source: 'rule' })
    expect(resolveLineTax({ hsn: null, taxRateBp: 1800 }, rules, '2026-10-17')).toEqual({ rateBp: 1800, source: 'item' })
    expect(resolveLineTax({ hsn: null, taxRateBp: null }, rules, '2026-10-17')).toEqual({ rateBp: 0, source: 'none' })
  })
})

describe('loadTaxRules', () => {
  it('reads the synced tax_rule table', async () => {
    const { sqlite, db } = await makeSchemaDb()
    sqlite.exec(`INSERT INTO tax_rule (id, hsn_prefix, description, rate_bp, cess_bp, effective_from, notification_ref)
      VALUES ('1','1905','Biscuits',1800,0,'2017-07-01',NULL), ('2','1905','Biscuits',500,0,'2026-12-01',NULL)`)
    const rules = await loadTaxRules(db)
    expect(rules).toHaveLength(2)
    expect((await resolveTaxRuleFromDb(db, '19053100', '2026-10-17'))?.rateBp).toBe(1800)
    expect((await resolveTaxRuleFromDb(db, '19053100', '2026-12-02'))?.rateBp).toBe(500)
  })
})
