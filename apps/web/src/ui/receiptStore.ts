import type { ReceiptData } from '../billing/types'
import { getJson, setJson } from '../billing/settings'
import type { LocalDb } from '../sync/schemaDb'

/** The last receipt is kept in device_state so a reload (or a power cut) right after a sale can still print it. */
export interface StoredReceipt {
  invoiceId: string
  receipt: ReceiptData
  /** UPI link for the QR on this receipt (dynamic, amount inside) when part of the bill is still owed. */
  upiUri: string | null
}

const KEY = 'last_receipt'

export async function saveLastReceipt(db: LocalDb, r: StoredReceipt): Promise<void> {
  await setJson(db, KEY, r)
}

export function loadLastReceipt(db: LocalDb): Promise<StoredReceipt | null> {
  return getJson<StoredReceipt>(db, KEY)
}
