import { documentLabel } from '../billing/numbering'
import type { StateReader } from '../billing/settings'
import { ageing, type Ageing } from './ageing'

export interface CustomerRow {
  id: string
  name: string
  phone: string | null
  creditLimitPaise: number | null
  /** + the customer owes you, - you hold their advance. */
  balancePaise: number
  lastActivityAt: string | null
  /** Days since the oldest unpaid amount started (0 when nothing is owed). */
  oldestDays: number
}

export type CustomerFilter = 'owing' | 'advance' | 'all'
export type CustomerSort = 'amount' | 'oldest' | 'name'

interface PartyRaw {
  id: string
  name: string
  phone: string | null
  credit_limit_paise: number | null
  balance: number | null
  last_at: string | null
}

interface EntryRaw {
  id: string
  party_id: string
  direction: 'debit' | 'credit'
  amount_paise: number
  occurred_at: string
}

/** Customers with what they owe, for the Khata home. Local read, instant offline. */
export async function listCustomers(
  db: StateReader,
  opts: { query?: string; filter?: CustomerFilter; sort?: CustomerSort; asOf?: Date | number; kind?: 'customer' | 'supplier' } = {},
): Promise<CustomerRow[]> {
  const filter = opts.filter ?? 'owing'
  const like = `%${(opts.query ?? '').trim().replace(/[%_]/g, '')}%`
  const parties = await db.getAll<PartyRaw>(
    `SELECT p.id AS id, p.name AS name, p.phone AS phone, p.credit_limit_paise AS credit_limit_paise,
            k.balance_paise AS balance, (SELECT max(e.occurred_at) FROM khata_entry e WHERE e.party_id = p.id) AS last_at
     FROM party p LEFT JOIN khata_balance k ON k.party_id = p.id
     WHERE (p.active IS NULL OR p.active = 1) AND (p.merged_into IS NULL OR p.merged_into = '')
       AND (p.party_type IS NULL OR p.party_type IN (${opts.kind === 'supplier' ? "'supplier', 'both'" : "'customer', 'both'"}))
       AND (p.name LIKE ? OR p.phone LIKE ?)`,
    [like, like],
  )
  const owing = parties.filter((p) => Number(p.balance ?? 0) > 0).map((p) => p.id)
  const ages = new Map<string, Ageing>()
  if (owing.length > 0) {
    const entries = await db.getAll<EntryRaw>(
      `SELECT id, party_id, direction, amount_paise, occurred_at FROM khata_entry WHERE party_id IN (${owing.map(() => '?').join(',')})`,
      owing,
    )
    const byParty = new Map<string, EntryRaw[]>()
    for (const e of entries) (byParty.get(e.party_id) ?? byParty.set(e.party_id, []).get(e.party_id)!).push(e)
    for (const [id, list] of byParty) {
      ages.set(id, ageing(list.map((e) => ({ id: e.id, direction: e.direction, amountPaise: Number(e.amount_paise), occurredAt: e.occurred_at })), opts.asOf ?? Date.now()))
    }
  }
  let rows: CustomerRow[] = parties.map((p) => ({
    id: p.id,
    name: p.name,
    phone: p.phone,
    creditLimitPaise: p.credit_limit_paise === null ? null : Number(p.credit_limit_paise),
    balancePaise: Number(p.balance ?? 0),
    lastActivityAt: p.last_at,
    oldestDays: ages.get(p.id)?.oldestDays ?? 0,
  }))
  if (filter === 'owing') rows = rows.filter((r) => r.balancePaise > 0)
  else if (filter === 'advance') rows = rows.filter((r) => r.balancePaise < 0)
  const sort = opts.sort ?? 'amount'
  rows.sort((a, b) =>
    sort === 'name'
      ? a.name.localeCompare(b.name)
      : sort === 'oldest'
        ? b.oldestDays - a.oldestDays || b.balancePaise - a.balancePaise
        : b.balancePaise - a.balancePaise || a.name.localeCompare(b.name),
  )
  return rows
}

export interface StatementLine {
  id: string
  occurredAt: string
  direction: 'debit' | 'credit'
  amountPaise: number
  refType: string | null
  refId: string | null
  note: string | null
  /** For a bill: its number as printed ("A1B2C3D4/2026-27/17"). */
  invoiceLabel: string | null
  /** What the customer owed right after this line. */
  balanceAfterPaise: number
}

export interface Statement {
  customer: CustomerRow
  lines: StatementLine[]
  ageing: Ageing
}

interface LineRaw {
  id: string
  direction: 'debit' | 'credit'
  amount_paise: number
  ref_type: string | null
  ref_id: string | null
  note: string | null
  occurred_at: string
  series: string | null
  number: number | null
}

/** The customer's khata statement, oldest first, with the running balance after every line. */
export async function loadStatement(db: StateReader, partyId: string, asOf: Date | number = Date.now(), kind: 'customer' | 'supplier' = 'customer'): Promise<Statement | null> {
  const [customer] = (await listCustomers(db, { filter: 'all', asOf, kind })).filter((c) => c.id === partyId)
  if (!customer) return null
  const raw = await db.getAll<LineRaw>(
    `SELECT e.id AS id, e.direction AS direction, e.amount_paise AS amount_paise, e.ref_type AS ref_type, e.ref_id AS ref_id,
            e.note AS note, e.occurred_at AS occurred_at, i.series AS series, i.number AS number
     FROM khata_entry e LEFT JOIN invoice i ON e.ref_type = 'invoice' AND i.id = e.ref_id
     WHERE e.party_id = ? ORDER BY e.occurred_at, e.id`,
    [partyId],
  )
  let running = 0
  const lines: StatementLine[] = raw.map((r) => {
    const amount = Number(r.amount_paise)
    running += r.direction === 'debit' ? amount : -amount
    return {
      id: r.id,
      occurredAt: r.occurred_at,
      direction: r.direction,
      amountPaise: amount,
      refType: r.ref_type,
      refId: r.ref_id,
      note: r.note,
      invoiceLabel: r.series && r.number ? documentLabel(r.series, Number(r.number)) : null,
      balanceAfterPaise: running,
    }
  })
  return {
    customer,
    lines,
    ageing: ageing(lines.map((l) => ({ id: l.id, direction: l.direction, amountPaise: l.amountPaise, occurredAt: l.occurredAt })), asOf),
  }
}

export interface CreditCheck {
  state: 'ok' | 'will_exceed' | 'already_over' | 'no_limit'
  limitPaise: number | null
  /** Balance if this credit sale goes through. */
  afterPaise: number
}

/** Advice shown while billing on credit; never blocks the sale. */
export function checkCreditLimit(balancePaise: number, limitPaise: number | null, newCreditPaise: number): CreditCheck {
  const afterPaise = balancePaise + newCreditPaise
  if (limitPaise === null) return { state: 'no_limit', limitPaise, afterPaise }
  if (balancePaise > limitPaise) return { state: 'already_over', limitPaise, afterPaise }
  return { state: afterPaise > limitPaise ? 'will_exceed' : 'ok', limitPaise, afterPaise }
}

export async function loadCreditPosition(db: StateReader, partyId: string): Promise<{ balancePaise: number; limitPaise: number | null }> {
  const [row] = await db.getAll<{ bal: number | null; lim: number | null }>(
    `SELECT k.balance_paise AS bal, p.credit_limit_paise AS lim FROM party p LEFT JOIN khata_balance k ON k.party_id = p.id WHERE p.id = ?`,
    [partyId],
  )
  return { balancePaise: Number(row?.bal ?? 0), limitPaise: row?.lim == null ? null : Number(row.lim) }
}
