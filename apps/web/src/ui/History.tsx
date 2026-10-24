import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { HISTORY_PAGE, listHistory, loadInvoiceDetail, receiptFromInvoice, type HistoryCursor, type HistoryEntry, type HistoryFilters, type InvoiceDetail } from '../billing/history'
import { istDate } from '../billing/numbering'
import type { TenderMode } from '../billing/types'
import { formatRupees } from '../lib/numfmt'
import { formatIst } from '../print/receipt'
import { useApp } from './app'
import { Banner, Button, Header, Screen } from './components'
import { navigate, useRoute } from './router'
import { ShareModal } from './Receipt'
import { DEFAULT_PRINTER, loadPrinterSettings, printToDevice, printWithBrowser, receiptPdf, receiptPreviewLines, type PrinterSettings } from './printing'
import type { StoredReceipt } from './receiptStore'

type Range = 'today' | 'yesterday' | 'week' | 'all' | 'custom'
type TypeFilter = 'all' | 'tax_invoice' | 'bill_of_supply' | 'retail_invoice' | 'credit_note'
const MODES: TenderMode[] = ['cash', 'upi', 'card', 'credit']
const DAY = 86_400_000

function rangeDates(range: Range, from: string, to: string, now = Date.now()): Pick<HistoryFilters, 'fromDate' | 'toDate'> {
  switch (range) {
    case 'today': return { fromDate: istDate(now), toDate: istDate(now) }
    case 'yesterday': return { fromDate: istDate(now - DAY), toDate: istDate(now - DAY) }
    case 'week': return { fromDate: istDate(now - 6 * DAY), toDate: istDate(now) }
    case 'custom': return { ...(from ? { fromDate: from } : {}), ...(to ? { toDate: to } : {}) }
    default: return {}
  }
}

/** Past invoices and credit notes, newest first. Everything is read from the device, so it works offline. */
export default function HistoryScreen() {
  const route = useRoute()
  const id = route.segments[1]
  return id ? <HistoryDetail invoiceId={id} /> : <HistoryList />
}

function HistoryList() {
  const { t } = useTranslation()
  const app = useApp()
  const route = useRoute()
  const partyId = route.query.get('party') ?? undefined
  const [range, setRange] = useState<Range>('today')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [mode, setMode] = useState<TenderMode | 'all'>('all')
  const [type, setType] = useState<TypeFilter>('all')
  const [q, setQ] = useState('')
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [next, setNext] = useState<HistoryCursor | null>(null)
  const [loaded, setLoaded] = useState(false)

  const filters = useMemo<HistoryFilters>(
    () => ({
      ...rangeDates(range, from, to),
      ...(partyId ? { partyId } : {}),
      ...(mode !== 'all' ? { mode } : {}),
      ...(type !== 'all' ? { docType: type } : {}),
      ...(q.trim() ? { query: q } : {}),
    }),
    [range, from, to, partyId, mode, type, q],
  )

  useEffect(() => {
    if (!app.db) return
    let live = true
    void listHistory(app.db, filters).then((p) => {
      if (!live) return
      setEntries(p.entries)
      setNext(p.next)
      setLoaded(true)
    })
    return () => {
      live = false
    }
  }, [app.db, filters])

  const more = useCallback(async () => {
    if (!app.db || !next) return
    const p = await listHistory(app.db, filters, next)
    setEntries((e) => [...e, ...p.entries])
    setNext(p.next)
  }, [app.db, filters, next])

  // group by IST day, keeping the newest-first order
  const days = useMemo(() => {
    const out: { day: string; rows: HistoryEntry[] }[] = []
    for (const e of entries) {
      const day = formatIst(e.createdAt).slice(0, 10)
      const last = out[out.length - 1]
      if (last && last.day === day) last.rows.push(e)
      else out.push({ day, rows: [e] })
    }
    return out
  }, [entries])

  const ranges: Range[] = ['today', 'yesterday', 'week', 'all', 'custom']
  const types: TypeFilter[] = ['all', 'tax_invoice', 'bill_of_supply', 'retail_invoice', 'credit_note']
  return (
    <Screen testId="history-screen">
      <Header title={t('history.title')} />
      <div className="screen-body">
        <input className="input" type="search" placeholder={t('history.search')} aria-label={t('history.search')} value={q} onChange={(e) => setQ(e.target.value)} data-testid="history-search" />
        <div className="chips" role="group" aria-label={t('history.dateFilter')}>
          {ranges.map((r) => (
            <button key={r} type="button" className="chip" aria-pressed={range === r} onClick={() => setRange(r)} data-testid={`range-${r}`}>{t(`history.range.${r}`)}</button>
          ))}
        </div>
        {range === 'custom' && (
          <div className="tender-row">
            <input className="input" type="date" aria-label={t('history.from')} value={from} onChange={(e) => setFrom(e.target.value)} />
            <input className="input" type="date" aria-label={t('history.to')} value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        )}
        <div className="chips" role="group" aria-label={t('history.modeFilter')}>
          {(['all', ...MODES] as const).map((m) => (
            <button key={m} type="button" className="chip" aria-pressed={mode === m} onClick={() => setMode(m)} data-testid={`mode-${m}`}>{t(`history.mode.${m}`)}</button>
          ))}
        </div>
        <div className="chips" role="group" aria-label={t('history.typeFilter')}>
          {types.map((x) => (
            <button key={x} type="button" className="chip" aria-pressed={type === x} onClick={() => setType(x)} data-testid={`type-${x}`}>{t(`history.type.${x}`)}</button>
          ))}
        </div>
        {loaded && entries.length === 0 && <p className="muted" data-testid="history-empty">{t('history.empty')}</p>}
        {days.map((d) => (
          <section key={d.day} aria-label={d.day}>
            <h2 className="muted" style={{ fontSize: '0.95rem', margin: '8px 0' }}>{d.day}</h2>
            <ul className="list">
              {d.rows.map((e) => (
                <li key={`${e.kind}:${e.id}`}>
                  <button type="button" className="row" style={{ width: '100%', textAlign: 'left' }} onClick={() => navigate(`/history/${e.invoiceId}`)} data-testid="history-row">
                    <span className="row-main">
                      <span className="row-title">{e.label}</span>
                      <span className="muted">
                        {formatIst(e.createdAt).slice(11)} · {e.partyName ?? t('history.walkIn')}
                        {e.kind === 'credit_note' ? ` · ${t('history.creditNote')}` : e.modes.length > 0 ? ` · ${e.modes.map((m) => t(`history.mode.${m}`)).join(', ')}` : ''}
                        {e.returned ? ` · ${t('history.returned')}` : ''}
                      </span>
                    </span>
                    <strong className="num">{e.kind === 'credit_note' ? '−' : ''}{formatRupees(e.totalPaise, { paise: 'auto' })}</strong>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {next && entries.length >= HISTORY_PAGE && <Button onClick={() => void more()} data-testid="history-more">{t('history.more')}</Button>}
      </div>
    </Screen>
  )
}

type Msg = { kind: 'ok' | 'warning' | 'error'; text: string }

function HistoryDetail({ invoiceId }: { invoiceId: string }) {
  const { t } = useTranslation()
  const app = useApp()
  const [detail, setDetail] = useState<InvoiceDetail | null>(null)
  const [missing, setMissing] = useState(false)
  const [printer, setPrinter] = useState<PrinterSettings>(DEFAULT_PRINTER)
  const [lines, setLines] = useState<string[]>([])
  const [msg, setMsg] = useState<Msg | null>(null)
  const [sharing, setSharing] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!app.db) return
    void Promise.all([loadInvoiceDetail(app.db, invoiceId), loadPrinterSettings(app.db)])
      .then(([d, p]) => {
        setDetail(d)
        setPrinter(p)
      })
      .catch(() => setMissing(true))
  }, [app.db, invoiceId])

  // a duplicate copy: never saved as the last receipt, never auto-printed
  const stored = useMemo<StoredReceipt | null>(
    () => (detail ? { invoiceId: detail.id, receipt: receiptFromInvoice(detail, app.profile), upiUri: null } : null),
    [detail, app.profile],
  )
  useEffect(() => {
    if (stored) void receiptPreviewLines(stored.receipt, { ...printer, lang: 'en' }).then(setLines).catch(() => setLines([]))
  }, [stored, printer])

  const print = async () => {
    if (!stored) return
    if (printer.kind === null) return void printWithBrowser(stored.receipt, null, printer)
    setBusy(true)
    const res = await printToDevice(stored.receipt, null, printer)
    setBusy(false)
    setMsg(res.ok ? { kind: 'ok', text: t('history.printed') } : { kind: 'warning', text: res.code === 'no_printer' ? t('receipt.noPrinter') : t('receipt.printFailed') })
  }

  const savePdf = async () => {
    if (!stored) return
    setBusy(true)
    try {
      const blob = await receiptPdf(stored.receipt, null, printer)
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `${stored.receipt.label.replaceAll('/', '-')}.pdf`
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
    } catch {
      setMsg({ kind: 'error', text: t('receipt.pdfFailed') })
    } finally {
      setBusy(false)
    }
  }

  if (missing) {
    return (
      <Screen testId="history-detail">
        <Header title={t('history.title')} />
        <div className="screen-body"><p className="muted" data-testid="history-missing">{t('history.notFound')}</p></div>
      </Screen>
    )
  }
  if (!detail || !stored) return <Screen testId="history-detail"><Header title={t('history.title')} /></Screen>
  return (
    <Screen testId="history-detail">
      <Header title={detail.label} />
      <div className="screen-body">
        <div className="total-line"><span>{t('receipt.total')}</span><strong className="num" data-testid="history-total">{formatRupees(detail.totalPaise, { paise: 'auto' })}</strong></div>
        <p className="muted">{formatIst(detail.createdAt)} · {detail.partyName ?? t('history.walkIn')}</p>
        {stored.receipt.creditPaise > 0 && <Banner kind="warning">{t('receipt.customerOwes', { name: detail.partyName ?? '', amount: formatRupees(stored.receipt.creditPaise) })}</Banner>}
        {detail.creditNotes.length > 0 && (
          <Banner kind="info">
            <div data-testid="history-notes">
              {detail.creditNotes.map((n) => (
                <div key={n.id}>{t('history.noteLine', { label: n.label, amount: formatRupees(n.totalPaise, { paise: 'auto' }), reason: n.reason })}</div>
              ))}
            </div>
          </Banner>
        )}
        {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}
        <pre className="receipt-preview" aria-label={t('receipt.preview')}>{lines.join('\n')}</pre>
        <div className="tender-row">
          <Button icon="print" variant="primary" disabled={busy} onClick={() => void print()} data-testid="history-print">{t('receipt.print')}</Button>
          <Button icon="share" onClick={() => setSharing(true)} data-testid="history-share">{t('receipt.whatsapp')}</Button>
        </div>
        <div className="tender-row">
          <Button onClick={() => void savePdf()} disabled={busy}>{t('receipt.pdf')}</Button>
          <Button onClick={() => navigate(`/returns?invoice=${detail.id}`)} data-testid="history-return">{t('history.startReturn')}</Button>
        </div>
      </div>
      {sharing && <ShareModal onClose={() => setSharing(false)} stored={stored} printer={printer} />}
    </Screen>
  )
}
