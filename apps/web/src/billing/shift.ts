import { item, type OpLogWriter, type SyncTx } from '../sync/oplog'
import { uuidv7 } from '../sync/uuid7'
import { BillingError } from './errors'
import { deleteState, getJson, getState, setJson, setState, type StateReader } from './settings'

/**
 * Cash shift of THIS device.
 *
 * How expected cash is computed offline: the synced local `payment` table has no device_id (the server's has), so
 * "cash taken by this device since open" cannot be derived from it (another till of the same store would be mixed in).
 * Instead the device keeps a local-only running ledger in device_state, `shift_cash:<shiftId>` = {inPaise, outPaise},
 * and every code path that writes a CASH payment (commitSale, commitReturn, and later khata collections / expenses)
 * calls recordCashMovement(tx, ...) INSIDE the same transaction as the payment op. So the ledger is exactly as
 * atomic as the payment itself and survives offline restarts. expected = opening float + in - out.
 * Cash sales made while no shift is open are not in any shift. The server recomputes from synced payments by
 * device and flags a disagreement (shift_expected_mismatch); the close is never blocked.
 */
const CURRENT_KEY = 'shift_current'
const ledgerKey = (shiftId: string) => `shift_cash:${shiftId}`

export interface Shift {
  id: string
  openingCashPaise: number
  openedAt: string
}

export interface CashLedger {
  inPaise: number
  outPaise: number
}

/** Call inside the transaction that writes a cash payment. No-op when no shift is open. */
export async function recordCashMovement(
  tx: Pick<SyncTx, 'getAll' | 'execute'>,
  direction: 'in' | 'out',
  amountPaise: number,
): Promise<void> {
  if (amountPaise <= 0) return
  const shiftId = await getState(tx, CURRENT_KEY)
  if (shiftId === null) return
  const ledger = (await getJson<CashLedger>(tx, ledgerKey(shiftId))) ?? { inPaise: 0, outPaise: 0 }
  if (direction === 'in') ledger.inPaise += amountPaise
  else ledger.outPaise += amountPaise
  await setJson(tx, ledgerKey(shiftId), ledger)
}

interface ShiftRow {
  id: string
  opening_cash_paise: number
  opened_at: string
}

/** The open shift of this device, or null. */
export async function currentShift(db: StateReader): Promise<Shift | null> {
  const id = await getState(db, CURRENT_KEY)
  if (id === null) return null
  const rows = await db.getAll<ShiftRow>('SELECT id, opening_cash_paise, opened_at FROM shift WHERE id = ?', [id])
  if (rows.length === 0) return null
  return { id, openingCashPaise: Number(rows[0].opening_cash_paise), openedAt: rows[0].opened_at }
}

export async function cashLedger(db: StateReader, shiftId: string): Promise<CashLedger> {
  return (await getJson<CashLedger>(db, ledgerKey(shiftId))) ?? { inPaise: 0, outPaise: 0 }
}

/** Opening float + cash in - cash out, for this device since the shift opened. */
export async function expectedCash(db: StateReader, shift: Shift): Promise<number> {
  const l = await cashLedger(db, shift.id)
  return shift.openingCashPaise + l.inPaise - l.outPaise
}

export interface OpenShiftInput {
  openingCashPaise: number
  identity: { tenantId: string; storeId: string; deviceId: string }
  actorUserId: string | null
  now: Date | number
  note?: string
}

export async function openShift(writer: OpLogWriter, input: OpenShiftInput): Promise<Shift> {
  if (!Number.isSafeInteger(input.openingCashPaise) || input.openingCashPaise < 0) throw new BillingError('invalid_amount')
  const id = uuidv7(new Date(input.now).getTime())
  const openedAt = new Date(input.now).toISOString()
  await writer.writeAllWith(async (tx) => {
    const existing = await getState(tx, CURRENT_KEY)
    if (existing !== null) throw new BillingError('shift_already_open')
    await setState(tx, CURRENT_KEY, id)
    await setJson(tx, ledgerKey(id), { inPaise: 0, outPaise: 0 })
    const { tenantId, storeId, deviceId } = input.identity
    return [
      item(
        {
          entityType: 'shift',
          entityId: id,
          opType: 'create',
          payload: { openingCashPaise: input.openingCashPaise, openedAt, ...(input.note ? { note: input.note } : {}) },
          actorUserId: input.actorUserId,
        },
        [
          {
            sql: 'INSERT OR REPLACE INTO shift (id, tenant_id, store_id, device_id, opening_cash_paise, opened_at) VALUES (?, ?, ?, ?, ?, ?)',
            params: [id, tenantId, storeId, deviceId, input.openingCashPaise, openedAt],
          },
        ],
      ),
    ]
  })
  return { id, openingCashPaise: input.openingCashPaise, openedAt }
}

export interface CloseShiftInput {
  declaredCashPaise: number
  identity: { tenantId: string; storeId: string; deviceId: string }
  actorUserId: string | null
  now: Date | number
  note?: string
}

export interface ShiftCloseResult {
  shiftId: string
  declaredCashPaise: number
  expectedCashPaise: number
  /** declared - expected: positive = more cash than the books say (over), negative = short. */
  variancePaise: number
  closedAt: string
}

export async function closeShift(writer: OpLogWriter, input: CloseShiftInput): Promise<ShiftCloseResult> {
  if (!Number.isSafeInteger(input.declaredCashPaise) || input.declaredCashPaise < 0) throw new BillingError('invalid_amount')
  const closedAt = new Date(input.now).toISOString()
  let result: ShiftCloseResult | null = null
  await writer.writeAllWith(async (tx) => {
    const shift = await currentShift(tx)
    if (shift === null) throw new BillingError('no_open_shift')
    const expected = await expectedCash(tx, shift)
    const variance = input.declaredCashPaise - expected
    result = { shiftId: shift.id, declaredCashPaise: input.declaredCashPaise, expectedCashPaise: expected, variancePaise: variance, closedAt }
    await deleteState(tx, CURRENT_KEY)
    const { tenantId, storeId, deviceId } = input.identity
    // the optimistic row must carry the op's entity id: the server's row (same id) replaces it after sync
    const closeId = uuidv7(new Date(input.now).getTime())
    return [
      item(
        {
          entityType: 'shift_close',
          entityId: closeId,
          opType: 'create',
          payload: {
            shiftId: shift.id,
            declaredCashPaise: input.declaredCashPaise,
            expectedCashPaise: expected,
            closedAt,
            ...(input.note ? { note: input.note } : {}),
          },
          actorUserId: input.actorUserId,
        },
        [
          {
            sql: `INSERT OR REPLACE INTO shift_close (id, tenant_id, store_id, device_id, shift_id, declared_cash_paise,
                    expected_cash_paise, variance_paise, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            params: [closeId, tenantId, storeId, deviceId, shift.id, input.declaredCashPaise, expected, variance, closedAt],
          },
        ],
      ),
    ]
  })
  if (result === null) throw new Error('unreachable')
  return result
}
