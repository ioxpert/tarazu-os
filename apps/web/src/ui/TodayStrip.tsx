import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { position, presetRange, summary, type Position, type Summary } from '../billing/reports'
import { formatRupees } from '../lib/numfmt'
import { useApp } from './app'
import { navigate } from './router'

/** Today's takings on Home; tap for the full reports. Reads the device only, so it is right offline. */
export function TodayStrip() {
  const { t } = useTranslation()
  const { db, items } = useApp()
  const [data, setData] = useState<{ sum: Summary; pos: Position } | null>(null)

  useEffect(() => {
    if (!db) return
    let live = true
    void Promise.all([summary(db, presetRange('today')), position(db)]).then(([sum, pos]) => live && setData({ sum, pos }))
    return () => {
      live = false
    }
  }, [db, items])

  if (!data) return null
  const { sum, pos } = data
  const money = (p: number) => formatRupees(p, { paise: 'auto' })
  return (
    <button type="button" className="row" style={{ width: '100%', textAlign: 'left' }} onClick={() => navigate('/reports')} data-testid="today-strip">
      <span className="row-main" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span className="muted">{t('reports.today')}</span>
        <strong style={{ fontSize: "1.4rem", fontVariantNumeric: "tabular-nums" }} data-testid="today-net">{money(sum.netPaise)}</strong>
        <span className="muted">
          {t('reports.bills', { count: sum.bills })}
          {pos.khataOutstandingPaise > 0 ? ` · ${t('reports.khataOwed', { amount: money(pos.khataOutstandingPaise) })}` : ''}
          {pos.oversoldItems > 0 ? ` · ${t('reports.oversoldCount', { count: pos.oversoldItems })}` : ''}
        </span>
      </span>
    </button>
  )
}
