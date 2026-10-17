import type { LocalDb } from '../sync/schemaDb'
import { BillingError } from './errors'
import type { MerchantProfile } from './types'

/** Anything with getAll/execute: LocalDb or a SyncTx inside a transaction. */
export interface StateReader {
  getAll<T>(sql: string, params?: unknown[]): Promise<T[]>
}
export interface StateWriter {
  execute(sql: string, params?: unknown[]): Promise<unknown>
}

/** device_state is local-only key/value (id = key, value = text). JSON helpers below. */
export async function getState(db: StateReader, key: string): Promise<string | null> {
  const rows = await db.getAll<{ value: string | null }>('SELECT value FROM device_state WHERE id = ?', [key])
  return rows.length === 0 ? null : rows[0].value
}

export async function setState(db: StateWriter, key: string, value: string): Promise<void> {
  await db.execute('INSERT OR REPLACE INTO device_state (id, value) VALUES (?, ?)', [key, value])
}

export async function deleteState(db: StateWriter, key: string): Promise<void> {
  await db.execute('DELETE FROM device_state WHERE id = ?', [key])
}

export async function getJson<T>(db: StateReader, key: string): Promise<T | null> {
  const text = await getState(db, key)
  if (text === null) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

export async function setJson(db: StateWriter, key: string, value: unknown): Promise<void> {
  await setState(db, key, JSON.stringify(value))
}

export const PROFILE_KEY = 'profile'

/** A device with no profile yet bills as a non-GST retailer: no tax is charged until the merchant says otherwise. */
export function defaultProfile(): MerchantProfile {
  return {
    businessName: '',
    gstMode: 'non_gst',
    gstin: null,
    stateCode: null,
    upiVpa: null,
    address: null,
    phone: null,
    storeName: null,
    rounding: 'nearest_rupee',
  }
}

export const VPA_PATTERN = /^[A-Za-z0-9._-]{2,256}@[A-Za-z]{2,64}$/
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/

export function validateProfile(p: MerchantProfile): void {
  if (!['regular', 'composition', 'non_gst'].includes(p.gstMode)) throw new BillingError('invalid_profile', 'gstMode')
  if (!['nearest_rupee', 'none'].includes(p.rounding)) throw new BillingError('invalid_profile', 'rounding')
  if (p.gstin !== null && !GSTIN.test(p.gstin)) throw new BillingError('invalid_profile', 'gstin')
  if (p.gstMode !== 'non_gst' && p.gstin === null) throw new BillingError('invalid_profile', 'gstin required for GST modes')
  if (p.upiVpa !== null && !VPA_PATTERN.test(p.upiVpa)) throw new BillingError('invalid_vpa')
}

/** Stored profile merged over the defaults (so a newer app reading an older profile still gets every field). */
export async function loadProfile(db: StateReader): Promise<MerchantProfile> {
  const stored = await getJson<Partial<MerchantProfile>>(db, PROFILE_KEY)
  return { ...defaultProfile(), ...(stored ?? {}) }
}

export async function saveProfile(db: LocalDb, profile: MerchantProfile): Promise<void> {
  validateProfile(profile)
  await db.execute('INSERT OR REPLACE INTO device_state (id, value) VALUES (?, ?)', [PROFILE_KEY, JSON.stringify(profile)])
}
