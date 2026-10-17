import type { LocalDb } from '../sync/schemaDb'
import { getJson, type StateReader } from './settings'

export interface BillingPolicy {
  /** Largest total discount a cashier may give without owner approval, in basis points of the bill gross (500 = 5%). */
  maxCashierDiscountBp: number
  /** A bill dated before today needs owner approval. */
  requireApprovalBackdate: boolean
}

export const POLICY_KEY = 'policy'
export const DEFAULT_POLICY: BillingPolicy = { maxCashierDiscountBp: 500, requireApprovalBackdate: true }

export async function loadPolicy(db: StateReader): Promise<BillingPolicy> {
  const stored = await getJson<Partial<BillingPolicy>>(db, POLICY_KEY)
  const bp = stored?.maxCashierDiscountBp
  return {
    maxCashierDiscountBp: typeof bp === 'number' && Number.isInteger(bp) && bp >= 0 && bp <= 10000 ? bp : DEFAULT_POLICY.maxCashierDiscountBp,
    requireApprovalBackdate:
      typeof stored?.requireApprovalBackdate === 'boolean' ? stored.requireApprovalBackdate : DEFAULT_POLICY.requireApprovalBackdate,
  }
}

export async function savePolicy(db: LocalDb, policy: BillingPolicy): Promise<void> {
  if (!Number.isInteger(policy.maxCashierDiscountBp) || policy.maxCashierDiscountBp < 0 || policy.maxCashierDiscountBp > 10000) {
    throw new RangeError('maxCashierDiscountBp must be an integer 0..10000')
  }
  await db.execute('INSERT OR REPLACE INTO device_state (id, value) VALUES (?, ?)', [POLICY_KEY, JSON.stringify(policy)])
}
