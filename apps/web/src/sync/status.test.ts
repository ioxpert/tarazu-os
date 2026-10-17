import { describe, expect, it } from 'vitest'
import { deriveSyncState, OFFLINE_GRACE_MS, SYNC_LABEL } from './status'
import type { SyncSnapshot } from './syncStore'

const NOW = 1_000_000_000
const base: SyncSnapshot = {
  pendingOps: 0,
  connected: true,
  hasSynced: true,
  lastSyncedAt: NOW - 1000,
  authProblem: null,
  uploadProblem: null,
  openIssues: 0,
  storagePersistent: true,
  active: true,
}
const derive = (p: Partial<SyncSnapshot>) => deriveSyncState({ ...base, ...p }, NOW)

describe('deriveSyncState', () => {
  it('uses the exact copy', () => {
    expect(SYNC_LABEL).toEqual({
      saved_on_device: 'Saved on this device',
      backed_up: 'Backed up',
      action_required: 'Action required',
    })
  })

  it('is backed up when connected, synced and the queue is empty', () => {
    expect(derive({}).state).toBe('backed_up')
  })

  it('is saved on this device while operations are pending', () => {
    const r = derive({ pendingOps: 3 })
    expect(r.state).toBe('saved_on_device')
    expect(r.reasons[0]).toContain('3 entries are waiting')
  })

  it('is saved on this device before the first sync', () => {
    expect(derive({ hasSynced: false, lastSyncedAt: null }).state).toBe('saved_on_device')
  })

  it('stays backed up briefly offline with an empty queue, then reverts to saved on device', () => {
    expect(derive({ connected: false, lastSyncedAt: NOW - 1000 }).state).toBe('backed_up')
    expect(derive({ connected: false, lastSyncedAt: NOW - OFFLINE_GRACE_MS - 1 }).state).toBe('saved_on_device')
  })

  it('needs action when the device is revoked, even with pending ops', () => {
    const r = derive({ authProblem: 'device_revoked', pendingOps: 5 })
    expect(r.state).toBe('action_required')
    expect(r.reasons[0]).toContain('revoked')
  })

  it('needs action for an unrecoverable upload refusal or open issues', () => {
    expect(derive({ uploadProblem: { status: 403, code: 'local_only_mode', detail: 'local-only' } }).state).toBe('action_required')
    expect(derive({ openIssues: 2 }).reasons[0]).toContain('2 entries need')
    expect(derive({ openIssues: 1 }).reasons[0]).toContain('1 entry needs')
  })

  it('warns, without changing state, about unprotected storage with unsent data', () => {
    const r = derive({ storagePersistent: false, pendingOps: 1 })
    expect(r.state).toBe('saved_on_device')
    expect(r.warnings).toHaveLength(1)
    expect(derive({ storagePersistent: false }).warnings).toHaveLength(0)
  })
})
