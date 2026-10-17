import type { LocalDb } from '../sync/schemaDb'
import { uuidv7 } from '../sync/uuid7'
import { BillingError } from './errors'
import type { Cart } from './types'

/** Held bills are drafts: local-only (table held_bill), never an op. Resuming removes the row. */
export interface HeldBill {
  id: string
  label: string
  cart: Cart
  totalPaise: number
  createdAt: string
}

interface Row {
  id: string
  label: string
  cart: string
  total_paise: number
  created_at: string
}

const toHeld = (r: Row): HeldBill => ({
  id: r.id,
  label: r.label,
  cart: JSON.parse(r.cart) as Cart,
  totalPaise: Number(r.total_paise),
  createdAt: r.created_at,
})

export async function holdBill(db: LocalDb, cart: Cart, label: string, totalPaise = 0, now: Date | number = Date.now()): Promise<string> {
  if (cart.lines.length === 0) throw new BillingError('empty_cart')
  const id = uuidv7(typeof now === 'number' ? now : now.getTime())
  await db.execute('INSERT INTO held_bill (id, label, cart, total_paise, created_at) VALUES (?, ?, ?, ?, ?)', [
    id,
    label,
    JSON.stringify(cart),
    totalPaise,
    new Date(now).toISOString(),
  ])
  return id
}

/** Oldest first. */
export async function listHeld(db: Pick<LocalDb, 'getAll'>): Promise<HeldBill[]> {
  const rows = await db.getAll<Row>('SELECT id, label, cart, total_paise, created_at FROM held_bill ORDER BY created_at, id')
  return rows.map(toHeld)
}

/** Take a held bill back to the counter: returns its cart and deletes the draft atomically. */
export async function resumeHeld(db: LocalDb, id: string): Promise<Cart> {
  return db.writeTransaction(async (tx) => {
    const rows = await tx.getAll<Row>('SELECT id, label, cart, total_paise, created_at FROM held_bill WHERE id = ?', [id])
    if (rows.length === 0) throw new BillingError('held_bill_not_found')
    await tx.execute('DELETE FROM held_bill WHERE id = ?', [id])
    return toHeld(rows[0]).cart
  })
}

export async function discardHeld(db: LocalDb, id: string): Promise<void> {
  await db.execute('DELETE FROM held_bill WHERE id = ?', [id])
}
