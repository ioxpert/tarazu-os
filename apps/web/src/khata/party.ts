import { BillingError } from '../billing/errors'
import { item, type OpLogWriter } from '../sync/oplog'
import { normalizeIndianMobile } from '../print/share'

export interface PartyPatch {
  name?: string
  /** null removes the number. Stored as 10 digits. */
  phone?: string | null
  /** Paise; null removes the limit. */
  creditLimitPaise?: number | null
}

/**
 * Changes a customer's details with ONE update op carrying only the fields that changed (the server merges field by
 * field by clock). Keeps the local party row in step in the same transaction.
 */
export async function updateCustomer(writer: OpLogWriter, partyId: string, patch: PartyPatch, actorUserId: string | null): Promise<void> {
  const payload: Record<string, unknown> = {}
  const sets: string[] = []
  const params: unknown[] = []
  if (patch.name !== undefined) {
    const name = patch.name.trim()
    if (!name) throw new BillingError('customer_not_found')
    payload.name = name
    sets.push('name = ?')
    params.push(name)
  }
  if (patch.phone !== undefined) {
    let phone: string | null = null
    if (patch.phone !== null && patch.phone.trim() !== '') {
      const n = normalizeIndianMobile(patch.phone)
      if (!n) throw new BillingError('invalid_phone')
      phone = n.slice(-10)
    }
    payload.phone = phone
    sets.push('phone = ?')
    params.push(phone)
  }
  if (patch.creditLimitPaise !== undefined) {
    const lim = patch.creditLimitPaise
    if (lim !== null && !(Number.isSafeInteger(lim) && lim >= 0)) throw new BillingError('invalid_credit_limit')
    payload.creditLimitPaise = lim
    sets.push('credit_limit_paise = ?')
    params.push(lim)
  }
  if (sets.length === 0) return
  sets.push('updated_at = ?')
  params.push(new Date().toISOString(), partyId)
  await writer.writeAll([
    item(
      { entityType: 'party', entityId: partyId, opType: 'update', actorUserId, payload: payload as never },
      [{ sql: `UPDATE party SET ${sets.join(', ')} WHERE id = ?`, params }],
    ),
  ])
}
