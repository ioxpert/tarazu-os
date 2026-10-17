import type { OpLogWriter } from '../sync/oplog'
import type { LocalDb } from '../sync/schemaDb'
import { uuidv7 } from '../sync/uuid7'

export interface PartyRow {
  id: string
  name: string
  phone: string | null
  balancePaise: number
}

/** Customers matching a name or phone fragment, with what they owe. Local only, instant offline. */
export async function searchParties(db: LocalDb, query: string, limit = 20): Promise<PartyRow[]> {
  const q = `%${query.trim().replace(/[%_]/g, '')}%`
  const rows = await db.getAll<{ id: string; name: string; phone: string | null; balance: number | null }>(
    `SELECT p.id AS id, p.name AS name, p.phone AS phone, k.balance_paise AS balance
     FROM party p LEFT JOIN khata_balance k ON k.party_id = p.id
     WHERE (p.active IS NULL OR p.active = 1) AND (p.merged_into IS NULL OR p.merged_into = '')
       AND (p.party_type IS NULL OR p.party_type IN ('customer', 'both'))
       AND (p.name LIKE ? OR p.phone LIKE ?)
     ORDER BY p.name COLLATE NOCASE LIMIT ?`,
    [q, q, limit],
  )
  return rows.map((r) => ({ id: r.id, name: r.name, phone: r.phone, balancePaise: Number(r.balance ?? 0) }))
}

/** Customers who owe money, largest first. */
export async function listOwing(db: LocalDb): Promise<PartyRow[]> {
  const rows = await db.getAll<{ id: string; name: string; phone: string | null; balance: number }>(
    `SELECT p.id AS id, p.name AS name, p.phone AS phone, k.balance_paise AS balance
     FROM khata_balance k JOIN party p ON p.id = k.party_id
     WHERE k.balance_paise > 0 ORDER BY k.balance_paise DESC LIMIT 200`,
  )
  return rows.map((r) => ({ id: r.id, name: r.name, phone: r.phone, balancePaise: Number(r.balance) }))
}

/** A customer needs only a name; phone is optional and never asked for a plain sale. */
export async function createParty(
  writer: OpLogWriter,
  ctx: { tenantId: string; actorUserId?: string | null },
  name: string,
  phone: string | null,
): Promise<PartyRow> {
  const id = uuidv7()
  const clean = name.trim()
  const ph = phone?.trim() || null
  await writer.write(
    { entityType: 'party', entityId: id, opType: 'create', actorUserId: ctx.actorUserId, payload: { name: clean, partyType: 'customer', ...(ph ? { phone: ph } : {}) } },
    [
      {
        sql: `INSERT OR REPLACE INTO party (id, tenant_id, name, party_type, phone, gstin, credit_limit_paise, active, merged_into, updated_at)
              VALUES (?, ?, ?, 'customer', ?, NULL, NULL, 1, NULL, ?)`,
        params: [id, ctx.tenantId, clean, ph, new Date().toISOString()],
      },
    ],
  )
  return { id, name: clean, phone: ph, balancePaise: 0 }
}
