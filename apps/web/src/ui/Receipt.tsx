import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatRupees } from '../lib/numfmt'
import { useApp } from './app'
import { Banner, Button, Header, Screen } from './components'
import { Modal } from './common'
import { navigate, useRoute } from './router'
import { loadLastReceipt, type StoredReceipt } from './receiptStore'
import { loadPrinterSettings, DEFAULT_PRINTER, printToDevice, printWithBrowser, receiptPdf, receiptPreviewLines, type PrinterSettings } from './printing'

type Msg = { kind: 'ok' | 'warning' | 'error'; text: string }

export default function ReceiptScreen() {
  const { t } = useTranslation()
  const app = useApp()
  const route = useRoute()
  const invoiceId = route.segments[1]
  const [stored, setStored] = useState<StoredReceipt | null>(null)
  const [printer, setPrinter] = useState<PrinterSettings>(DEFAULT_PRINTER)
  const [lines, setLines] = useState<string[]>([])
  const [msg, setMsg] = useState<Msg | null>(null)
  const [sharing, setSharing] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!app.db) return
    void Promise.all([loadLastReceipt(app.db), loadPrinterSettings(app.db)]).then(([r, p]) => {
      setPrinter(p)
      if (r && r.invoiceId === invoiceId) setStored(r)
    })
  }, [app.db, invoiceId])

  useEffect(() => {
    if (stored) void receiptPreviewLines(stored.receipt, { ...printer, lang: 'en' }).then(setLines).catch(() => setLines([]))
  }, [stored, printer])

  const doPrint = useCallback(async () => {
    if (!stored) return
    setBusy(true)
    setMsg(null)
    const started = performance.now()
    const res = await printToDevice(stored.receipt, stored.upiUri, printer)
    setBusy(false)
    if (res.ok) setMsg({ kind: 'ok', text: t('receipt.printed', { ms: Math.round(performance.now() - started) }) })
    else setMsg({ kind: 'warning', text: res.code === 'no_printer' ? t('receipt.noPrinter') : t('receipt.printFailed') })
  }, [stored, printer, t])

  // a printer set up earlier prints right away (no click needed for an already granted device)
  useEffect(() => {
    if (stored && printer.kind && printer.autoPrint) void doPrint()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored?.invoiceId, printer.kind, printer.autoPrint])

  const savePdf = async () => {
    if (!stored) return
    setBusy(true)
    try {
      const blob = await receiptPdf(stored.receipt, stored.upiUri, printer)
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

  if (!stored) {
    return (
      <Screen testId="receipt-screen">
        <Header title={t('receipt.title')} />
        <div className="screen-body">
          <p className="muted">{t('receipt.notFound')}</p>
          <Button variant="primary" onClick={() => navigate('/bill')}>{t('receipt.newBill')}</Button>
        </div>
      </Screen>
    )
  }
  const r = stored.receipt
  const hasPrinter = printer.kind !== null
  return (
    <Screen testId="receipt-screen">
      <Header title={t('receipt.title')} />
      <div className="screen-body">
        <Banner kind="ok">
          <strong data-testid="sale-saved">{t('receipt.saved', { label: r.label })}</strong>
          <div className="muted">{t('receipt.savedHint')}</div>
        </Banner>
        <div className="total-line"><span>{t('receipt.total')}</span><strong className="num" data-testid="receipt-total">{formatRupees(r.totalPaise, { paise: 'auto' })}</strong></div>
        {r.changeDuePaise > 0 && <Banner kind="info"><strong data-testid="receipt-change">{t('tender.change', { amount: formatRupees(r.changeDuePaise) })}</strong></Banner>}
        {r.creditPaise > 0 && <Banner kind="warning"><span data-testid="receipt-owes">{t('receipt.customerOwes', { name: r.customerName ?? '', amount: formatRupees(r.creditPaise) })}</span></Banner>}
        {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}
        <pre className="receipt-preview" aria-label={t('receipt.preview')}>{lines.join('\n')}</pre>
        <div className="tender-row">
          <Button icon="print" variant={hasPrinter ? 'primary' : 'secondary'} disabled={busy} onClick={() => (hasPrinter ? void doPrint() : void printWithBrowser(r, stored.upiUri, printer))} data-testid="print">
            {t('receipt.print')}
          </Button>
          <Button icon="share" onClick={() => setSharing(true)} data-testid="share">{t('receipt.whatsapp')}</Button>
        </div>
        <div className="tender-row">
          {hasPrinter && <Button onClick={() => void printWithBrowser(r, stored.upiUri, printer)}>{t('receipt.browserPrint')}</Button>}
          <Button onClick={() => void savePdf()} disabled={busy}>{t('receipt.pdf')}</Button>
        </div>
      </div>
      <footer className="screen-footer">
        <Button variant={hasPrinter ? 'secondary' : 'primary'} className="btn-block" onClick={() => navigate('/bill')} data-testid="new-bill">
          {t('receipt.newBill')}
        </Button>
      </footer>
      {sharing && app.db && <ShareModal onClose={() => setSharing(false)} stored={stored} printer={printer} />}
    </Screen>
  )
}

function ShareModal({ stored, printer, onClose }: { stored: StoredReceipt; printer: PrinterSettings; onClose: () => void }) {
  const { t } = useTranslation()
  const app = useApp()
  const [phone, setPhone] = useState('')
  const [state, setState] = useState<'idle' | 'queued' | 'opened' | 'bad_phone'>('idle')
  const online = navigator.onLine

  const go = async () => {
    if (!app.db) return
    const { buildReceiptText, enqueueShare, markSent, normalizeIndianMobile, whatsappUrl } = await import('../print/share')
    if (!normalizeIndianMobile(phone)) return setState('bad_phone')
    const text = buildReceiptText(stored.receipt, printer.lang)
    const id = await enqueueShare(app.db, { invoiceId: stored.invoiceId, phone, body: text })
    if (navigator.onLine) {
      // an intent must start from this tap; opening it marks the queued row as sent
      window.open(whatsappUrl(phone, text), '_blank', 'noopener')
      await markSent(app.db, id)
      setState('opened')
    } else setState('queued')
  }

  return (
    <Modal title={t('receipt.shareTitle')} onClose={onClose} testId="share-modal">
      <div className="field">
        <label htmlFor="wa-phone">{t('receipt.customerMobile')}</label>
        <input id="wa-phone" className="input" inputMode="tel" autoComplete="off" value={phone} onChange={(e) => { setPhone(e.target.value); setState('idle') }} aria-invalid={state === 'bad_phone'} data-testid="share-phone" />
        <span className="hint">{online ? t('receipt.shareOnlineHint') : t('receipt.shareOfflineHint')}</span>
      </div>
      {state === 'bad_phone' && <Banner kind="error">{t('receipt.badPhone')}</Banner>}
      {state === 'queued' && <Banner kind="ok">{t('receipt.shareQueued')}</Banner>}
      {state === 'opened' && <Banner kind="ok">{t('receipt.shareOpened')}</Banner>}
      <Button variant="primary" onClick={() => void go()} data-testid="share-go">{online ? t('receipt.sendWhatsapp') : t('receipt.queueShare')}</Button>
    </Modal>
  )
}
