import type { SyncTx } from '../sync/oplog'
import { getState, setState } from './settings'

const IST_OFFSET_MS = 5.5 * 3600 * 1000

/** Calendar date in India (IST, no DST) as 'YYYY-MM-DD'. The JVM and server run in UTC; invoices are dated in IST. */
export function istDate(now: Date | number): string {
  const ms = typeof now === 'number' ? now : now.getTime()
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10)
}

/** Indian financial year of a 'YYYY-MM-DD' date: April..March, '2026-10-17' -> '2026-27', '2027-03-31' -> '2026-27'. */
export function financialYear(date: string): string {
  const y = Number(date.slice(0, 4))
  const m = Number(date.slice(5, 7))
  const start = m >= 4 ? y : y - 1
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`
}

/** First 8 hex chars of the device id, upper case: the device part of every series. */
export function seriesPrefix(deviceId: string): string {
  return deviceId.replace(/-/g, '').slice(0, 8).toUpperCase()
}

export function invoiceSeries(deviceId: string, fy: string): string {
  return `${seriesPrefix(deviceId)}-${fy}`
}

export function creditNoteSeries(deviceId: string, fy: string): string {
  return `${seriesPrefix(deviceId)}-CN-${fy}`
}

/** Display label: 'A1B2C3D4-2026-27' + 17 -> 'A1B2C3D4/2026-27/17'; credit note series -> 'A1B2C3D4/CN/2026-27/17'. */
export function documentLabel(series: string, number: number): string {
  const m = /^([0-9A-Z]{8})-(CN-)?(\d{4}-\d{2})$/.exec(series)
  if (!m) return `${series}/${number}`
  return `${m[1]}/${m[2] ? 'CN/' : ''}${m[3]}/${number}`
}

const seqKey = (series: string) => `seq:${series}`

/**
 * Hand out the next number of a series. MUST run inside the writing transaction (OpLogWriter.writeAllWith's `tx`):
 * the counter is read and incremented there, so a rolled-back write consumes nothing and numbers stay gapless.
 * device_state `seq:<series>` holds the NEXT number to hand out (absent = 1).
 */
export async function allocateNumber(tx: Pick<SyncTx, 'getAll' | 'execute'>, series: string): Promise<number> {
  const current = await getState(tx, seqKey(series))
  const next = current === null ? 1 : Number(current)
  if (!Number.isSafeInteger(next) || next < 1) throw new Error(`corrupt counter for ${series}`)
  await setState(tx, seqKey(series), String(next + 1))
  return next
}

/** The number the next allocate would return (display only, e.g. "Bill no. 18"). */
export async function peekNextNumber(db: Pick<SyncTx, 'getAll'>, series: string): Promise<number> {
  const current = await getState(db, seqKey(series))
  return current === null ? 1 : Number(current)
}
