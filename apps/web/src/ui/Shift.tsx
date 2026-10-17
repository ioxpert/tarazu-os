import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { closeShift, currentShift, openShift, type Shift, type ShiftCloseResult } from '../billing/shift'
import { formatRupees, parseRupeesToPaise } from '../lib/numfmt'
import { useApp } from './app'
import { Banner, Button, Header, Keypad, Screen } from './components'
import { errorText } from './common'

interface ClosedRow {
  id: string
  opening: number
  declared: number
  expected: number
  variance: number
  closed_at: string
}

/** Shift and cash: opening float, closing declaration, and the variance the owner reviews. */
export default function ShiftScreen() {
  const { t } = useTranslation()
  const app = useApp()
  const [shift, setShift] = useState<Shift | null>(null)
  const [history, setHistory] = useState<ClosedRow[]>([])
  const [text, setText] = useState('')
  const [result, setResult] = useState<ShiftCloseResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!app.db) return
    setShift(await currentShift(app.db))
    setHistory(
      await app.db.getAll<ClosedRow>(
        `SELECT c.id AS id, s.opening_cash_paise AS opening, c.declared_cash_paise AS declared, c.expected_cash_paise AS expected,
                c.variance_paise AS variance, c.closed_at AS closed_at
         FROM shift_close c LEFT JOIN shift s ON s.id = c.shift_id ORDER BY c.closed_at DESC LIMIT 20`,
      ),
    )
  }, [app.db])
  useEffect(() => {
    void load()
  }, [load])

  const identity = app.rt ? { tenantId: app.rt.config.tenantId, storeId: app.rt.config.storeId, deviceId: app.rt.config.deviceId } : null
  const amount = parseRupeesToPaise(text || '0')

  const act = async () => {
    if (!app.rt || !identity || amount === null) return
    setError(null)
    try {
      if (!shift) await openShift(app.rt.writer, { openingCashPaise: amount, identity, actorUserId: app.rt.config.actorUserId ?? null, now: Date.now() })
      else setResult(await closeShift(app.rt.writer, { declaredCashPaise: amount, identity, actorUserId: app.rt.config.actorUserId ?? null, now: Date.now() }))
      setText('')
      void app.rt.refresh()
      await load()
    } catch (e) {
      setError(errorText(t, e))
    }
  }

  return (
    <Screen testId="shift-screen">
      <Header title={t('shift.title')} />
      <div className="screen-body">
        {result && (
          <Banner kind={result.variancePaise === 0 ? 'ok' : 'warning'}>
            <strong data-testid="shift-result">
              {result.variancePaise === 0 ? t('shift.balanced') : result.variancePaise > 0 ? t('shift.over', { amount: formatRupees(result.variancePaise) }) : t('shift.short', { amount: formatRupees(-result.variancePaise) })}
            </strong>
          </Banner>
        )}
        <h2>{shift ? t('shift.closeTitle') : t('shift.openTitle')}</h2>
        <p className="muted">{shift ? t('shift.closeHint') : t('shift.openHint')}</p>
        <div className="input num" data-testid="shift-display">{text ? `₹${text}` : ' '}</div>
        <Keypad value={text} onChange={setText} decimal />
        {error && <Banner kind="error">{error}</Banner>}
        <Button variant="primary" onClick={() => void act()} disabled={amount === null || (!shift && text === '')} data-testid="shift-act">{shift ? t('shift.close') : t('shift.open')}</Button>
        <h2>{t('shift.history')}</h2>
        {history.length === 0 && <p className="muted">{t('shift.noHistory')}</p>}
        <ul className="list">
          {history.map((h) => (
            <li key={h.id} className="row" data-testid="shift-row">
              <span className="row-main"><span className="row-title">{new Date(h.closed_at).toLocaleString()}</span><span className="muted">{t('shift.rowDetail', { declared: formatRupees(Number(h.declared)), expected: formatRupees(Number(h.expected)) })}</span></span>
              {Number(h.variance) === 0 ? <span className="badge badge-ok">{t('shift.balanced')}</span> : <span className="badge badge-warn">{Number(h.variance) > 0 ? t('shift.over', { amount: formatRupees(Number(h.variance)) }) : t('shift.short', { amount: formatRupees(-Number(h.variance)) })}</span>}
            </li>
          ))}
        </ul>
      </div>
    </Screen>
  )
}
