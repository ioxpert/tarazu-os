import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatRupees } from '../lib/numfmt'
import { useApp } from './app'
import { Header, Screen } from './components'
import { listOwing, type PartyRow } from './parties'

/** Phase 1 shows only who owes what (the receivables created by credit sales). Collections and statements come later. */
export default function KhataScreen() {
  const { t } = useTranslation()
  const app = useApp()
  const [rows, setRows] = useState<PartyRow[]>([])
  useEffect(() => {
    if (app.db) void listOwing(app.db).then(setRows)
  }, [app.db])
  const total = rows.reduce((a, r) => a + r.balancePaise, 0)
  return (
    <Screen testId="khata-screen">
      <Header title={t('khata.title')} />
      <div className="screen-body">
        <div className="total-line"><span>{t('khata.totalOwed')}</span><strong className="num" data-testid="khata-total">{formatRupees(total, { paise: 'auto' })}</strong></div>
        {rows.length === 0 && <p className="muted">{t('khata.none')}</p>}
        <ul className="list" data-testid="khata-list">
          {rows.map((r) => (
            <li key={r.id} className="row" data-testid="khata-row">
              <span className="row-main"><span className="row-title">{r.name}</span><span className="muted">{r.phone ?? ''}</span></span>
              <strong className="num">{t('khata.owes', { amount: formatRupees(r.balancePaise, { paise: 'auto' }) })}</strong>
            </li>
          ))}
        </ul>
        <p className="muted">{t('khata.comingSoon')}</p>
      </div>
    </Screen>
  )
}
