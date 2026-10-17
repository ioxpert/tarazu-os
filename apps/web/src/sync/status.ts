import type { SyncSnapshot } from './syncStore'

/** The three states a merchant sees (PRD). */
export type SyncState = 'saved_on_device' | 'backed_up' | 'action_required'

export const SYNC_LABEL: Record<SyncState, string> = {
  saved_on_device: 'Saved on this device',
  backed_up: 'Backed up',
  action_required: 'Action required',
}

export interface SyncStateInfo {
  state: SyncState
  label: string
  /** Why, in plain words; shown in the badge detail. */
  reasons: string[]
  /** Non-blocking advice that does not change the state. */
  warnings: string[]
}

/** How long after the last server contact an offline, fully-uploaded device still counts as backed up. */
export const OFFLINE_GRACE_MS = 15 * 60 * 1000

const AUTH_COPY: Record<string, string> = {
  device_revoked: 'This device was revoked by the owner. Sales stay saved here but are no longer sent.',
  invalid_token: 'This device is not signed in to the server any more. Ask the owner to register it again.',
  authentication_required: 'This device is not signed in to the server. Ask the owner to register it again.',
}

export function deriveSyncState(s: SyncSnapshot, now: number = Date.now()): SyncStateInfo {
  const actions: string[] = []
  if (s.authProblem) actions.push(AUTH_COPY[s.authProblem] ?? `The server refused this device (${s.authProblem}).`)
  if (s.uploadProblem) {
    actions.push(`The server refused an upload (${s.uploadProblem.code || s.uploadProblem.status}): ${s.uploadProblem.detail}`)
  }
  if (s.openIssues > 0) {
    actions.push(`${s.openIssues} ${s.openIssues === 1 ? 'entry needs' : 'entries need'} your attention (rejected or flagged by the server).`)
  }

  const warnings: string[] = []
  if (s.storagePersistent === false && s.pendingOps > 0) {
    warnings.push('Browser storage is not protected from eviction. Install the app to keep unsent sales safe.')
  }

  if (actions.length > 0) {
    return { state: 'action_required', label: SYNC_LABEL.action_required, reasons: actions, warnings }
  }

  const saved: string[] = []
  if (s.pendingOps > 0) saved.push(`${s.pendingOps} ${s.pendingOps === 1 ? 'entry is' : 'entries are'} waiting to be sent.`)
  if (!s.hasSynced) saved.push('This device has not synced with the server yet.')
  else if (!s.connected && (s.lastSyncedAt === null || now - s.lastSyncedAt > OFFLINE_GRACE_MS)) {
    saved.push('Offline. Everything is saved on this device and will be sent when the connection returns.')
  }
  if (saved.length > 0) {
    return { state: 'saved_on_device', label: SYNC_LABEL.saved_on_device, reasons: saved, warnings }
  }
  return { state: 'backed_up', label: SYNC_LABEL.backed_up, reasons: ['Everything on this device has reached the server.'], warnings }
}
