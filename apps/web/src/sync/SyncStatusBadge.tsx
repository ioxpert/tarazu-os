import { deriveSyncState } from './status'
import { useSyncSnapshot } from './syncStore'

/** Always-visible sync indicator. Reads the small store only; no PowerSync import. */
export function SyncStatusBadge() {
  const snapshot = useSyncSnapshot()
  const info = deriveSyncState(snapshot)
  const detail = [...info.reasons, ...info.warnings].join(' ')
  return (
    <span role="status" aria-live="polite" className="sync-badge" data-state={info.state} title={detail}>
      <strong>{info.label}</strong>
      {snapshot.pendingOps > 0 && (
        <span className="sync-badge-count">
          {' '}
          · {snapshot.pendingOps} unsent
        </span>
      )}
      <span className="sr-only"> {detail}</span>
    </span>
  )
}
