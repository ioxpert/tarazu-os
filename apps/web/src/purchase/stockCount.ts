import { BillingError } from '../billing/errors'
import { adjustStockBalance } from '../sync/effects'
import { item, type OpLogWriter } from '../sync/oplog'
import { uuidv7 } from '../sync/uuid7'

export type CountReason = 'adjustment' | 'damage'

/**
 * Stock count: the shopkeeper types what is really on the shelf; the difference to what the books say is written as
 * ONE stock movement (reason adjustment, or damage when stock was lost). Stock is never overwritten: a count that
 * matches writes nothing, and the movement history shows who changed what.
 * The books' quantity is read inside the transaction, so two counters counting at once cannot double-correct.
 */
export async function countStock(
  writer: OpLogWriter,
  ctx: { tenantId: string; storeId: string; actorUserId?: string | null },
  productId: string,
  countedMilli: number,
  opts: { reason?: CountReason; now?: Date | number } = {},
): Promise<{ deltaMilli: number; booksMilli: number }> {
  if (!Number.isSafeInteger(countedMilli) || countedMilli < 0) throw new BillingError('invalid_count')
  const nowMs = new Date(opts.now ?? Date.now()).getTime()
  const occurredAt = new Date(nowMs).toISOString()
  let out = { deltaMilli: 0, booksMilli: 0 }
  await writer.writeAllWith(async (tx) => {
    const [row] = await tx.getAll<{ q: number | null }>('SELECT qty_milli AS q FROM stock_balance WHERE id = ?', [`${ctx.storeId}:${productId}`])
    const books = Number(row?.q ?? 0)
    const delta = countedMilli - books
    out = { deltaMilli: delta, booksMilli: books }
    if (delta === 0) return []
    return [
      item(
        {
          entityType: 'stock_movement',
          entityId: uuidv7(nowMs),
          opType: 'create',
          actorUserId: ctx.actorUserId,
          payload: { productId, qtyMilli: delta, reason: delta < 0 && opts.reason === 'damage' ? 'damage' : 'adjustment', occurredAt },
        },
        [adjustStockBalance(ctx.tenantId, ctx.storeId, productId, delta)],
      ),
    ]
  })
  return out
}
