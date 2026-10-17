import { lazy, Suspense, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { requestPersistence } from './lib/storage'
import { AppProvider, useApp } from './ui/app'
import { Banner } from './ui/components'
import HomeScreen from './ui/Home'
import { useRoute } from './ui/router'

const HARNESS_ENABLED = import.meta.env.DEV || import.meta.env.VITE_ENABLE_DEV_HARNESS === 'true'
// Lazy: the harness (and PowerSync with SQLite WASM behind it) never loads unless this route is opened.
const SyncHarness = lazy(() => import('./dev/SyncHarness'))

// Every screen but Home is its own chunk: the first load stays small and the rest is precached by the service worker.
const BillScreen = lazy(() => import('./ui/Bill'))
const TenderScreen = lazy(() => import('./ui/Tender'))
const ReceiptScreen = lazy(() => import('./ui/Receipt'))
const ReturnsScreen = lazy(() => import('./ui/Returns'))
const StockScreen = lazy(() => import('./ui/Stock'))
const ItemFormScreen = lazy(() => import('./ui/ItemForm'))
const ItemDetailScreen = lazy(() => import('./ui/Stock').then((m) => ({ default: ItemDetailRoute(m.ItemDetail) })))
const KhataScreen = lazy(() => import('./ui/Khata'))
const ShiftScreen = lazy(() => import('./ui/Shift'))
const SettingsScreen = lazy(() => import('./ui/Settings'))
const SetupScreen = lazy(() => import('./ui/Setup'))
// Sign-up / login with a one-time code; registers this device and stores its sync config.
const OtpOnboardingPage = lazy(() => import('./onboarding/OnboardingPage'))
const OnboardingScreen = lazy(() => import('./ui/Onboarding'))

function ItemDetailRoute(Detail: (p: { id: string }) => React.ReactElement) {
  return function Route() {
    const r = useRoute()
    return <Detail id={r.segments[2] ?? ''} />
  }
}

function Routes() {
  const { t } = useTranslation()
  const app = useApp()
  const route = useRoute()
  const first = route.segments[0] ?? ''

  if (app.status === 'no_config') return <SetupScreen />
  if (app.status === 'starting') return <p role="status" style={{ padding: 16 }}>{t('common.loading')}</p>
  if (app.status === 'error') return <div style={{ padding: 16 }}><Banner kind="error">{t('app.startFailed')}</Banner></div>

  const skipped = (() => {
    try {
      return sessionStorage.getItem('tarazu.skipOnboarding') === '1'
    } catch {
      return false
    }
  })()
  if (!app.hasCatalogue && !skipped && first === '') return <OnboardingScreen />

  switch (first) {
    case 'bill': return <BillScreen />
    case 'tender': return <TenderScreen />
    case 'receipt': return <ReceiptScreen />
    case 'returns': return <ReturnsScreen />
    case 'stock':
      if (route.segments[1] === 'new') return <ItemFormScreen />
      if (route.segments[1] === 'item') return <ItemDetailScreen />
      return <StockScreen />
    case 'khata': return <KhataScreen />
    case 'shift': return <ShiftScreen />
    case 'settings': return <SettingsScreen />
    default: return <HomeScreen />
  }
}

export function App() {
  const { t } = useTranslation()
  const harness = HARNESS_ENABLED && window.location.hash === '#/dev/sync'
  const otpOnboarding = window.location.hash === '#/onboarding'

  useEffect(() => {
    void requestPersistence()
  }, [])

  if (otpOnboarding) {
    return (
      <Suspense fallback={<p>{t('common.loading')}</p>}>
        <OtpOnboardingPage />
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
    <AppProvider>
      <div className="app">
        <Suspense fallback={<p role="status" style={{ padding: 16 }}>{t('common.loading')}</p>}>
          <Routes />
        </Suspense>
      </div>
    </AppProvider>
  )
}
