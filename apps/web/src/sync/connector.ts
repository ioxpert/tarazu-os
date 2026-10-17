import type { components } from '../api/schema'

type Operation = components['schemas']['Operation']
type UploadResponse = components['schemas']['UploadResponse']

/** Max ops per request: the server accepts 500. Also bounds memory when 100,000 ops are queued. */
export const UPLOAD_BATCH = 500

export interface CrudEntryLike {
  table: string
  op: string
  id: string
  opData?: Record<string, unknown>
}
export interface CrudBatchLike {
  crud: CrudEntryLike[]
  haveMore: boolean
  complete(): Promise<void>
}
/** What uploadData needs from the database (PowerSyncDatabase satisfies it). */
export interface UploadDb {
  getCrudBatch(limit?: number): Promise<CrudBatchLike | null>
  execute(sql: string, params?: unknown[]): Promise<unknown>
}

/** How the connector reports to the rest of the app (wired to syncStore by the runtime). */
export interface SyncSignals {
  setAuthProblem(code: string | null): void
  setUploadProblem(problem: { status: number; code: string; detail: string } | null): void
  /** Called when op_issue rows were added. */
  issuesChanged(): void
  uploaded(count: number): void
}

export interface ConnectorOptions {
  apiBase: string
  deviceToken: string
  signals: SyncSignals
  fetchImpl?: typeof fetch
  batchSize?: number
}

/** Codes after which this device must stop talking to the server until it is registered again. */
const AUTH_CODES = new Set(['device_revoked', 'invalid_token', 'authentication_required'])

/** Thrown to make PowerSync retry later (it backs off); nothing was removed from the queue. */
export class UploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message)
  }
}

interface Problem {
  code?: string
  detail?: string
}

async function readProblem(res: Response): Promise<Problem> {
  try {
    return (await res.json()) as Problem
  } catch {
    return {}
  }
}

/**
 * PowerSync backend connector.
 * - fetchCredentials: short-lived PowerSync JWT from our API, using the device token.
 * - uploadData: drains the local op_log queue to POST /v1/sync/upload in batches. The server acknowledges every
 *   operation (applied / flagged / deferred / rejected / duplicate), so each batch is completed once the request
 *   succeeds; rejected and flagged ones are copied to the local op_issue table for the "action required" state.
 *   CRUD for any table other than op_log is an optimistic local effect and is completed without being sent.
 */
export class TarazuConnector {
  private readonly fetchImpl: typeof fetch
  private readonly batchSize: number
  private blocked = false

  constructor(private readonly options: ConnectorOptions) {
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args))
    this.batchSize = Math.min(options.batchSize ?? UPLOAD_BATCH, UPLOAD_BATCH)
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.options.deviceToken}` }
  }

  readonly fetchCredentials = async (): Promise<{ endpoint: string; token: string; expiresAt?: Date } | null> => {
    if (this.blocked) return null
    const res = await this.fetchImpl(`${this.options.apiBase}/v1/sync/credentials`, { headers: this.headers() })
    if (res.status === 401) {
      const problem = await readProblem(res)
      if (problem.code && AUTH_CODES.has(problem.code)) this.block(problem.code)
      throw new UploadError(`credentials refused: ${problem.code ?? 401}`, 401, problem.code ?? 'unauthorized')
    }
    if (!res.ok) throw new UploadError(`credentials failed (${res.status})`, res.status, 'credentials_failed')
    const body = (await res.json()) as { endpoint: string; token: string; expiresAt: string }
    return { endpoint: body.endpoint, token: body.token, expiresAt: new Date(body.expiresAt) }
  }

  readonly uploadData = async (db: UploadDb): Promise<void> => {
    if (this.blocked) throw new UploadError('device is blocked; sync stopped', 401, 'blocked')
    for (;;) {
      const batch = await db.getCrudBatch(this.batchSize)
      if (!batch) return
      const ops = batch.crud.filter((e) => e.table === 'op_log' && e.op === 'PUT').map(toOperation)
      if (ops.length > 0) {
        const response = await this.post(ops)
        await this.recordIssues(db, ops, response)
        this.options.signals.uploaded(ops.length)
      }
      // everything in the batch was either sent and acknowledged, or is a local-only optimistic effect
      await batch.complete()
      this.options.signals.setUploadProblem(null)
      if (!batch.haveMore) return
    }
  }

  private block(code: string): void {
    this.blocked = true
    this.options.signals.setAuthProblem(code)
  }

  private async post(operations: Operation[]): Promise<UploadResponse> {
    const res = await this.fetchImpl(`${this.options.apiBase}/v1/sync/upload`, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ operations }),
    })
    if (res.ok) return (await res.json()) as UploadResponse

    const problem = await readProblem(res)
    const code = problem.code ?? String(res.status)
    const detail = problem.detail ?? `Upload failed with HTTP ${res.status}`
    if (res.status === 401 && problem.code && AUTH_CODES.has(problem.code)) {
      this.block(problem.code)
    } else if (res.status === 403 && problem.code === 'device_revoked') {
      this.block('device_revoked')
    } else if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
      // the server will keep refusing the same request: show it, and let PowerSync back off and retry
      this.options.signals.setUploadProblem({ status: res.status, code, detail })
    }
    // 5xx / 429 / 408 and everything above: throw, PowerSync retries with backoff, nothing was completed
    throw new UploadError(`upload refused: ${res.status} ${code}`, res.status, code)
  }

  private async recordIssues(db: UploadDb, ops: Operation[], response: UploadResponse): Promise<void> {
    const byId = new Map(ops.map((o) => [o.operationId, o]))
    let added = false
    for (const result of response.results) {
      if (result.status !== 'rejected' && result.status !== 'flagged') continue
      const op = byId.get(result.operationId)
      await db.execute(
        `INSERT OR REPLACE INTO op_issue (id, severity, code, detail, entity_type, entity_id, created_at, acknowledged_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
        [
          result.operationId,
          result.status,
          result.code ?? null,
          result.message ?? null,
          op?.entityType ?? null,
          op?.entityId ?? null,
          new Date().toISOString(),
        ],
      )
      added = true
    }
    if (added) this.options.signals.issuesChanged()
  }
}

function toOperation(e: CrudEntryLike): Operation {
  const d = e.opData ?? {}
  const text = (k: string) => d[k] as string
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(text('payload')) as Record<string, unknown>
  } catch {
    // a local row we cannot read must never be silently dropped: fail loudly, the queue stays intact
    throw new UploadError(`op_log ${e.id} has an unreadable payload`, 0, 'corrupt_local_op')
  }
  const actor = d.actor_user_id as string | null | undefined
  return {
    operationId: e.id,
    storeId: text('store_id'),
    deviceId: text('device_id'),
    ...(actor ? { actorUserId: actor } : {}),
    localSeq: Number(d.local_seq),
    hlc: text('hlc'),
    idempotencyKey: text('idempotency_key'),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    opType: text('op_type') as Operation['opType'],
    schemaVersion: Number(d.schema_version),
    payload,
  }
}
