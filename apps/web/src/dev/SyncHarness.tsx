import { useCallback, useEffect, useState } from 'react'
import { SyncStatusBadge } from '../sync/SyncStatusBadge'
import { loadSyncConfig, resolveConfig, saveSyncConfig, clearSyncConfig } from '../sync/config'
import { useSyncSnapshot } from '../sync/syncStore'
import { uuidv7 } from '../sync/uuid7'
import { buildCatalogue, buildSale, percentile, type SaleContext } from './testSale'
import type { SyncRuntime } from '../sync/runtime'

/**
 * Developer harness at #/dev/sync (dev builds, or VITE_ENABLE_DEV_HARNESS=true). Not product UI.
 * Lazy-loaded: nothing here, and none of PowerSync / SQLite WASM, is in the first-load bundle.
 */
interface Issue {
  id: string
  severity: string
  code: string | null
  detail: string | null
  entity_type: string | null
  created_at: string
}

const IDS_KEY = 'tarazu.harness.ids'

function harnessIds(): { productId: string; partyId: string; nextInvoice: number } {
  try {
    const raw = localStorage.getItem(IDS_KEY)
    if (raw) return JSON.parse(raw)
  } catch {
    // fall through to fresh ids
  }
  return { productId: uuidv7(), partyId: uuidv7(), nextInvoice: 1 }
}

export default function SyncHarness() {
  const snapshot = useSyncSnapshot()
  const [token, setToken] = useState(() => loadSyncConfig()?.deviceToken ?? '')
  const [apiBase, setApiBase] = useState(() => loadSyncConfig()?.apiBase ?? '/api')
  const [runtime, setRuntime] = useState<SyncRuntime | null>(null)
  const [message, setMessage] = useState('')
  const [latencies, setLatencies] = useState<number[]>([])
  const [issues, setIssues] = useState<Issue[]>([])
  const [busy, setBusy] = useState(false)

  const start = useCallback(async () => {
    const rt = await (await import('../sync/runtime')).getSyncRuntime()
    setRuntime(rt)
    return rt
  }, [])

  useEffect(() => {
    if (!loadSyncConfig()) return
    let live = true
    import('../sync/runtime')
      .then((m) => m.getSyncRuntime())
      .then((rt) => live && setRuntime(rt))
      .catch((e) => live && setMessage(String(e)))
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    if (!runtime) return
    let live = true
    runtime.db
      .getAll<Issue>('SELECT id, severity, code, detail, entity_type, created_at FROM op_issue WHERE acknowledged_at IS NULL ORDER BY created_at DESC LIMIT 50')
      .then((rows) => live && setIssues(rows))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [runtime, snapshot.openIssues])

  async function connect() {
    try {
      setMessage('Checking token…')
      saveSyncConfig(await resolveConfig(apiBase, token))
      await start()
      setMessage('Connected (or working offline).')
    } catch (e) {
      setMessage(String(e))
    }
  }

  async function disconnect() {
    const m = await import('../sync/runtime')
    await m.disconnectAndClear()
    setRuntime(null)
    setMessage('Disconnected. Local data kept.')
  }

  function saleContext(rt: SyncRuntime, ids: ReturnType<typeof harnessIds>): SaleContext {
    return { tenantId: rt.config.tenantId, storeId: rt.config.storeId, deviceId: rt.config.deviceId, productId: ids.productId, partyId: ids.partyId, number: ids.nextInvoice }
  }

  async function ensureCatalogue(rt: SyncRuntime, ids: ReturnType<typeof harnessIds>) {
    if (localStorage.getItem(IDS_KEY)) return
    await rt.writer.writeAll(buildCatalogue(ids))
    localStorage.setItem(IDS_KEY, JSON.stringify(ids))
  }

  async function sales(count: number) {
    if (!runtime) return
    setBusy(true)
    try {
      const ids = harnessIds()
      await ensureCatalogue(runtime, ids)
      const times: number[] = []
      for (let i = 0; i < count; i++) {
        const t0 = performance.now()
        await runtime.writer.writeAll(buildSale(saleContext(runtime, ids)))
        times.push(performance.now() - t0)
        ids.nextInvoice++
      }
      localStorage.setItem(IDS_KEY, JSON.stringify(ids))
      await runtime.refresh()
      setLatencies(times)
    } finally {
      setBusy(false)
    }
  }

  const p50 = percentile(latencies, 50)
  const p95 = percentile(latencies, 95)

  return (
    <main className="shell" data-testid="sync-harness">
      <h1>Sync harness</h1>
      <p className="tagline">Developer tool: exercises the local op log and PowerSync wiring.</p>
      <p>
        <SyncStatusBadge />
      </p>

      <fieldset>
        <legend>Device</legend>
        <label>
          API base <input value={apiBase} onChange={(e) => setApiBase(e.target.value)} />
        </label>
        <label>
          Device token <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="tzd.<tenant>.<device>.<secret>" size={60} />
        </label>
        <button onClick={() => void connect()}>Connect</button> <button onClick={() => void disconnect()}>Disconnect (keep data)</button>{' '}
        <button onClick={() => { clearSyncConfig(); setToken(''); setMessage('Config forgotten.') }}>Forget config</button>
        <p role="note">{message}</p>
      </fieldset>

      <fieldset disabled={!runtime || busy}>
        <legend>Record</legend>
        <button onClick={() => void sales(1)}>Record test sale</button> <button onClick={() => void sales(334)}>Record 1,000 ops</button>
        {latencies.length > 0 && (
          <p data-testid="latency">
            Last run: {latencies.length} commits, P50 {p50.toFixed(1)} ms, P95 {p95.toFixed(1)} ms{' '}
            <strong>{p95 < 300 ? '(within the 300 ms budget)' : '(OVER the 300 ms budget)'}</strong>
          </p>
        )}
      </fieldset>

      <ul className="status" aria-label="Sync details">
        <li>Unsent operations: <strong data-testid="pending">{snapshot.pendingOps}</strong></li>
        <li>Connected: <strong>{String(snapshot.connected)}</strong></li>
        <li>Last synced: <strong>{snapshot.lastSyncedAt ? new Date(snapshot.lastSyncedAt).toLocaleString() : 'never'}</strong></li>
        <li>Auth problem: <strong>{snapshot.authProblem ?? 'none'}</strong></li>
        <li>Upload problem: <strong>{snapshot.uploadProblem ? `${snapshot.uploadProblem.code}: ${snapshot.uploadProblem.detail}` : 'none'}</strong></li>
        <li>Storage persistent: <strong>{String(snapshot.storagePersistent)}</strong></li>
      </ul>

      <h2>Server issues ({issues.length})</h2>
      <ul>
        {issues.map((i) => (
          <li key={i.id}>
            <strong>{i.severity}</strong> {i.entity_type} {i.code} {i.detail}
          </li>
        ))}
      </ul>
      {issues.length > 0 && runtime && <button onClick={() => void runtime.acknowledgeIssues()}>Acknowledge all</button>}
    </main>
  )
}
