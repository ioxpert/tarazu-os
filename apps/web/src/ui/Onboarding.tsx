import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { seedStarterPack } from '../catalogue/seed'
import type { StoreType } from '../catalogue/starterPack/types'
import { useApp } from './app'
import { Banner, BigTile, Screen } from './components'
import { navigate } from './router'

/** "What kind of shop is this?" Seeds ~500 ready-to-bill items locally (no network). Skipping starts with an empty shelf. */
export default function OnboardingScreen() {
  const { t } = useTranslation()
  const app = useApp()
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState(false)

  const pick = async (type: StoreType) => {
    if (!app.rt || !app.db) return
    setError(false)
    setProgress({ done: 0, total: 1 })
    try {
      await seedStarterPack(
        app.rt.writer,
        app.db,
        { tenantId: app.rt.config.tenantId, storeId: app.rt.config.storeId, deviceId: app.rt.config.deviceId, actorUserId: app.rt.config.actorUserId },
        type,
        setProgress,
      )
      void app.rt.refresh()
      await app.reload()
      navigate('/')
    } catch {
      setError(true)
      setProgress(null)
    }
  }

  return (
    <Screen testId="onboarding-screen">
      <div className="screen-body">
        <h1>{t('onboarding.title')}</h1>
        <p className="muted">{t('onboarding.explain')}</p>
        {progress ? (
          <Banner kind="info">
            <span role="status" data-testid="seed-progress">{t('onboarding.loading', { done: progress.done, total: progress.total })}</span>
          </Banner>
        ) : (
          <div className="home" style={{ padding: 0 }}>
            <BigTile icon="stock" label={t('onboarding.grocery')} onClick={() => void pick('grocery')} testId="pack-grocery" />
            <BigTile icon="bill" label={t('onboarding.general')} onClick={() => void pick('general')} testId="pack-general" />
          </div>
        )}
        {error && <Banner kind="error">{t('onboarding.failed')}</Banner>}
        {!progress && <button type="button" className="btn btn-ghost" onClick={() => { void app.reload().then(() => navigate('/')); sessionStorage.setItem('tarazu.skipOnboarding', '1') }}>{t('onboarding.skip')}</button>}
      </div>
    </Screen>
  )
}
