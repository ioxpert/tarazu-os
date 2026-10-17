import { lazy, Suspense, useEffect, useState } from 'react'
import { fetchApiHealth } from './lib/health'
import { requestPersistence, type StorageStatus } from './lib/storage'
import { SyncStatusBadge } from './sync/SyncStatusBadge'

const HARNESS_ENABLED = import.meta.env.DEV || import.meta.env.VITE_ENABLE_DEV_HARNESS === 'true'
// Lazy: the harness (and PowerSync with SQLite WASM behind it) never loads unless this route is opened.
const SyncHarness = lazy(() => import('./dev/SyncHarness'))
const OnboardingPage = lazy(() => import('./onboarding/OnboardingPage'))

function useOnline() {
  const [online, setOnline] = useState(() => navigator.onLine)
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])
  return online
}

export function App() {
  const harness = HARNESS_ENABLED && window.location.hash === '#/dev/sync'
  const onboarding = window.location.hash === '#/onboarding'
  const online = useOnline()
  const [storage, setStorage] = useState<StorageStatus | null>(null)
  const [api, setApi] = useState<'checking' | 'up' | 'down'>('checking')

  useEffect(() => {
    void requestPersistence().then(setStorage)
  }, [])

  useEffect(() => {
    if (!online) return
    const ctrl = new AbortController()
    fetchApiHealth(ctrl.signal)
      .then((status) => setApi(status === 'UP' ? 'up' : 'down'))
      .catch(() => setApi('down'))
    return () => ctrl.abort()
  }, [online])

  if (onboarding) {
    return (
      <Suspense fallback={<p>Loading…</p>}>
        <OnboardingPage />
      </Suspense>
    )
  }

  if (harness) {
    return (
      <Suspense fallback={<p>Loading harness…</p>}>
        <SyncHarness />
      </Suspense>
    )
  }

  return (
    <main className="shell">
      <h1>Tarazu OS</h1>
      <p className="tagline">Billing, stock and khata that keep working offline.</p>
      <ul className="status" aria-label="System status">
        <li data-ok={online}>
          Network: <strong>{online ? 'online' : 'offline (billing keeps working)'}</strong>
        </li>
        <li data-ok={storage?.persisted ?? false}>
          Local storage:{' '}
          <strong>
            {storage === null
              ? 'checking'
              : !storage.supported
                ? 'unsupported browser, use Chrome or Edge'
                : storage.persisted
                  ? `persistent (${storage.usageMb} MB of ${storage.quotaMb} MB)`
                  : 'not persistent, install the app to protect data'}
          </strong>
        </li>
        <li>
          Sync: <SyncStatusBadge />
        </li>
        <li data-ok={api === 'up'}>
          Server: <strong>{!online ? 'unreachable (offline)' : api}</strong>
        </li>
      </ul>
    </main>
  )
}
