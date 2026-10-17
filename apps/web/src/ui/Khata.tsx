import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { buildUpiUri } from '../billing/upi'
import { formatRupees, parseRupeesToPaise } from '../lib/numfmt'
import { collectPayment, recordPreviousBalance, type CollectMode } from '../khata/collect'
import { hasConsent, recordConsent } from '../khata/consent'
import { listCustomers, loadStatement, type CustomerFilter, type CustomerRow, type CustomerSort, type Statement } from '../khata/ledger'
import { updateCustomer } from '../khata/party'
import { buildReminderText, buildThanksText } from '../khata/reminder'
import { useApp } from './app'
import { Banner, Button, Header, Keypad, Screen } from './components'
import { errorText, Modal, nowMs } from './common'
import { Icon } from './icons'
import { createParty } from './parties'
import { navigate, useRoute } from './router'

/** Khata home: who owes you, how much, for how long. One dominant action: add a customer. */
export default function KhataScreen() {
  const route = useRoute()
  if (route.segments[1] === 'new') return <NewCustomer />
  if (route.segments[1] === 'c' && route.segments[2]) return <CustomerScreen id={route.segments[2]} />
  return <KhataList />
}

function KhataList() {
  const { t } = useTranslation()
  const app = useApp()
  const [rows, setRows] = useState<CustomerRow[]>([])
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<CustomerFilter>('owing')
  const [sort, setSort] = useState<CustomerSort>('amount')

  useEffect(() => {
    if (app.db) void listCustomers(app.db, { query: q, filter, sort }).then(setRows)
  }, [app.db, q, filter, sort])

  const total = rows.reduce((a, r) => a + Math.max(0, r.balancePaise), 0)
  return (
    <Screen testId="khata-screen">
      <Header title={t('khata.title')} />
      <div className="screen-body">
        <div className="total-line">
          <span>{t('khata.totalOwed')}</span>
          <strong className="num" data-testid="khata-total">{formatRupees(total, { paise: 'auto' })}</strong>
        </div>
        <input className="input" type="search" placeholder={t('khata.search')} aria-label={t('khata.search')} value={q} onChange={(e) => setQ(e.target.value)} data-testid="khata-search" />
        <div className="chips" role="group" aria-label={t('khata.show')}>
          {(['owing', 'advance', 'all'] as const).map((f) => (
            <button type="button" key={f} className="chip" aria-pressed={filter === f} onClick={() => setFilter(f)} data-testid={`khata-filter-${f}`}>{t(`khata.filter.${f}`)}</button>
          ))}
        </div>
        <div className="chips" role="group" aria-label={t('khata.sortBy')}>
          {(['amount', 'oldest', 'name'] as const).map((s) => (
            <button type="button" key={s} className="chip" aria-pressed={sort === s} onClick={() => setSort(s)}>{t(`khata.sort.${s}`)}</button>
          ))}
        </div>
        {rows.length === 0 && <p className="muted" data-testid="khata-empty">{filter === 'owing' ? t('khata.none') : t('khata.noneHere')}</p>}
        <ul className="list" data-testid="khata-list">
          {rows.map((r) => (
            <li key={r.id}>
              <button type="button" className="row" style={{ width: '100%', textAlign: 'left' }} onClick={() => navigate(`/khata/c/${r.id}`)} data-testid="khata-row">
                <span className="row-main">
                  <span className="row-title">{r.name}</span>
                  <span className="muted">
                    {r.phone ?? t('khata.noPhone')}
                    {r.balancePaise > 0 && r.oldestDays > 0 ? ` · ${t('khata.days', { count: r.oldestDays })}` : ''}
                  </span>
                </span>
                {r.balancePaise > 0 ? (
                  <strong className="num">{t('khata.owes', { amount: formatRupees(r.balancePaise, { paise: 'auto' }) })}</strong>
                ) : r.balancePaise < 0 ? (
                  <span className="badge badge-ok">{t('khata.advance', { amount: formatRupees(-r.balancePaise, { paise: 'auto' }) })}</span>
                ) : (
                  <span className="badge">{t('khata.clear')}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <footer className="screen-footer">
        <Button variant="primary" icon="plus" className="btn-block" onClick={() => navigate('/khata/new')} data-testid="khata-add">{t('khata.addCustomer')}</Button>
      </footer>
    </Screen>
  )
}

function NewCustomer() {
  const { t } = useTranslation()
  const app = useApp()
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [owed, setOwed] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async () => {
    if (!app.rt || !name.trim()) return
    setBusy(true)
    setError(null)
    try {
      const rt = app.rt
      const p = await createParty(rt.writer, { tenantId: rt.config.tenantId, actorUserId: rt.config.actorUserId }, name, null)
      if (phone.trim()) await updateCustomer(rt.writer, p.id, { phone }, rt.config.actorUserId ?? null)
      const paise = owed ? parseRupeesToPaise(owed) : null
      if (paise) {
        await recordPreviousBalance(rt.writer, {
          requestId: crypto.randomUUID(), partyId: p.id, amountPaise: paise, note: t('khata.previousNote'),
          identity: { tenantId: rt.config.tenantId, storeId: rt.config.storeId, deviceId: rt.config.deviceId }, actorUserId: rt.config.actorUserId ?? null, now: nowMs(),
        })
      }
      void rt.refresh()
      navigate(`/khata/c/${p.id}`)
    } catch (e) {
      setError(errorText(t, e))
      setBusy(false)
    }
  }

  return (
    <Screen testId="khata-new">
      <Header title={t('khata.addCustomer')} />
      <div className="screen-body">
        <div className="field">
          <label htmlFor="kn-name">{t('khata.name')}</label>
          <input id="kn-name" className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus data-testid="kn-name" />
        </div>
        <div className="field">
          <label htmlFor="kn-phone">{t('khata.phoneOptional')}</label>
          <input id="kn-phone" className="input" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} data-testid="kn-phone" />
        </div>
        <div className="field">
          <label htmlFor="kn-owed">{t('khata.alreadyOwes')}</label>
          <input id="kn-owed" className="input num" inputMode="decimal" value={owed} onChange={(e) => setOwed(e.target.value)} data-testid="kn-owed" />
          <span className="hint">{t('khata.alreadyOwesHint')}</span>
        </div>
        {error && <Banner kind="error">{error}</Banner>}
      </div>
      <footer className="screen-footer">
        <Button variant="primary" className="btn-block" disabled={busy || !name.trim()} onClick={() => void save()} data-testid="kn-save">{t('common.save')}</Button>
      </footer>
    </Screen>
  )
}

function CustomerScreen({ id }: { id: string }) {
  const { t, i18n } = useTranslation()
  const app = useApp()
  const [st, setSt] = useState<Statement | null | undefined>(undefined)
  const [dialog, setDialog] = useState<'pay' | 'owe' | 'edit' | 'remind' | null>(null)
  const [thanks, setThanks] = useState<{ text: string } | null>(null)

  const load = useCallback(async () => {
    if (app.db) setSt(await loadStatement(app.db, id))
  }, [app.db, id])
  useEffect(() => {
    void load()
  }, [load])

  if (st === undefined) return <Screen><Header title={t('khata.title')} /></Screen>
  if (st === null) {
    return (
      <Screen>
        <Header title={t('khata.title')} />
        <div className="screen-body"><p className="muted">{t('khata.notFound')}</p></div>
      </Screen>
    )
  }
  const c = st.customer
  const owes = c.balancePaise > 0
  const lang = i18n.language === 'hi' ? 'hi' : 'en'
  const identity = app.rt ? { tenantId: app.rt.config.tenantId, storeId: app.rt.config.storeId, deviceId: app.rt.config.deviceId } : null
  const reverse = [...st.lines].reverse()

  return (
    <Screen testId="customer-screen">
      <Header title={c.name} />
      <div className="screen-body">
        <Banner kind={owes ? 'warning' : 'ok'}>
          <strong data-testid="customer-balance" style={{ fontSize: '1.4rem' }}>
            {owes ? t('khata.owes', { amount: formatRupees(c.balancePaise, { paise: 'auto' }) }) : c.balancePaise < 0 ? t('khata.advance', { amount: formatRupees(-c.balancePaise, { paise: 'auto' }) }) : t('khata.clear')}
          </strong>
          {owes && <div>{t('khata.oldest', { count: st.ageing.oldestDays })}</div>}
          {owes && (st.ageing.buckets.from31To60 > 0 || st.ageing.buckets.over60 > 0) && (
            <div data-testid="ageing-note">{t('khata.ageingNote', { b2: formatRupees(st.ageing.buckets.from31To60, { paise: 'auto' }), b3: formatRupees(st.ageing.buckets.over60, { paise: 'auto' }) })}</div>
          )}
        </Banner>
        {c.creditLimitPaise !== null && (
          <div className="muted">
            {c.balancePaise > c.creditLimitPaise ? <span className="badge badge-warn"><Icon name="warning" size={16} />{t('khata.overLimit', { limit: formatRupees(c.creditLimitPaise, { paise: 'auto' }) })}</span> : t('khata.limit', { limit: formatRupees(c.creditLimitPaise, { paise: 'auto' }) })}
          </div>
        )}
        {thanks && (
          <Banner kind="ok">
            <div data-testid="paid-saved">{t('khata.paymentSaved')}</div>
            <Button onClick={() => void shareText(c.phone, thanks.text, app.db, id)}>{t('khata.sendThanks')}</Button>
          </Banner>
        )}
        <div className="tender-row">
          <Button variant="primary" onClick={() => setDialog('pay')} data-testid="customer-paid">{t('khata.customerPaid')}</Button>
          <Button onClick={() => setDialog('remind')} disabled={!owes} data-testid="remind">{t('khata.remind')}</Button>
        </div>
        <div className="tender-row">
          <Button onClick={() => setDialog('owe')} data-testid="add-old">{t('khata.addOld')}</Button>
          <Button onClick={() => setDialog('edit')} data-testid="edit-customer">{t('khata.edit')}</Button>
        </div>
        <h2>{t('khata.statement')}</h2>
        {reverse.length === 0 && <p className="muted">{t('khata.noLines')}</p>}
        <ul className="list" data-testid="statement">
          {reverse.map((l) => (
            <li key={l.id} className="row" data-testid="statement-line">
              <span className="row-main">
                <span className="row-title">
                  {l.direction === 'debit'
                    ? l.refType === 'invoice' ? t('khata.line.bill', { label: l.invoiceLabel ?? '' }) : t('khata.line.old')
                    : l.refType === 'credit_note' ? t('khata.line.return') : t('khata.line.paid')}
                </span>
                <span className="muted">{new Date(l.occurredAt).toLocaleDateString()}{l.note ? ` · ${l.note}` : ''}</span>
              </span>
              <span className="num">
                <strong>{l.direction === 'debit' ? '+' : '−'}{formatRupees(l.amountPaise, { paise: 'auto' })}</strong>
                <div className="muted">{t('khata.balanceAfter', { amount: formatRupees(l.balanceAfterPaise, { paise: 'auto' }) })}</div>
              </span>
            </li>
          ))}
        </ul>
      </div>

      {dialog === 'pay' && app.rt && identity && (
        <PayDialog
          owedPaise={Math.max(0, c.balancePaise)}
          onClose={() => setDialog(null)}
          onDone={async (amount, mode, reference) => {
            const rt = app.rt!
            const res = await collectPayment(rt.writer, { requestId: crypto.randomUUID(), partyId: id, amountPaise: amount, mode, reference, identity, actorUserId: rt.config.actorUserId ?? null, now: nowMs() })
            void rt.refresh()
            setThanks({ text: buildThanksText({ shopName: app.profile.businessName, customerName: c.name, paidPaise: amount, balancePaise: res.balanceAfterPaise, lang }) })
            setDialog(null)
            await load()
          }}
        />
      )}
      {dialog === 'owe' && identity && app.rt && (
        <AmountDialog
          title={t('khata.addOld')}
          hint={t('khata.alreadyOwesHint')}
          confirm={t('common.save')}
          onClose={() => setDialog(null)}
          onDone={async (amount) => {
            const rt = app.rt!
            await recordPreviousBalance(rt.writer, { requestId: crypto.randomUUID(), partyId: id, amountPaise: amount, note: t('khata.previousNote'), identity, actorUserId: rt.config.actorUserId ?? null, now: nowMs() })
            void rt.refresh()
            setDialog(null)
            await load()
          }}
        />
      )}
      {dialog === 'edit' && app.rt && (
        <EditDialog customer={c} onClose={() => setDialog(null)} onSaved={async () => { setDialog(null); await load() }} />
      )}
      {dialog === 'remind' && app.db && (
        <RemindDialog
          customer={c}
          text={buildReminderText({ shopName: app.profile.businessName, customerName: c.name, owedPaise: c.balancePaise, lang, upiUri: app.profile.upiVpa ? buildUpiUri({ vpa: app.profile.upiVpa, name: app.profile.businessName || 'Shop', amountPaise: c.balancePaise }) : null })}
          onClose={() => setDialog(null)}
        />
      )}
    </Screen>
  )
}

async function shareText(phone: string | null, text: string, db: ReturnType<typeof useApp>['db'], partyId: string) {
  if (!db || !phone) return
  const { enqueueShare, markSent, whatsappUrl } = await import('../print/share')
  const qid = await enqueueShare(db, { invoiceId: `khata:${partyId}`, phone, body: text })
  if (navigator.onLine) {
    window.open(whatsappUrl(phone, text), '_blank', 'noopener')
    await markSent(db, qid)
  }
}

function AmountDialog({ title, hint, confirm, onDone, onClose }: { title: string; hint?: string; confirm: string; onDone: (paise: number) => Promise<void>; onClose: () => void }) {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const paise = parseRupeesToPaise(text || '0')
  return (
    <Modal title={title} onClose={onClose} testId="amount-dialog">
      {hint && <p className="muted">{hint}</p>}
      <div className="input num" data-testid="amount-shown">{text ? `₹${text}` : ' '}</div>
      <Keypad value={text} onChange={setText} decimal />
      {error && <Banner kind="error">{error}</Banner>}
      <Button variant="primary" disabled={!paise} onClick={() => paise && onDone(paise).catch((e) => setError(errorText(t, e)))} data-testid="amount-confirm">{confirm}</Button>
    </Modal>
  )
}

function PayDialog({ owedPaise, onDone, onClose }: { owedPaise: number; onDone: (paise: number, mode: CollectMode, reference: string | null) => Promise<void>; onClose: () => void }) {
  const { t } = useTranslation()
  const [text, setText] = useState(owedPaise > 0 ? String(owedPaise / 100) : '')
  const [fresh, setFresh] = useState(owedPaise > 0)
  const [mode, setMode] = useState<CollectMode>('cash')
  const [ref, setRef] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const paise = parseRupeesToPaise(text || '0')
  const change = (v: string) => {
    // the offered full amount is replaced by the first digit typed
    setText(fresh ? (v.length > text.length ? v.slice(text.length) : '') : v)
    setFresh(false)
  }
  return (
    <Modal title={t('khata.customerPaid')} onClose={onClose} testId="pay-dialog">
      <div className="chips" role="group" aria-label={t('tender.mode')}>
        {(['cash', 'upi', 'card'] as const).map((m) => <button type="button" key={m} className="chip" aria-pressed={mode === m} onClick={() => setMode(m)} data-testid={`pay-${m}`}>{t(`tender.${m}`)}</button>)}
      </div>
      <div className="input num" data-testid="pay-amount">{text ? `₹${text}` : ' '}</div>
      <Keypad value={text} onChange={change} decimal />
      {mode !== 'cash' && (
        <div className="field">
          <label htmlFor="pay-ref">{mode === 'upi' ? t('khata.upiRef') : t('tender.cardRef')}</label>
          <input id="pay-ref" className="input" value={ref} onChange={(e) => setRef(e.target.value)} />
          {mode === 'card' && <span className="hint">{t('tender.cardRefHint')}</span>}
        </div>
      )}
      {paise !== null && paise > owedPaise && owedPaise >= 0 && <Banner kind="info">{t('khata.advanceNote', { amount: formatRupees(paise - owedPaise, { paise: 'auto' }) })}</Banner>}
      {error && <Banner kind="error">{error}</Banner>}
      <Button
        variant="primary"
        disabled={busy || !paise}
        onClick={() => {
          if (!paise) return
          setBusy(true)
          onDone(paise, mode, ref || null).catch((e) => {
            setError(errorText(t, e))
            setBusy(false)
          })
        }}
        data-testid="pay-confirm"
      >
        {t('khata.gotMoney', { amount: formatRupees(paise ?? 0, { paise: 'auto' }) })}
      </Button>
    </Modal>
  )
}

function EditDialog({ customer, onSaved, onClose }: { customer: CustomerRow; onSaved: () => Promise<void>; onClose: () => void }) {
  const { t } = useTranslation()
  const app = useApp()
  const [name, setName] = useState(customer.name)
  const [phone, setPhone] = useState(customer.phone ?? '')
  const [limit, setLimit] = useState(customer.creditLimitPaise === null ? '' : String(customer.creditLimitPaise / 100))
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    if (!app.rt) return
    try {
      await updateCustomer(
        app.rt.writer,
        customer.id,
        { name, phone: phone.trim() ? phone : null, creditLimitPaise: limit.trim() ? parseRupeesToPaise(limit) : null },
        app.rt.config.actorUserId ?? null,
      )
      void app.rt.refresh()
      await onSaved()
    } catch (e) {
      setError(errorText(t, e))
    }
  }
  return (
    <Modal title={t('khata.edit')} onClose={onClose} testId="edit-dialog">
      <div className="field"><label htmlFor="ec-name">{t('khata.name')}</label><input id="ec-name" className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
      <div className="field"><label htmlFor="ec-phone">{t('khata.phoneOptional')}</label><input id="ec-phone" className="input" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} data-testid="ec-phone" /></div>
      <div className="field">
        <label htmlFor="ec-limit">{t('khata.creditLimit')}</label>
        <input id="ec-limit" className="input num" inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} data-testid="ec-limit" />
        <span className="hint">{t('khata.creditLimitHint')}</span>
      </div>
      {error && <Banner kind="error">{error}</Banner>}
      <Button variant="primary" onClick={() => void save()} data-testid="ec-save">{t('common.save')}</Button>
    </Modal>
  )
}

function RemindDialog({ customer, text, onClose }: { customer: CustomerRow; text: string; onClose: () => void }) {
  const { t } = useTranslation()
  const app = useApp()
  const [agreed, setAgreed] = useState<boolean | null>(null)
  const [tick, setTick] = useState(false)
  const [state, setState] = useState<'idle' | 'opened' | 'queued'>('idle')
  const online = navigator.onLine

  useEffect(() => {
    if (app.db) void hasConsent(app.db, customer.id).then(setAgreed)
  }, [app.db, customer.id])

  const grant = async () => {
    if (!app.db) return
    await recordConsent(app.db, { partyId: customer.id, action: 'grant' })
    setAgreed(true)
  }
  const withdraw = async () => {
    if (!app.db) return
    await recordConsent(app.db, { partyId: customer.id, action: 'withdraw' })
    setAgreed(false)
    setTick(false)
  }
  const send = async () => {
    if (!app.db || !customer.phone) return
    await shareText(customer.phone, text, app.db, customer.id)
    setState(navigator.onLine ? 'opened' : 'queued')
  }

  return (
    <Modal title={t('khata.remind')} onClose={onClose} testId="remind-dialog">
      {!customer.phone && <Banner kind="warning">{t('khata.needPhone')}</Banner>}
      {agreed === false && (
        <>
          <label className="row">
            <input type="checkbox" style={{ width: 24, height: 24 }} checked={tick} onChange={(e) => setTick(e.target.checked)} data-testid="consent-tick" />
            <span>{t('khata.consentAsk', { name: customer.name })}</span>
          </label>
          <span className="hint">{t('khata.consentHint')}</span>
          <Button onClick={() => void grant()} disabled={!tick} data-testid="consent-save">{t('khata.consentSave')}</Button>
        </>
      )}
      {agreed === true && (
        <>
          <pre className="receipt-preview" aria-label={t('khata.reminderPreview')}>{text}</pre>
          <Button variant="primary" disabled={!customer.phone} onClick={() => void send()} data-testid="remind-send">{online ? t('receipt.sendWhatsapp') : t('receipt.queueShare')}</Button>
          <button type="button" className="btn btn-ghost" onClick={() => void withdraw()} data-testid="consent-withdraw">{t('khata.consentWithdraw')}</button>
        </>
      )}
      {state === 'opened' && <Banner kind="ok">{t('receipt.shareOpened')}</Banner>}
      {state === 'queued' && <Banner kind="ok">{t('receipt.shareQueued')}</Banner>}
    </Modal>
  )
}
