import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { resolveConfig, saveSyncConfig } from '../sync/config'
import { Banner, Button, Screen } from './components'

/** First run: link this device to the shop with the device token the owner created. Everything else works offline. */
export default function SetupScreen() {
  const { t } = useTranslation()
  const [token, setToken] = useState('')
  const [apiBase, setApiBase] = useState('/api')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const connect = async () => {
    setBusy(true)
    setError(null)
    try {
      saveSyncConfig(await resolveConfig(apiBase, token))
      window.location.reload()
    } catch {
      setError(t('setup.failed'))
      setBusy(false)
    }
  }
  return (
    <Screen testId="setup-screen">
      <div className="screen-body">
        <h1>{t('setup.title')}</h1>
        <p className="muted">{t('setup.explain')}</p>
        <div className="field">
          <label htmlFor="su-token">{t('setup.token')}</label>
          <input id="su-token" className="input" autoCapitalize="off" autoCorrect="off" value={token} onChange={(e) => setToken(e.target.value)} data-testid="setup-token" />
        </div>
        <div className="field">
          <label htmlFor="su-api">{t('setup.server')}</label>
          <input id="su-api" className="input" value={apiBase} onChange={(e) => setApiBase(e.target.value)} />
        </div>
        {error && <Banner kind="error">{error}</Banner>}
        <Button variant="primary" disabled={busy || !token} onClick={() => void connect()}>{t('setup.connect')}</Button>
      </div>
    </Screen>
  )
}
