import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { priceCart } from '../billing/calc'
import { commitSale } from '../billing/commit'
import { evaluateDiscount, needsBackdateApproval } from '../billing/discount'
import { qrMatrix } from '../billing/qr'
import { settleTenders } from '../billing/tender'
import type { Tender, TenderMode } from '../billing/types'
import { buildUpiUri } from '../billing/upi'
import { formatRupees, parseRupeesToPaise } from '../lib/numfmt'
import { useApp } from './app'
import { billStore, useBill } from './billStore'
import { Banner, Button, Header, Keypad, Screen } from './components'
import { ApprovalModal, errorText, QrSvg, todayIst, type ApprovalResult, nowMs, perfStart } from './common'
import { CustomerPicker } from './CustomerPicker'
import { navigate } from './router'
import { saveLastReceipt } from './receiptStore'

type Active = TenderMode

const MODES: { mode: Active; key: string }[] = [
  { mode: 'cash', key: 'tender.cash' },
  { mode: 'upi', key: 'tender.upi' },
  { mode: 'card', key: 'tender.card' },
  { mode: 'credit', key: 'tender.credit' },
]

/**
 * Payment. Cash is the default and takes the whole bill, so a plain sale is: Pay, then Done (3 taps with the item).
 * Other modes hold explicit amounts; cash is always "whatever is left", unless the cashier types what the customer
 * handed over (then the change is shown). 1200 = 500 UPI + 700 customer owes leaves cash at 0.
 */
export default function TenderScreen() {
  const { t } = useTranslation()
  const app = useApp()
  const bill = useBill()
  const [active, setActive] = useState<Active>('cash')
  const [amounts, setAmounts] = useState<Record<Active, string>>({ cash: '', upi: '', card: '', credit: '' })
  const [fresh, setFresh] = useState<Active | null>(null)
  const [cardRef, setCardRef] = useState('')
  const [pickCustomer, setPickCustomer] = useState(false)
  const [approvalFor, setApprovalFor] = useState<'discount' | 'backdate' | null>(null)
  const [approval, setApproval] = useState<ApprovalResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const onDate = todayIst()
  const priced = useMemo(() => {
    if (bill.lines.length === 0) return null
    try {
      return priceCart({ lines: bill.lines, billDiscount: bill.billDiscount }, { gstMode: app.profile.gstMode, rounding: app.profile.rounding, rules: app.rules, onDate })
    } catch {
      return null
    }
  }, [bill.lines, bill.billDiscount, app.profile.gstMode, app.profile.rounding, app.rules, onDate])

  if (!priced || !app.rt || !app.db) {
    return (
      <Screen testId="tender-screen">
        <Header title={t('tender.title')} />
        <div className="screen-body">
          <p className="muted">{t('bill.emptyCart')}</p>
          <Button variant="primary" onClick={() => navigate('/bill')}>{t('tender.backToBill')}</Button>
        </div>
      </Screen>
    )
  }
  const rt = app.rt
  const db = app.db
  const total = priced.totalPaise

  const explicit = (m: Active) => parseRupeesToPaise(amounts[m] || '0') ?? 0
  const nonCash = explicit('upi') + explicit('card') + explicit('credit')
  const cashDue = Math.max(0, total - nonCash)
  const cashTendered = amounts.cash !== '' ? (parseRupeesToPaise(amounts.cash) ?? 0) : cashDue
  const received = cashTendered + nonCash
  const left = Math.max(0, total - received)
  const change = Math.max(0, received - total)

  const discountEval = evaluateDiscount(priced, app.policy)
  const needsDiscountApproval = discountEval.needsApproval && !approval

  const tenders: Tender[] = [
    { mode: 'cash', amountPaise: cashTendered },
    { mode: 'upi', amountPaise: explicit('upi') },
    { mode: 'card', amountPaise: explicit('card'), reference: cardRef || null },
    { mode: 'credit', amountPaise: explicit('credit') },
  ]

  const select = (m: Active) => {
    setActive(m)
    setError(null)
    // Tapping an empty mode offers what is still to pay (typing replaces it), so a split is: tap UPI, type 500,
    // tap Customer owes (700 appears). Cash is never prefilled: it is always the remainder.
    if (m !== 'cash' && amounts[m] === '' && cashDue > 0) {
      setAmounts((a) => ({ ...a, [m]: String(cashDue / 100) }))
      setFresh(m)
    }
  }

  const setAmount = (v: string) => {
    const prev = amounts[active]
    let next = v
    if (fresh === active) {
      next = v.length > prev.length ? v.slice(prev.length) : ''
      setFresh(null)
    }
    setAmounts((a) => ({ ...a, [active]: next }))
  }

  const vpa = app.profile.upiVpa
  const upiPaise = explicit('upi')
  const upiUri = vpa && upiPaise > 0 ? buildUpiUri({ vpa, name: app.profile.businessName || 'Shop', amountPaise: upiPaise }) : null

  const finish = async (withApproval: ApprovalResult | null) => {
    setBusy(true)
    setError(null)
    try {
      // validate first so the cashier sees the problem before any PIN prompt
      settleTenders(total, tenders, bill.customer !== null)
      if (discountEval.needsApproval && !withApproval) return setApprovalFor('discount')
      if (needsBackdateApproval(onDate, todayIst(), app.policy) && !withApproval) return setApprovalFor('backdate')
      const requestId = billStore.ensureRequestId()
      const stop = perfStart('commitSale')
      const result = await commitSale(rt.writer, db, {
        requestId,
        bill: priced,
        lines: bill.lines,
        party: bill.customer,
        tenders,
        profile: app.profile,
        identity: { tenantId: rt.config.tenantId, storeId: rt.config.storeId, deviceId: rt.config.deviceId },
        actorUserId: rt.config.actorUserId ?? null,
        approval: withApproval,
        now: nowMs(),
      })
      stop()
      const r = result.receipt
      // the QR printed on the receipt: what is still owed (dynamic) or just the merchant's UPI ID (static)
      const vpaForReceipt = app.profile.upiVpa
      const receiptUri = vpaForReceipt
        ? buildUpiUri({ vpa: vpaForReceipt, name: app.profile.businessName || 'Shop', ...(r.creditPaise > 0 ? { amountPaise: r.creditPaise } : {}) })
        : null
      await saveLastReceipt(db, { invoiceId: result.invoiceId, receipt: r, upiUri: receiptUri })
      const ids = bill.lines.map((l) => l.productId)
      billStore.clear()
      void rt.refresh()
      void app.reloadItems(ids)
      navigate(`/receipt/${result.invoiceId}`)
    } catch (e) {
      setError(errorText(t, e))
    } finally {
      setBusy(false)
    }
  }

  const modeSummary = (m: Active): string => {
    if (m === 'cash') return formatRupees(cashTendered, { paise: 'auto' })
    return explicit(m) > 0 ? formatRupees(explicit(m), { paise: 'auto' }) : '–'
  }

  return (
    <Screen testId="tender-screen">
      <Header title={t('tender.title')} />
      <div className="screen-body">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span>{t('tender.due')}</span>
          <strong className="total-big num" data-testid="tender-due">{formatRupees(total, { paise: 'auto' })}</strong>
        </div>
        {priced.roundOffPaise !== 0 && <div className="muted num">{t('tender.roundOff', { amount: formatRupees(priced.roundOffPaise, { paise: 'always' }) })}</div>}

        <div className="tender-row" role="group" aria-label={t('tender.mode')}>
          {MODES.map(({ mode, key }) => (
            <button type="button" key={mode} className="chip" style={{ flex: 1, minHeight: 64 }} aria-pressed={active === mode} onClick={() => select(mode)} data-testid={`mode-${mode}`}>
              <div>{t(key)}</div>
              <div className="num" style={{ fontWeight: 400 }}>{modeSummary(mode)}</div>
            </button>
          ))}
        </div>

        <div className="input num" data-testid="amount-display">
          {amounts[active] !== '' ? `₹${amounts[active]}` : active === 'cash' ? `₹${(cashDue / 100).toString()}` : ' '}
        </div>
        <Keypad value={amounts[active]} onChange={setAmount} decimal ariaLabel={t('tender.amount')} />

        {active === 'card' && (
          <div className="field">
            <label htmlFor="card-ref">{t('tender.cardRef')}</label>
            <input id="card-ref" className="input" inputMode="numeric" maxLength={12} value={cardRef} onChange={(e) => setCardRef(e.target.value)} />
            <span className="hint">{t('tender.cardRefHint')}</span>
          </div>
        )}
        {active === 'upi' && upiPaise > 0 && (vpa ? (
          <div className="row" style={{ justifyContent: 'center', flexDirection: 'column' }}>
            <QrSvg matrix={qrMatrix(upiUri!)} size={180} label={t('tender.upiQrLabel', { amount: formatRupees(upiPaise) })} />
            <span className="muted">{t('tender.scanToPay', { amount: formatRupees(upiPaise) })}</span>
          </div>
        ) : <Banner kind="warning">{t('tender.noVpa')}</Banner>)}

        {explicit('credit') > 0 && !bill.customer && (
          <Banner kind="warning">
            <div>{t('tender.creditNeedsCustomer')}</div>
            <Button onClick={() => setPickCustomer(true)} data-testid="choose-customer">{t('tender.chooseCustomer')}</Button>
          </Banner>
        )}
        {explicit('credit') > 0 && bill.customer && <div className="badge badge-warn" data-testid="owes-note">{t('tender.customerOwes', { name: bill.customer.name, amount: formatRupees(explicit('credit')) })}</div>}

        {left > 0 && <Banner kind="warning"><span data-testid="left-to-pay">{t('tender.left', { amount: formatRupees(left) })}</span></Banner>}
        {change > 0 && <Banner kind="info"><strong data-testid="change-due">{t('tender.change', { amount: formatRupees(change) })}</strong></Banner>}
        {needsDiscountApproval && <Banner kind="warning">{t('tender.needsOwnerPin', { percent: (discountEval.percentBp / 100).toFixed(1) })}</Banner>}
        {error && <Banner kind="error">{error}</Banner>}
      </div>
      <footer className="screen-footer">
        <Button variant="primary" className="btn-block" disabled={busy || left > 0} onClick={() => void finish(approval)} data-testid="complete-sale">
          {amounts.upi === '' && amounts.card === '' && amounts.credit === '' ? t('tender.doneCash', { amount: formatRupees(cashTendered) }) : t('tender.done')}
        </Button>
      </footer>
      {pickCustomer && <CustomerPicker onClose={() => setPickCustomer(false)} onPicked={(c) => { billStore.setCustomer(c); setPickCustomer(false) }} />}
      {approvalFor && (
        <ApprovalModal
          db={db}
          title={approvalFor === 'discount' ? t('approval.discountTitle') : t('approval.backdateTitle')}
          defaultReason={approvalFor === 'discount' ? t('approval.discountReason') : ''}
          onCancel={() => setApprovalFor(null)}
          onApproved={(a) => { setApproval(a); setApprovalFor(null); void finish(a) }}
        />
      )}
    </Screen>
  )
}
