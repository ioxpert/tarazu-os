import type { LocalDb } from '../sync/schemaDb'

/** One row of the synced `tax_rule` table (server TaxRules). Dates are 'YYYY-MM-DD' (a longer ISO text is cut to 10). */
export interface TaxRule {
  hsnPrefix: string
  rateBp: number
  cessBp: number
  effectiveFrom: string
  description?: string | null
}

const HSN = /^[0-9]{2,8}$/

/**
 * Same semantics as the server's TaxRules.resolve: the HSN must be 2-8 digits; among rules whose prefix the HSN
 * starts with and whose effective_from <= onDate, the LONGEST prefix wins, then the LATEST effective_from. A longer
 * prefix that is not yet effective does not shadow a shorter one that is. onDate is 'YYYY-MM-DD'.
 */
export function resolveTaxRule(rules: readonly TaxRule[], hsn: string | null | undefined, onDate: string): TaxRule | null {
  if (hsn == null || !HSN.test(hsn)) return null
  const day = onDate.slice(0, 10)
  let best: TaxRule | null = null
  for (const r of rules) {
    if (!hsn.startsWith(r.hsnPrefix)) continue
    if (r.effectiveFrom.slice(0, 10) > day) continue
    if (
      best === null ||
      r.hsnPrefix.length > best.hsnPrefix.length ||
      (r.hsnPrefix.length === best.hsnPrefix.length && r.effectiveFrom.slice(0, 10) > best.effectiveFrom.slice(0, 10))
    ) {
      best = r
    }
  }
  return best
}

interface TaxRuleRow {
  hsn_prefix: string
  description: string | null
  rate_bp: number
  cess_bp: number | null
  effective_from: string
}

export async function loadTaxRules(db: Pick<LocalDb, 'getAll'>): Promise<TaxRule[]> {
  const rows = await db.getAll<TaxRuleRow>(
    'SELECT hsn_prefix, description, rate_bp, cess_bp, effective_from FROM tax_rule',
  )
  return rows.map((r) => ({
    hsnPrefix: r.hsn_prefix,
    description: r.description,
    rateBp: Number(r.rate_bp),
    cessBp: Number(r.cess_bp ?? 0),
    effectiveFrom: r.effective_from,
  }))
}

/** Convenience: load the rules and resolve one HSN. Prefer loading once and calling the list form per cart. */
export async function resolveTaxRuleFromDb(
  db: Pick<LocalDb, 'getAll'>,
  hsn: string | null | undefined,
  onDate: string,
): Promise<TaxRule | null> {
  return resolveTaxRule(await loadTaxRules(db), hsn, onDate)
}

/** Rate for one item: the server rule when one resolves, else the merchant's own rate on the item, else none. */
export function resolveLineTax(
  item: { hsn: string | null; taxRateBp: number | null },
  rules: readonly TaxRule[],
  onDate: string,
): { rateBp: number; source: 'rule' | 'item' | 'none' } {
  const rule = resolveTaxRule(rules, item.hsn, onDate)
  if (rule) return { rateBp: rule.rateBp, source: 'rule' }
  if (item.taxRateBp != null) return { rateBp: item.taxRateBp, source: 'item' }
  return { rateBp: 0, source: 'none' }
}
