import { PowerSyncDatabase, WASQLiteVFS } from '@powersync/web'
import { clearSyncConfig, loadSyncConfig, type SyncConfig } from './config'
import { TarazuConnector, type SyncSignals } from './connector'
import { OpLogWriter } from './oplog'
import { schema } from './schema'
import { syncStore } from './syncStore'

/**
 * The sync runtime: PowerSync database (SQLite WASM on OPFS in a SharedWorker), connector and op-log writer.
 * This module (and therefore @powersync/web and the WASM) is only ever imported dynamically, so it stays out of
 * the first-load bundle. Everything the UI needs lives in syncStore, which has no PowerSync dependency.
 */
export interface SyncRuntime {
  db: PowerSyncDatabase
  writer: OpLogWriter
  config: SyncConfig
  /** Re-reads queue length and open issues into syncStore. Call after local writes. */
  refresh(): Promise<void>
  connect(): Promise<void>
  /** Stops syncing but keeps every local row. */
  disconnect(): Promise<void>
  /** Marks all open server issues as seen. */
  acknowledgeIssues(): Promise<void>
}

const DB_FILENAME = 'tarazu.db'
const REFRESH_MS = 2000

let runtimePromise: Promise<SyncRuntime> | null = null
let activeConfig: SyncConfig | null = null

/** Starts (once) and returns the runtime for the stored config. Rejects if the device is not configured. */
export function getSyncRuntime(): Promise<SyncRuntime> {
  runtimePromise ??= start().catch((e) => {
    runtimePromise = null
    throw e
  })
  return runtimePromise
}

async function start(): Promise<SyncRuntime> {
  const config = loadSyncConfig()
  if (!config) throw new Error('This device is not configured for sync (no device token)')
  activeConfig = config

  const db = new PowerSyncDatabase({
    schema,
    database: { dbFilename: DB_FILENAME, vfs: WASQLiteVFS.OPFSCoopSyncVFS, enableMultiTabs: typeof SharedWorker !== 'undefined' },
  })
  await db.init()

  const refresh = async () => {
    const [stats, issues] = await Promise.all([
      db.getUploadQueueStats(),
      db.get<{ n: number }>('SELECT count(*) AS n FROM op_issue WHERE acknowledged_at IS NULL'),
    ])
    syncStore.update({ pendingOps: stats.count, openIssues: issues.n })
  }

  const signals: SyncSignals = {
    setAuthProblem: (code) => {
      syncStore.update({ authProblem: code })
      // revoked/invalid: stop talking to the server, keep the data. The badge turns to "Action required".
      if (code) void db.disconnect()
    },
    setUploadProblem: (uploadProblem) => syncStore.update({ uploadProblem }),
    issuesChanged: () => void refresh(),
    uploaded: () => void refresh(),
  }
  const connector = new TarazuConnector({ apiBase: config.apiBase, deviceToken: config.deviceToken, signals })

  db.registerListener({
    statusChanged: (status) =>
      syncStore.update({
        connected: status.connected,
        hasSynced: status.hasSynced ?? false,
        lastSyncedAt: status.lastSyncedAt?.getTime() ?? null,
      }),
  })
  syncStore.update({
    active: true,
    connected: db.currentStatus.connected,
    hasSynced: db.currentStatus.hasSynced ?? false,
    lastSyncedAt: db.currentStatus.lastSyncedAt?.getTime() ?? null,
  })
  void navigator.storage?.persisted?.().then((storagePersistent) => syncStore.update({ storagePersistent }))
  await refresh()
  setInterval(() => void refresh().catch(() => undefined), REFRESH_MS)

  const runtime: SyncRuntime = {
    db,
    writer: new OpLogWriter(db, { deviceId: config.deviceId, storeId: config.storeId }),
    config,
    refresh,
    connect: () => db.connect(connector),
    disconnect: () => db.disconnect(),
    async acknowledgeIssues() {
      await db.execute("UPDATE op_issue SET acknowledged_at = ? WHERE acknowledged_at IS NULL", [new Date().toISOString()])
      await refresh()
    },
  }
  void runtime.connect().catch((e) => console.warn('sync connect failed; will stay local until retried', e))
  return runtime
}

/**
 * For a revoked or unregistered device: stop syncing and forget the credential, but DO NOT wipe the database.
 * Unsent operations are the merchant's sales; they stay on the device (and the badge says "Action required")
 * until the owner registers the device again or exports them. (PowerSync's own disconnectAndClear() deletes
 * local data including the upload queue, so it is deliberately not used here.)
 */
export async function disconnectAndClear(): Promise<void> {
  const runtime = runtimePromise ? await runtimePromise.catch(() => null) : null
  await runtime?.disconnect()
  clearSyncConfig()
  activeConfig = null
  runtimePromise = null
  syncStore.update({ active: false, connected: false })
}

export function currentConfig(): SyncConfig | null {
  return activeConfig
}
