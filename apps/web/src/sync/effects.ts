import type { LocalEffect } from './oplog'

/**
 * Optimistic local read-model updates that go with an op in the same transaction. They mirror what the server
 * projection will compute (stock = sum of movements, khata = debits minus credits), so the counter shows the
 * right number immediately. When the server's state arrives via sync it replaces these rows.
 * INSERT OR REPLACE with a sub-select, not UPSERT: PowerSync tables are views and views do not support ON CONFLICT.
 */
export function adjustStockBalance(tenantId: string, storeId: string, productId: string, deltaMilli: number): LocalEffect {
  const id = `${storeId}:${productId}`
  return {
    sql: `INSERT OR REPLACE INTO stock_balance (id, tenant_id, store_id, product_id, qty_milli, oversold, movement_count)
          VALUES (?, ?, ?, ?,
            coalesce((SELECT qty_milli FROM stock_balance WHERE id = ?), 0) + ?,
            (coalesce((SELECT qty_milli FROM stock_balance WHERE id = ?), 0) + ?) < 0,
            coalesce((SELECT movement_count FROM stock_balance WHERE id = ?), 0) + 1)`,
    params: [id, tenantId, storeId, productId, id, deltaMilli, id, deltaMilli, id],
  }
}

/** deltaPaise > 0 = the party owes more (debit); < 0 = the party paid (credit). */
export function adjustKhataBalance(tenantId: string, partyId: string, deltaPaise: number): LocalEffect {
  return {
    sql: `INSERT OR REPLACE INTO khata_balance (id, tenant_id, party_id, balance_paise, entry_count)
          VALUES (?, ?, ?,
            coalesce((SELECT balance_paise FROM khata_balance WHERE id = ?), 0) + ?,
            coalesce((SELECT entry_count FROM khata_balance WHERE id = ?), 0) + 1)`,
    params: [partyId, tenantId, partyId, partyId, deltaPaise, partyId],
  }
}

export interface KhataEntryRow {
  id: string
  tenantId: string
  storeId: string
  partyId: string
  direction: 'debit' | 'credit'
  amountPaise: number
  refType: string | null
  refId: string | null
  note: string | null
  occurredAt: string
}

/**
 * Everything the local read model needs for one khata_entry op: the statement row (same id as the op's entity, so the
 * server's row replaces it after sync) and the running balance. Keeps the two from drifting apart.
 */
export function khataEntryEffects(e: KhataEntryRow): LocalEffect[] {
  const delta = e.direction === 'debit' ? e.amountPaise : -e.amountPaise
  return [
    adjustKhataBalance(e.tenantId, e.partyId, delta),
    {
      sql: `INSERT OR REPLACE INTO khata_entry (id, tenant_id, store_id, party_id, direction, amount_paise, ref_type, ref_id, note, occurred_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [e.id, e.tenantId, e.storeId, e.partyId, e.direction, e.amountPaise, e.refType, e.refId, e.note, e.occurredAt],
    },
  ]
}
