import { BillingError } from '../billing/errors'
import { getJson, setJson, type StateReader } from '../billing/settings'
import { recordCashMovement } from '../billing/shift'
import { assertSafeCardReference } from '../billing/card'
import { khataEntryEffects } from '../sync/effects'
import { item, type OpLogWriter } from '../sync/oplog'
import { uuidv7 } from '../sync/uuid7'

export interface KhataScope {
  tenantId: string
  storeId: string
  deviceId: string
}

export type CollectMode = 'cash' | 'upi' | 'card'

export interface CollectInput {
  /** Made when the dialog opens; a double tap returns the first result instead of a second payment. */
  requestId: string
  partyId: string
  amountPaise: number
  mode: CollectMode
  /** UPI transaction id or the last 4 digits of a card slip. Never a card number. */
  reference?: string | null
  note?: string | null
  identity: KhataScope
  actorUserId: string | null
  now: Date | number
}

export interface CollectResult {
  paymentId: string
  khataEntryId: string
  /** What the customer owes after this payment (negative = advance). */
  balanceAfterPaise: number
}

const isPaise = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0

async function balanceOf(db: StateReader, partyId: string): Promise<number> {
  const [r] = await db.getAll<{ b: number | null }>('SELECT balance_paise AS b FROM khata_balance WHERE party_id = ?', [partyId])
  return Number(r?.b ?? 0)
}

/**
 * "Customer paid". ONE local transaction writes the payment (money in, linked to the customer, not to a bill) and the
 * khata credit entry that lowers what they owe, plus their optimistic read-model rows. Cash also lands in the open
 * shift's cash total. More than the balance is allowed: it shows as an advance. Never touches the network.
 */
export async function collectPayment(writer: OpLogWriter, input: CollectInput): Promise<CollectResult> {
  if (!isPaise(input.amountPaise)) throw new BillingError('invalid_amount')
  const reference = input.mode === 'card' ? assertSafeCardReference(input.reference) : (input.reference?.trim() || null)
  const nowMs = new Date(input.now).getTime()
  const occurredAt = new Date(nowMs).toISOString()
  const key = `coll_req:${input.requestId}`
  let result: CollectResult | null = null

  await writer.writeAllWith(async (tx) => {
    const done = await getJson<CollectResult>(tx, key)
    if (done) {
      result = done
      return []
    }
    const [party] = await tx.getAll<{ id: string }>('SELECT id FROM party WHERE id = ?', [input.partyId])
    if (!party) throw new BillingError('customer_not_found')
    const { tenantId, storeId } = input.identity
    const paymentId = uuidv7(nowMs)
    const khataEntryId = uuidv7(nowMs)
    const balanceAfterPaise = (await balanceOf(tx, input.partyId)) - input.amountPaise
    result = { paymentId, khataEntryId, balanceAfterPaise }
    await setJson(tx, key, result)
    if (input.mode === 'cash') await recordCashMovement(tx, 'in', input.amountPaise)
    return [
      item(
        {
          entityType: 'payment',
          entityId: paymentId,
          opType: 'create',
          actorUserId: input.actorUserId,
          payload: { partyId: input.partyId, invoiceId: null, direction: 'in', mode: input.mode, amountPaise: input.amountPaise, ...(reference ? { reference } : {}), occurredAt },
        },
        [
          {
            sql: `INSERT OR REPLACE INTO payment (id, tenant_id, store_id, party_id, invoice_id, direction, mode, amount_paise, reference, occurred_at)
                  VALUES (?, ?, ?, ?, NULL, 'in', ?, ?, ?, ?)`,
            params: [paymentId, tenantId, storeId, input.partyId, input.mode, input.amountPaise, reference, occurredAt],
          },
        ],
      ),
      item(
        {
          entityType: 'khata_entry',
          entityId: khataEntryId,
          opType: 'create',
          actorUserId: input.actorUserId,
          payload: { partyId: input.partyId, direction: 'credit', amountPaise: input.amountPaise, refType: 'payment', refId: paymentId, ...(input.note ? { note: input.note } : {}), occurredAt },
        },
        khataEntryEffects({ id: khataEntryId, tenantId, storeId, partyId: input.partyId, direction: 'credit', amountPaise: input.amountPaise, refType: 'payment', refId: paymentId, note: input.note ?? null, occurredAt }),
      ),
    ]
  })
  if (result === null) throw new Error('collectPayment wrote nothing')
  return result
}

export interface PreviousBalanceInput {
  requestId: string
  partyId: string
  amountPaise: number
  note?: string | null
  identity: KhataScope
  actorUserId: string | null
  now: Date | number
}

/**
 * "Customer already owes" without a bill: the balance from the shopkeeper's paper khata when they start, or a
 * hand-written udhaar. A debit entry, never an edit of the balance.
 */
export async function recordPreviousBalance(writer: OpLogWriter, input: PreviousBalanceInput): Promise<{ khataEntryId: string }> {
  if (!isPaise(input.amountPaise)) throw new BillingError('invalid_amount')
  const nowMs = new Date(input.now).getTime()
  const occurredAt = new Date(nowMs).toISOString()
  const key = `prev_req:${input.requestId}`
  let id = ''
  await writer.writeAllWith(async (tx) => {
    const done = await getJson<{ id: string }>(tx, key)
    if (done) {
      id = done.id
      return []
    }
    const [party] = await tx.getAll<{ id: string }>('SELECT id FROM party WHERE id = ?', [input.partyId])
    if (!party) throw new BillingError('customer_not_found')
    id = uuidv7(nowMs)
    await setJson(tx, key, { id })
    const { tenantId, storeId } = input.identity
    return [
      item(
        {
          entityType: 'khata_entry',
          entityId: id,
          opType: 'create',
          actorUserId: input.actorUserId,
          payload: { partyId: input.partyId, direction: 'debit', amountPaise: input.amountPaise, refType: 'opening_balance', ...(input.note ? { note: input.note } : {}), occurredAt },
        },
        khataEntryEffects({ id, tenantId, storeId, partyId: input.partyId, direction: 'debit', amountPaise: input.amountPaise, refType: 'opening_balance', refId: null, note: input.note ?? null, occurredAt }),
      ),
    ]
  })
  return { khataEntryId: id }
}
