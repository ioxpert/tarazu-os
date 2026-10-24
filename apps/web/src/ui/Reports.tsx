import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { dailySales, dayBook, itemSales, presetRange, profitReport, stockReport, stockValue, summary, type DailySales, type DateRange, type DayBook, type ItemSales, type ProfitReport, type RangePreset, type StockReport, type StockValue, type Summary } from '../billing/reports'
import { formatQtyNumber, formatRupees } from '../lib/numfmt'
import { useApp } from './app'
import { Banner, Header, Screen } from './components'
import { ApprovalModal } from './common'

type Range = RangePreset | 'custom'
type Tab = 'daily' | 'items' | 'daybook' | 'stock' | 'profit'
const TABS: Tab[] = ['daily', 'items', 'daybook', 'stock', 'profit']
const RANGES: Range[] = ['today', 'week', 'month', 'custom']
const ITEM_ROWS = 100
/** 'HH:mm' in IST for a stored UTC instant. */
const istTime = (iso: string) => new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(11, 16)
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
  const [book, setBook] = useState<DayBook | null>(null)
  const [stock, setStock] = useState<StockReport | null>(null)
  // Cost and profit stay behind the owner PIN. The unlock lasts until this screen closes and is never stored.
  const [unlocked, setUnlocked] = useState(false)
  const [asking, setAsking] = useState(false)
  const [profit, setProfit] = useState<{ report: ProfitReport; value: StockValue } | null>(null)

  const dates = useMemo<DateRange | null>(() => {
    if (range !== 'custom') return presetRange(range)
    return from && to && from <= to ? { fromDate: from, toDate: to } : null
  }, [range, from, to])

  useEffect(() => {
    if (!app.db || !dates) return
    let live = true
    void Promise.all([summary(app.db, dates), dailySales(app.db, dates), itemSales(app.db, dates), dayBook(app.db, dates), stockReport(app.db)]).then(([s, d, i, b, st]) => {
      if (!live) return
      setSum(s)
      setDays(d)
      setItems(i)
      setBook(b)
      setStock(st)
    })
    return () => {
      live = false
    }
  }, [app.db, dates])

  useEffect(() => {
    if (!app.db || !dates || !unlocked) return
    let live = true
    void Promise.all([profitReport(app.db, dates), stockValue(app.db)]).then(([report, value]) => live && setProfit({ report, value }))
    return () => {
      live = false
    }
  }, [app.db, dates, unlocked])

  const pickTab = (x: Tab) => {
    if (x === 'profit' && !unlocked) setAsking(true)
    setTab(x)
  }

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
              {TABS.map((x) => (
                <button key={x} type="button" className="chip" aria-pressed={tab === x} onClick={() => pickTab(x)} data-testid={`rep-tab-${x}`}>{t(`reports.tabs.${x}`)}</button>
              ))}
            </div>
            {empty && (tab === 'daily' || tab === 'items') && <p className="muted" data-testid="rep-empty">{t('reports.empty')}</p>}
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
            {tab === 'daybook' && book && (
              <>
                <div className="row"><span className="row-main muted">{t('reports.takings')}</span><strong className="num" data-testid="rep-takings">{money(book.takingsPaise)}</strong></div>
                {book.entries.length === 0 ? <p className="muted">{t('reports.dayBookEmpty')}</p> : (
                  <ul className="list" data-testid="rep-daybook">
                    {book.entries.map((e) => (
                      <li key={`${e.kind}:${e.id}`} className="row">
                        <span className="row-main" style={{ display: 'flex', flexDirection: 'column' }}>
                          <span className="row-title">{t(`reports.kind.${e.kind}`)}{e.partyName ? ` · ${e.partyName}` : ''}</span>
                          <span className="muted">{istTime(e.at)}{e.mode ? ` · ${t(`history.mode.${e.mode}`, { defaultValue: e.mode })}` : ''}</span>
                        </span>
                        <strong className="num">{e.kind === 'return' || e.kind === 'supplier_payment' || e.kind === 'purchase' ? '−' : ''}{money(e.amountPaise)}</strong>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
            {tab === 'stock' && stock && (
              <>
                <p className="muted" data-testid="rep-stock-summary">{t('reports.stockSummary', { oversold: stock.oversold, out: stock.outOfStock, inStock: stock.inStock })}</p>
                {stock.rows.length === 0 ? <p className="muted">{t('reports.stockEmpty')}</p> : (
                  <ul className="list" data-testid="rep-stock">
                    {stock.rows.slice(0, ITEM_ROWS).map((r) => (
                      <li key={r.productId} className="row">
                        <span className="row-main" style={{ display: 'flex', flexDirection: 'column' }}>
                          <span className="row-title">{r.name}</span>
                          {r.qtyMilli <= 0 && <span className="muted">{r.qtyMilli < 0 ? t('reports.oversold') : t('reports.outOfStock')}</span>}
                        </span>
                        <strong className="num">{formatQtyNumber(r.qtyMilli)} {r.unit}</strong>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
            {tab === 'profit' && !unlocked && <p className="muted" data-testid="rep-profit-locked">{t('reports.profitLocked')}</p>}
            {tab === 'profit' && unlocked && profit && (
              <>
                <section className="field" data-testid="rep-profit">
                  <div className="row"><span className="row-main">{t('reports.profit')}</span><strong className="num" data-testid="rep-profit-total">{money(profit.report.profitPaise)}</strong></div>
                  <div className="row"><span className="row-main muted">{t('reports.margin')}</span><span className="num">{profit.report.marginBp === null ? '–' : `${(profit.report.marginBp / 100).toFixed(1)}%`}</span></div>
                  <div className="row"><span className="row-main muted">{t('reports.revenueKnown')}</span><span className="num">{money(profit.report.revenuePaise)}</span></div>
                  <div className="row"><span className="row-main muted">{t('reports.cost')}</span><span className="num">{money(profit.report.costPaise)}</span></div>
                  <div className="row"><span className="row-main muted">{t('reports.stockValue')}</span><span className="num" data-testid="rep-stock-value">{money(profit.value.valuePaise)}</span></div>
                </section>
                {(profit.report.costMissingItems > 0 || profit.value.costMissingItems > 0) && (
                  <Banner kind="warning">{t('reports.costMissing', { sales: profit.report.costMissingItems, stock: profit.value.costMissingItems, amount: money(profit.report.costMissingPaise) })}</Banner>
                )}
                <ul className="list" data-testid="rep-profit-items">
                  {profit.report.items.slice(0, ITEM_ROWS).map((i) => (
                    <li key={i.productId} className="row">
                      <span className="row-main" style={{ display: 'flex', flexDirection: 'column' }}>
                        <span className="row-title">{i.name}</span>
                        <span className="muted">{i.marginBp === null ? t('reports.noCost') : `${t('reports.margin')} ${(i.marginBp / 100).toFixed(1)}%`}</span>
                      </span>
                      <strong className="num">{money(i.profitPaise)}</strong>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </div>
      {asking && app.db && (
        <ApprovalModal
          db={app.db}
          title={t('reports.profitPin')}
          defaultReason={t('reports.profitReason')}
          onCancel={() => { setAsking(false); setTab('daily') }}
          onApproved={() => { setAsking(false); setUnlocked(true) }}
        />
      )}
    </Screen>
  )
}
