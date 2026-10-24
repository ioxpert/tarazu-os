import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiProblem } from '../auth/api'
import { resolveConfig, saveSyncConfig } from '../sync/config'
import { looksLikePairingCode, redeemPairing } from '../sync/pairing'
import { Banner, Button, Screen } from './components'

/** Server refusals of a pairing code that deserve their own words. */
const PAIRING_ERRORS: Record<string, string> = {
  pairing_invalid: 'setup.codeInvalid',
  pairing_used: 'setup.codeUsed',
  too_many_requests: 'setup.tooMany',
}

/** First run: link this device to the shop with the pairing code (or device token) the owner created. Everything else works offline. */
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
      saveSyncConfig(looksLikePairingCode(token) ? await redeemPairing(apiBase, token) : await resolveConfig(apiBase, token))
      window.location.reload()
    } catch (e) {
      setError(e instanceof ApiProblem && PAIRING_ERRORS[e.code] ? t(PAIRING_ERRORS[e.code]) : t('setup.failed'))
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
