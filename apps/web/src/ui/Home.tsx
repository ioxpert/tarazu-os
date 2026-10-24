import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSyncSnapshot } from '../sync/syncStore'
import { SyncStatusBadge } from '../sync/SyncStatusBadge'
import { useApp } from './app'
import { PendingShares } from './PendingShares'
import { Button, BigTile, Screen } from './components'
import { navigate } from './router'
import { TodayStrip } from './TodayStrip'

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

/** Three actions only: Bill, Khata, Stock. Everything else is one small step away. */
export default function HomeScreen() {
  const { t } = useTranslation()
  const app = useApp()
  const online = useOnline()
  const sync = useSyncSnapshot()
  return (
    <Screen testId="home-screen">
      <div className="status-strip">
        <span className="offline-pill" data-testid="net-state">{online ? t('home.online') : t('home.offline')}</span>
        <SyncStatusBadge />
        {sync.pendingOps > 0 && <span>{t('home.unsent', { count: sync.pendingOps })}</span>}
      </div>
      <PendingShares />
      <TodayStrip />
      <div className="home">
        <BigTile icon="bill" label={t('home.bill')} onClick={() => navigate('/bill')} testId="home-bill" />
        <BigTile icon="khata" label={t('home.khata')} onClick={() => navigate('/khata')} testId="home-khata" />
        <BigTile icon="stock" label={t('home.stock')} onClick={() => navigate('/stock')} testId="home-stock" />
      </div>
      <div className="screen-footer" style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
        <Button variant="ghost" onClick={() => navigate('/history')} data-testid="home-history">{t('home.history')}</Button>
        <Button variant="ghost" onClick={() => navigate('/reports')} data-testid="home-reports">{t('home.reports')}</Button>
        <Button variant="ghost" onClick={() => navigate('/returns')} data-testid="home-returns">{t('home.returns')}</Button>
        <Button variant="ghost" onClick={() => navigate('/shift')} data-testid="home-shift">{t('home.shift')}</Button>
        <Button variant="ghost" icon="gear" onClick={() => navigate('/settings')} data-testid="home-settings">{t('home.settings')}</Button>
        <span className="muted">{app.profile.businessName}</span>
      </div>
    </Screen>
  )
}
