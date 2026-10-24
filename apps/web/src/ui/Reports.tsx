import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { dailySales, itemSales, presetRange, summary, type DailySales, type DateRange, type ItemSales, type RangePreset, type Summary } from '../billing/reports'
import { formatQtyNumber, formatRupees } from '../lib/numfmt'
import { useApp } from './app'
import { Header, Screen } from './components'

type Range = RangePreset | 'custom'
type Tab = 'daily' | 'items'
const RANGES: Range[] = ['today', 'week', 'month', 'custom']
const ITEM_ROWS = 100
const money = (p: number) => formatRupees(p, { paise: 'auto' })

/** Sales reports for the shop, read from this device: they work offline and include other counters after sync. */
export default function ReportsScreen() {
  const { t } = useTranslation()
  const app = useApp()
  const [range, setRange] = useState<Range>('today')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [tab, setTab] = useState<Tab>('daily')
  const [sum, setSum] = useState<Summary | null>(null)
  const [days, setDays] = useState<DailySales[]>([])
  const [items, setItems] = useState<ItemSales[]>([])

  const dates = useMemo<DateRange | null>(() => {
    if (range !== 'custom') return presetRange(range)
    return from && to && from <= to ? { fromDate: from, toDate: to } : null
  }, [range, from, to])

  useEffect(() => {
    if (!app.db || !dates) return
    let live = true
    void Promise.all([summary(app.db, dates), dailySales(app.db, dates), itemSales(app.db, dates)]).then(([s, d, i]) => {
      if (!live) return
      setSum(s)
      setDays(d)
      setItems(i)
    })
    return () => {
      live = false
    }
  }, [app.db, dates])

  const empty = sum !== null && sum.bills === 0 && sum.returnsPaise === 0

  return (
    <Screen testId="reports-screen">
      <Header title={t('reports.title')} />
      <div className="screen-body">
        <div className="chips" role="group" aria-label={t('reports.range')}>
          {RANGES.map((r) => (
            <button key={r} type="button" className="chip" aria-pressed={range === r} onClick={() => setRange(r)} data-testid={`rep-range-${r}`}>{t(`reports.ranges.${r}`)}</button>
          ))}
        </div>
        {range === 'custom' && (
          <div className="tender-row">
            <input className="input" type="date" aria-label={t('history.from')} value={from} onChange={(e) => setFrom(e.target.value)} />
            <input className="input" type="date" aria-label={t('history.to')} value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        )}
        {range === 'custom' && !dates && <p className="muted">{t('reports.pickDates')}</p>}
        {dates && sum && (
          <>
            <section className="field" data-testid="rep-summary">
              <div className="row"><span className="row-main">{t('reports.net')}</span><strong className="num" data-testid="rep-net">{money(sum.netPaise)}</strong></div>
              <div className="row"><span className="row-main">{t('reports.sales')} · {t('reports.bills', { count: sum.bills })}</span><span className="num">{money(sum.salesPaise)}</span></div>
              {sum.returnsPaise > 0 && <div className="row"><span className="row-main">{t('reports.returns')}</span><span className="num">−{money(sum.returnsPaise)}</span></div>}
              {(['cash', 'upi', 'card'] as const).filter((m) => sum.byMode[m] !== 0).map((m) => (
                <div className="row" key={m}><span className="row-main muted">{t(`history.mode.${m}`)}</span><span className="num">{money(sum.byMode[m])}</span></div>
              ))}
              {sum.creditPaise > 0 && <div className="row"><span className="row-main muted">{t('history.mode.credit')}</span><span className="num">{money(sum.creditPaise)}</span></div>}
            </section>
            <div className="chips" role="group">
              {(['daily', 'items'] as const).map((x) => (
                <button key={x} type="button" className="chip" aria-pressed={tab === x} onClick={() => setTab(x)} data-testid={`rep-tab-${x}`}>{t(`reports.tabs.${x}`)}</button>
              ))}
            </div>
            {empty && <p className="muted" data-testid="rep-empty">{t('reports.empty')}</p>}
            {tab === 'daily' && days.length > 0 && (
              <ul className="list" data-testid="rep-daily">
                {[...days].reverse().map((d) => (
                  <li key={d.date} className="row">
                    <span className="row-main" style={{ display: 'flex', flexDirection: 'column' }}>
                      <span className="row-title">{d.date}</span>
                      <span className="muted">{t('reports.bills', { count: d.bills })}{d.returnsPaise > 0 ? ` · ${t('reports.returns')} ${money(d.returnsPaise)}` : ''}</span>
                    </span>
                    <strong className="num">{money(d.netPaise)}</strong>
                  </li>
                ))}
              </ul>
            )}
            {tab === 'items' && items.length > 0 && (
              <ul className="list" data-testid="rep-items">
                {items.slice(0, ITEM_ROWS).map((i) => (
                  <li key={i.productId} className="row">
                    <span className="row-main" style={{ display: 'flex', flexDirection: 'column' }}>
                      <span className="row-title">{i.name}</span>
                      <span className="muted">{formatQtyNumber(i.netQtyMilli)}{i.netQtyMilli > 0 ? ` · ${t('reports.avg')} ${money(i.avgPricePaise)}` : ''}</span>
                    </span>
                    <strong className="num">{money(i.netPaise)}</strong>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </Screen>
  )
}
