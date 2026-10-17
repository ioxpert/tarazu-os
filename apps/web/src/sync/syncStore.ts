import { useSyncExternalStore } from 'react'

/**
 * Tiny observable the sync runtime updates and the UI reads. Deliberately free of PowerSync imports so the
 * status badge costs the first-load bundle almost nothing; the SQLite WASM runtime is loaded lazily.
 */
export interface SyncSnapshot {
  /** Operations queued on this device and not yet acknowledged by the server. */
  pendingOps: number
  connected: boolean
  hasSynced: boolean
  lastSyncedAt: number | null
  /** Credential problem code (device_revoked, invalid_token, ...): sync is stopped until fixed. */
  authProblem: string | null
  /** Last whole-request upload failure that retrying will not fix (e.g. 403 local_only_mode). */
  uploadProblem: { status: number; code: string; detail: string } | null
  /** Rejected/flagged operations the merchant has not acknowledged. */
  openIssues: number
  storagePersistent: boolean | null
  /** Has a runtime been started (config present)? Without one nothing syncs. */
  active: boolean
}

const INITIAL: SyncSnapshot = {
  pendingOps: 0,
  connected: false,
  hasSynced: false,
  lastSyncedAt: null,
  authProblem: null,
  uploadProblem: null,
  openIssues: 0,
  storagePersistent: null,
  active: false,
}

let snapshot: SyncSnapshot = INITIAL
const listeners = new Set<() => void>()

export const syncStore = {
  getSnapshot: (): SyncSnapshot => snapshot,
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  update(patch: Partial<SyncSnapshot>): void {
    const next = { ...snapshot, ...patch }
    if ((Object.keys(next) as (keyof SyncSnapshot)[]).every((k) => Object.is(next[k], snapshot[k]))) return
    snapshot = next
    listeners.forEach((l) => l())
  },
  reset(): void {
    snapshot = INITIAL
    listeners.forEach((l) => l())
  },
}

export function useSyncSnapshot(): SyncSnapshot {
  return useSyncExternalStore(syncStore.subscribe, syncStore.getSnapshot)
}
