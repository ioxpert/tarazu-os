import type { components } from '../api/schema'
import { format, nodeIdOf, parse, tick, type Hlc } from './hlc'
import { uuidv7 } from './uuid7'

type S = components['schemas']

/** Payload shape per entity type, straight from the contract. */
export interface PayloadByEntity {
  product: S['ProductPayload']
  price_version: S['PriceVersionPayload']
  party: S['PartyPayload']
  party_merge: S['PartyMergePayload']
  stock_movement: S['StockMovementPayload']
  invoice: S['InvoicePayload']
  credit_note: S['CreditNotePayload']
  purchase_receipt: S['PurchaseReceiptPayload']
  order: S['OrderPayload']
  order_transition: S['OrderTransitionPayload']
  payment: S['PaymentPayload']
  khata_entry: S['KhataEntryPayload']
}
export type EntityType = keyof PayloadByEntity
export type OpType = S['Operation']['opType']

/** The slice of a PowerSync transaction the writer needs (PowerSyncDatabase satisfies it). */
export interface SyncTx {
  execute(sql: string, params?: unknown[]): Promise<unknown>
  getAll<T>(sql: string, params?: unknown[]): Promise<T[]>
}
export interface SyncDb {
  writeTransaction<T>(callback: (tx: SyncTx) => Promise<T>): Promise<T>
}

/** A SQL statement run in the same transaction as the op, to update the local read model optimistically. */
export interface LocalEffect {
  sql: string
  params?: unknown[]
}

export interface WriteRequest<E extends EntityType = EntityType> {
  entityType: E
  entityId: string
  opType: OpType
  payload: PayloadByEntity[E]
  actorUserId?: string | null
}

export interface WrittenOp {
  operationId: string
  localSeq: number
  hlc: string
  idempotencyKey: string
  entityType: EntityType
  entityId: string
}

/** One item of an atomic write: an op plus its optimistic local effects. */
export interface WriteItem<E extends EntityType = EntityType> {
  op: WriteRequest<E>
  effects?: LocalEffect[]
}

/** Typed helper so call sites keep the entity/payload correlation. */
export function item<E extends EntityType>(op: WriteRequest<E>, effects?: LocalEffect[]): WriteItem {
  return { op, effects } as unknown as WriteItem
}

export const SCHEMA_VERSION = 1
export const KEY_NEXT_SEQ = 'next_local_seq'
export const KEY_LAST_HLC = 'last_hlc'

export interface DeviceIdentity {
  deviceId: string
  storeId: string
}

/**
 * The only way billing/khata/stock code records a business event offline.
 * One call = one local SQLite transaction: sequence + HLC allocation, the op_log row(s), and the optimistic local
 * effects commit together or not at all, so a crash can never leave a sale half-recorded. A completed sale
 * never waits for the network.
 */
export class OpLogWriter {
  constructor(
    private readonly db: SyncDb,
    private readonly identity: DeviceIdentity,
    private readonly clock: () => number = Date.now,
  ) {}

  write<E extends EntityType>(op: WriteRequest<E>, effects?: LocalEffect[]): Promise<WrittenOp> {
    return this.writeAll([{ op, effects } as unknown as WriteItem]).then((r) => r[0])
  }

  /** Several ops (e.g. invoice + stock movements + khata entry) in one atomic local transaction. */
  async writeAll(items: WriteItem[]): Promise<WrittenOp[]> {
    if (items.length === 0) return []
    const { deviceId, storeId } = this.identity
    const node = nodeIdOf(deviceId)
    return this.db.writeTransaction(async (tx) => {
      const state = await tx.getAll<{ id: string; value: string }>(
        'SELECT id, value FROM device_state WHERE id IN (?, ?)',
        [KEY_NEXT_SEQ, KEY_LAST_HLC],
      )
      const byKey = new Map(state.map((r) => [r.id, r.value]))
      let seq = Number(byKey.get(KEY_NEXT_SEQ) ?? 1)
      let hlc: Hlc | null = byKey.has(KEY_LAST_HLC) ? parse(byKey.get(KEY_LAST_HLC)!) : null
      const written: WrittenOp[] = []

      for (const { op, effects } of items) {
        hlc = tick(hlc, this.clock(), node)
        const operationId = uuidv7(hlc.ms)
        const hlcText = format(hlc)
        const idempotencyKey = `${deviceId}:${seq}`
        await tx.execute(
          `INSERT INTO op_log (id, store_id, device_id, actor_user_id, local_seq, hlc, idempotency_key, entity_type,
             entity_id, op_type, schema_version, payload, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            operationId,
            storeId,
            deviceId,
            op.actorUserId ?? null,
            seq,
            hlcText,
            idempotencyKey,
            op.entityType,
            op.entityId,
            op.opType,
            SCHEMA_VERSION,
            JSON.stringify(op.payload),
            new Date(hlc.ms).toISOString(),
          ],
        )
        for (const effect of effects ?? []) await tx.execute(effect.sql, effect.params ?? [])
        written.push({ operationId, localSeq: seq, hlc: hlcText, idempotencyKey, entityType: op.entityType, entityId: op.entityId })
        seq++
      }

      // one statement: every round trip to the database worker costs on a cheap Android phone
      await tx.execute('INSERT OR REPLACE INTO device_state (id, value) VALUES (?, ?), (?, ?)', [
        KEY_NEXT_SEQ,
        String(seq),
        KEY_LAST_HLC,
        format(hlc!),
      ])
      return written
    })
  }
}
