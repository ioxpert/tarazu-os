import { BillingError } from '../billing/errors'
import { getJson, setJson } from '../billing/settings'
import { assertSafeCardReference } from '../billing/card'
import { recordCashMovement } from '../billing/shift'
import { khataEntryEffects } from '../sync/effects'
import { item, type OpLogWriter } from '../sync/oplog'
import { uuidv7 } from '../sync/uuid7'
import type { PayMode } from './commit'

export async function createSupplier(
  writer: OpLogWriter,
  ctx: { tenantId: string; actorUserId?: string | null },
  name: string,
  phone: string | null,
): Promise<{ id: string; name: string }> {
  const clean = name.trim()
  if (!clean) throw new BillingError('customer_not_found')
  const id = uuidv7()
  const ph = phone?.trim() || null
  await writer.write(
    { entityType: 'party', entityId: id, opType: 'create', actorUserId: ctx.actorUserId, payload: { name: clean, partyType: 'supplier', ...(ph ? { phone: ph } : {}) } },
    [
      {
        sql: `INSERT OR REPLACE INTO party (id, tenant_id, name, party_type, phone, gstin, credit_limit_paise, active, merged_into, updated_at)
              VALUES (?, ?, ?, 'supplier', ?, NULL, NULL, 1, NULL, ?)`,
        params: [id, ctx.tenantId, clean, ph, new Date().toISOString()],
      },
    ],
  )
  return { id, name: clean }
}

export interface PaySupplierInput {
  requestId: string
  supplierId: string
  amountPaise: number
  mode: PayMode
  reference?: string | null
  identity: { tenantId: string; storeId: string; deviceId: string }
  actorUserId: string | null
  now: Date | number
}

/**
 * "I paid the supplier": a payment out and a khata DEBIT on the supplier, which moves what you owe them back toward
 * zero. Paying more than owed leaves a positive balance (they owe you an advance). Cash leaves the open shift.
 */
export async function paySupplier(writer: OpLogWriter, input: PaySupplierInput): Promise<{ paymentId: string; balanceAfterPaise: number }> {
  if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0) throw new BillingError('invalid_amount')
  const reference = input.mode === 'card' ? assertSafeCardReference(input.reference) : (input.reference?.trim() || null)
  const nowMs = new Date(input.now).getTime()
  const occurredAt = new Date(nowMs).toISOString()
  const key = `sup_req:${input.requestId}`
  let result: { paymentId: string; balanceAfterPaise: number } | null = null
  await writer.writeAllWith(async (tx) => {
    const done = await getJson<typeof result>(tx, key)
    if (done) {
      result = done
      return []
    }
    const [party] = await tx.getAll<{ id: string }>('SELECT id FROM party WHERE id = ?', [input.supplierId])
    if (!party) throw new BillingError('customer_not_found')
    const [bal] = await tx.getAll<{ b: number | null }>('SELECT balance_paise AS b FROM khata_balance WHERE party_id = ?', [input.supplierId])
    const { tenantId, storeId } = input.identity
    const paymentId = uuidv7(nowMs)
    const khataId = uuidv7(nowMs)
    result = { paymentId, balanceAfterPaise: Number(bal?.b ?? 0) + input.amountPaise }
    await setJson(tx, key, result)
    if (input.mode === 'cash') await recordCashMovement(tx, 'out', input.amountPaise)
    return [
      item(
        {
          entityType: 'payment',
          entityId: paymentId,
          opType: 'create',
          actorUserId: input.actorUserId,
          payload: { partyId: input.supplierId, invoiceId: null, direction: 'out', mode: input.mode, amountPaise: input.amountPaise, ...(reference ? { reference } : {}), occurredAt },
        },
        [
          {
            sql: `INSERT OR REPLACE INTO payment (id, tenant_id, store_id, party_id, invoice_id, direction, mode, amount_paise, reference, occurred_at)
                  VALUES (?, ?, ?, ?, NULL, 'out', ?, ?, ?, ?)`,
            params: [paymentId, tenantId, storeId, input.supplierId, input.mode, input.amountPaise, reference, occurredAt],
          },
        ],
      ),
      item(
        {
          entityType: 'khata_entry',
          entityId: khataId,
          opType: 'create',
          actorUserId: input.actorUserId,
          payload: { partyId: input.supplierId, direction: 'debit', amountPaise: input.amountPaise, refType: 'payment', refId: paymentId, occurredAt },
        },
        khataEntryEffects({ id: khataId, tenantId, storeId, partyId: input.supplierId, direction: 'debit', amountPaise: input.amountPaise, refType: 'payment', refId: paymentId, note: null, occurredAt }),
      ),
    ]
  })
  if (result === null) throw new Error('paySupplier wrote nothing')
  return result
}
