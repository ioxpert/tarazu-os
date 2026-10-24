import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiProblem } from '../auth/api'
import { createPairing, type PairingCreated } from '../sync/pairing'
import { useApp } from './app'
import { Banner, Button } from './components'

interface Owner {
  id: string
  display_name: string
}

const ERRORS: Record<string, string> = {
  invalid_pin: 'pair.wrongPin',
  pin_locked: 'pair.locked',
  pin_not_set: 'pair.noPin',
  pairing_not_configured: 'pair.notConfigured',
}

function minutesLeft(expiresAt: string, now: number): number {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 60_000))
}

/** Owner makes a one-time code for another counter (docs/adr/0015). Needs the internet and the owner's PIN. */
export function PairCounter() {
  const { t } = useTranslation()
  const app = useApp()
  const [owners, setOwners] = useState<Owner[]>([])
  const [ownerId, setOwnerId] = useState('')
  const [pin, setPin] = useState('')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [made, setMade] = useState<PairingCreated | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!app.db) return
    void app.db.getAll<Owner>('SELECT id, display_name FROM approver ORDER BY display_name').then((rows) => {
      setOwners(rows)
      setOwnerId((cur) => cur || rows[0]?.id || '')
    })
  }, [app.db])

  useEffect(() => {
    if (!made) return
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [made])

  const submit = async () => {
    if (!app.config || !ownerId || !pin) return
    setBusy(true)
    setError(null)
    try {
      setMade(await createPairing(app.config, { userId: ownerId, pin }, label))
      setNow(Date.now())
      setPin('')
    } catch (e) {
      setError(e instanceof ApiProblem && ERRORS[e.code] ? ERRORS[e.code] : e instanceof ApiProblem ? 'pair.failed' : 'pair.offline')
      setPin('')
    } finally {
      setBusy(false)
    }
  }

  const left = made ? minutesLeft(made.expiresAt, now) : 0

  return (
    <section className="field" data-testid="pair-counter">
      <span className="label">{t('pair.title')}</span>
      {made ? (
        <>
          <p className="hint">{t('pair.explain')}</p>
          <div className="row" style={{ justifyContent: 'center' }}>
            <strong style={{ fontSize: 36, letterSpacing: 4, fontVariantNumeric: 'tabular-nums' }} data-testid="pair-code">{made.code}</strong>
          </div>
          <span className="hint">{left > 0 ? t('pair.expires', { count: left }) : t('pair.expired')}</span>
          <Button onClick={() => { setMade(null); setLabel('') }} data-testid="pair-another">{t('pair.another')}</Button>
        </>
      ) : (
        <>
          <p className="hint">{t('pair.hint')}</p>
          {error && <Banner kind="error">{t(error)}</Banner>}
          {owners.length === 0 ? (
            <span className="muted">{t('pair.noOwners')}</span>
          ) : (
            <>
              {owners.length > 1 && (
                <div className="chips" role="group" aria-label={t('pair.owner')}>
                  {owners.map((o) => <button type="button" key={o.id} className="chip" aria-pressed={ownerId === o.id} onClick={() => setOwnerId(o.id)}>{o.display_name}</button>)}
                </div>
              )}
              <label htmlFor="pair-label">{t('pair.label')}</label>
              <input id="pair-label" className="input" maxLength={100} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('pair.labelPlaceholder')} />
              <label htmlFor="pair-pin">{t('pair.pin', { name: owners.find((o) => o.id === ownerId)?.display_name ?? '' })}</label>
              <input id="pair-pin" className="input num" type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)} data-testid="pair-pin" />
              <Button variant="primary" onClick={() => void submit()} disabled={busy || !pin || !app.config} data-testid="pair-make">{t('pair.make')}</Button>
            </>
          )}
        </>
      )}
    </section>
  )
}
