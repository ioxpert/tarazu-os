import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { commitReturn, computeReturn, loadInvoiceForReturn, suggestRefund, type RefundPart, type ReturnInvoice } from '../billing/returns'
import { formatQty, formatRupees } from '../lib/numfmt'
import { parseQtyMilli } from '../catalogue/uom'
import { useApp } from './app'
import { Banner, Button, Header, Screen } from './components'
import { ApprovalModal, errorText, type ApprovalResult, nowMs } from './common'
import { navigate } from './router'
import { saveLastReceipt } from './receiptStore'

interface InvoiceRow {
  id: string
  series: string
  number: number
  invoice_date: string
  total_paise: number
  party_id: string | null
}

type RefundMode = 'cash' | 'upi' | 'card'

/** Return / credit note. The invoice is never edited: a credit note refers to it and reverses tax, stock and payment. */
export default function ReturnsScreen() {
  const { t } = useTranslation()
  const app = useApp()
  const [rows, setRows] = useState<InvoiceRow[]>([])
  const [q, setQ] = useState('')
  const [invoice, setInvoice] = useState<ReturnInvoice | null>(null)
  const [qty, setQty] = useState<Record<number, string>>({})
  const [reason, setReason] = useState('')
  const [mode, setMode] = useState<RefundMode>('cash')
  const [approvalOpen, setApprovalOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!app.db) return
    const like = `%${q.trim().replace(/[%_]/g, '')}%`
    void app.db
      .getAll<InvoiceRow>(
        `SELECT id, series, number, invoice_date, total_paise, party_id FROM invoice
         WHERE (? = '%%' OR CAST(number AS TEXT) LIKE ? OR series LIKE ?) ORDER BY created_at DESC, number DESC LIMIT 30`,
        [like, like, like],
      )
      .then(setRows)
  }, [app.db, q])

  const open = async (id: string) => {
    if (!app.db) return
    setError(null)
    setQty({})
    setInvoice(await loadInvoiceForReturn(app.db, id))
  }

  const selections = useMemo(() => {
    if (!invoice) return []
    return invoice.lines
      .map((l) => ({ lineNo: l.lineNo, qtyMilli: parseQtyMilli(qty[l.lineNo] ?? '') ?? 0 }))
      .filter((s) => s.qtyMilli > 0)
  }, [invoice, qty])

  const computation = useMemo(() => {
    if (!invoice || selections.length === 0) return null
    try {
      return computeReturn(invoice, selections)
    } catch {
      return null
    }
  }, [invoice, selections])

  const refunds: RefundPart[] = invoice && computation ? suggestRefund(invoice, computation.totalPaise, mode) : []

  const submit = async (approval: ApprovalResult) => {
    if (!app.rt || !app.db || !invoice || !computation) return
    setBusy(true)
    setError(null)
    try {
      const rt = app.rt
      const res = await commitReturn(rt.writer, app.db, {
        requestId: crypto.randomUUID(),
        invoiceId: invoice.id,
        selections,
        reason,
        refunds,
        approval,
        profile: app.profile,
        identity: { tenantId: rt.config.tenantId, storeId: rt.config.storeId, deviceId: rt.config.deviceId },
        actorUserId: rt.config.actorUserId ?? null,
        now: nowMs(),
      })
      await saveLastReceipt(app.db, { invoiceId: res.creditNoteId, receipt: res.receipt, upiUri: null })
      void rt.refresh()
      void app.reloadItems(invoice.lines.filter((l) => selections.some((s) => s.lineNo === l.lineNo)).map((l) => l.productId))
      navigate(`/receipt/${res.creditNoteId}`)
    } catch (e) {
      setError(errorText(t, e))
    } finally {
      setBusy(false)
    }
  }

  if (!invoice) {
    return (
      <Screen testId="returns-screen">
        <Header title={t('returns.title')} />
        <div className="screen-body">
          <input className="input" type="search" inputMode="numeric" placeholder={t('returns.findInvoice')} aria-label={t('returns.findInvoice')} value={q} onChange={(e) => setQ(e.target.value)} data-testid="invoice-search" />
          {rows.length === 0 && <p className="muted">{t('returns.noInvoices')}</p>}
          <ul className="list">
            {rows.map((r) => (
              <li key={r.id}>
                <button type="button" className="row" style={{ width: '100%', textAlign: 'left' }} onClick={() => void open(r.id)} data-testid="invoice-row">
                  <span className="row-main"><span className="row-title">{r.series} / {r.number}</span><span className="muted">{r.invoice_date}</span></span>
                  <strong className="num">{formatRupees(Number(r.total_paise))}</strong>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </Screen>
    )
  }

  const returnable = (l: ReturnInvoice['lines'][number]) => l.qtyMilli - l.returnedQtyMilli
  return (
    <Screen testId="return-detail">
      <Header title={t('returns.titleFor', { label: invoice.label })} />
      <div className="screen-body">
        <ul className="list">
          {invoice.lines.map((l) => (
            <li key={l.lineNo} className="row" data-testid="return-line">
              <span className="row-main">
                <span className="row-title">{l.name}</span>
                <span className="muted">{t('returns.sold', { qty: formatQty(l.qtyMilli, l.unit) })}{l.returnedQtyMilli > 0 ? ` · ${t('returns.alreadyReturned', { qty: formatQty(l.returnedQtyMilli, l.unit) })}` : ''}</span>
              </span>
              {returnable(l) > 0 ? (
                <>
                  <input className="input num" style={{ maxWidth: 90 }} inputMode="decimal" aria-label={t('returns.qtyFor', { name: l.name })} value={qty[l.lineNo] ?? ''} onChange={(e) => setQty({ ...qty, [l.lineNo]: e.target.value })} data-testid="return-qty" />
                  <Button onClick={() => setQty({ ...qty, [l.lineNo]: String(returnable(l) / 1000) })} data-testid="return-all">{t('returns.all')}</Button>
                </>
              ) : <span className="badge">{t('returns.fullyReturned')}</span>}
            </li>
          ))}
        </ul>
        <div className="field">
          <label htmlFor="ret-reason">{t('returns.reason')}</label>
          <input id="ret-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="return-reason" />
          <div className="chips" role="group">
            {(['damaged', 'wrongItem', 'changedMind'] as const).map((k) => (
              <button type="button" className="chip" key={k} onClick={() => setReason(t(`returns.reasons.${k}`))}>{t(`returns.reasons.${k}`)}</button>
            ))}
          </div>
        </div>
        {computation && (
          <>
            <div className="chips" role="group" aria-label={t('returns.refundHow')}>
              {(['cash', 'upi', 'card'] as const).map((m) => <button type="button" key={m} className="chip" aria-pressed={mode === m} onClick={() => setMode(m)}>{t(`tender.${m}`)}</button>)}
            </div>
            <div className="total-line"><span>{t('returns.creditTotal')}</span><strong className="num" data-testid="return-total">{formatRupees(computation.totalPaise)}</strong></div>
            {refunds.map((r) => (
              <div key={r.kind} className="muted">{r.kind === 'khata' ? t('returns.reduceOwed', { amount: formatRupees(r.amountPaise) }) : t('returns.giveBack', { amount: formatRupees(r.amountPaise), mode: t(`tender.${r.kind}`) })}</div>
            ))}
          </>
        )}
        {error && <Banner kind="error">{error}</Banner>}
      </div>
      <footer className="screen-footer">
        <Button variant="primary" className="btn-block" disabled={!computation || !reason.trim() || busy} onClick={() => setApprovalOpen(true)} data-testid="return-confirm">{t('returns.confirm')}</Button>
      </footer>
      {approvalOpen && app.db && (
        <ApprovalModal db={app.db} title={t('approval.returnTitle')} defaultReason={reason} onCancel={() => setApprovalOpen(false)} onApproved={(a) => { setApprovalOpen(false); void submit(a) }} />
      )}
    </Screen>
  )
}
