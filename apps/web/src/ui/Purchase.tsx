import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { mulDiv } from '../billing/money'
import { formatQty, formatRupees, parseRupeesToPaise } from '../lib/numfmt'
import { formatQtyMilli, fromBaseMilli, toBaseMilli, unitMilli, unitsOf } from '../catalogue/uom'
import type { CatalogueItem, Unit } from '../catalogue/types'
import { listCustomers, loadStatement, type CustomerRow, type Statement } from '../khata/ledger'
import { commitPurchase, priceLines, type PayMode, type PurchaseLineInput } from '../purchase/commit'
import { listPurchases, loadLastCosts, marginBp, type PurchaseRow } from '../purchase/history'
import { createSupplier, paySupplier } from '../purchase/supplier'
import { useApp } from './app'
import { Banner, Button, Header, Keypad, Screen } from './components'
import { errorText, Modal, nowMs, useWedgeScanner } from './common'
import { Icon } from './icons'
import { PayDialog } from './Khata'
import { navigate, useRoute } from './router'
import { CameraScanModal } from './scan'

interface DraftLine extends PurchaseLineInput {
  key: string
  name: string
  unit: Unit
}

const PAY_MODES = ['cash', 'upi', 'bank_transfer', 'cheque'] as const

/** Stock came in with a supplier bill. One dominant action per step: add items, then Save. */
export default function PurchaseRoutes() {
  const route = useRoute()
  const sub = route.segments[1]
  if (sub === 'in') return <PurchaseScreen />
  if (sub === 'purchases') return <PurchaseHistory />
  if (sub === 'suppliers') return <SupplierList />
  if (sub === 'supplier' && route.segments[2]) return <SupplierScreen id={route.segments[2]} />
  return null
}

function PurchaseScreen() {
  const { t, i18n } = useTranslation()
  const app = useApp()
  const [supplier, setSupplier] = useState<{ id: string; name: string } | null>(null)
  const [supplierRef, setSupplierRef] = useState('')
  const [lines, setLines] = useState<DraftLine[]>([])
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<{ item: CatalogueItem; line?: DraftLine } | null>(null)
  const [pickSupplier, setPickSupplier] = useState(false)
  const [paying, setPaying] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [unknown, setUnknown] = useState<string | null>(null)
  const [costs, setCosts] = useState<Map<string, number>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [requestId] = useState(() => crypto.randomUUID())

  useEffect(() => {
    if (app.db) void loadLastCosts(app.db, app.items.map((i) => i.id)).then(setCosts)
  }, [app.db, app.items])

  const pick = (item: CatalogueItem) => {
    setUnknown(null)
    setQuery('')
    const existing = lines.find((l) => l.productId === item.id)
    setEditing({ item, line: existing })
  }
  const onCode = (code: string) => {
    const hit = app.index.byBarcode(code)[0]
    if (hit) pick(hit)
    else setUnknown(code)
  }
  useWedgeScanner(onCode)

  const results = useMemo(() => (query.trim() ? app.index.search(query, { limit: 12 }) : []), [query, app.index])
  const total = useMemo(() => {
    try {
      return lines.length ? priceLines(lines).totalPaise : 0
    } catch {
      return 0
    }
  }, [lines])
  const nameOf = (x: { name: string; localName: string | null }) => (i18n.language === 'hi' && x.localName ? x.localName : x.name)

  const save = async (payments: { mode: PayMode; amountPaise: number; reference?: string | null }[]) => {
    if (!app.rt || !app.db) return
    setError(null)
    try {
      const rt = app.rt
      const res = await commitPurchase(rt.writer, app.db, {
        requestId,
        supplier,
        supplierRef,
        lines,
        payments,
        identity: { tenantId: rt.config.tenantId, storeId: rt.config.storeId, deviceId: rt.config.deviceId },
        actorUserId: rt.config.actorUserId ?? null,
        now: nowMs(),
      })
      void rt.refresh()
      await app.reloadItems(lines.map((l) => l.productId))
      navigate(`/stock/purchases?saved=${encodeURIComponent(res.label)}&owed=${res.owedPaise}`)
    } catch (e) {
      setPaying(false)
      setError(errorText(t, e))
    }
  }

  return (
    <Screen testId="purchase-screen">
      <Header title={t('purchase.title')} />
      <div className="screen-body">
        <button type="button" className="row" onClick={() => setPickSupplier(true)} data-testid="supplier-chip">
          <Icon name="stock" />
          <span className="row-main">{supplier ? supplier.name : t('purchase.noSupplier')}</span>
          <span className="muted">{t('bill.change')}</span>
        </button>
        <div className="field">
          <label htmlFor="pu-ref">{t('purchase.supplierBill')}</label>
          <input id="pu-ref" className="input" value={supplierRef} onChange={(e) => setSupplierRef(e.target.value)} data-testid="pu-ref" />
        </div>
        <div className="row" style={{ padding: 4 }}>
          <Icon name="search" />
          <input className="input" style={{ border: 'none' }} type="search" placeholder={t('purchase.addItem')} aria-label={t('purchase.addItem')} value={query} onChange={(e) => setQuery(e.target.value)} data-testid="pu-search" />
          <Button variant="ghost" icon="scan" onClick={() => setScanning(true)} aria-label={t('bill.scan')} />
        </div>
        {unknown && (
          <Banner kind="warning">
            <div>{t('bill.unknownBarcode', { code: unknown })}</div>
            <Button onClick={() => navigate(`/stock/new?barcode=${encodeURIComponent(unknown)}`)}>{t('bill.addThisItem')}</Button>
          </Banner>
        )}
        {results.length > 0 && (
          <ul className="list" data-testid="pu-results">
            {results.map((it) => (
              <li key={it.id}>
                <button type="button" className="row" style={{ width: '100%', textAlign: 'left' }} onClick={() => pick(it)} data-testid="pu-result">
                  <span className="row-main">{nameOf(it)}</span>
                  <span className="muted">{costs.has(it.id) ? t('purchase.lastCost', { cost: formatRupees(costs.get(it.id)!, { paise: 'auto' }) }) : ''}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {query.trim() && results.length === 0 && (
          <Button icon="plus" onClick={() => navigate('/stock/new')}>{t('purchase.newItem')}</Button>
        )}
        {lines.length === 0 ? (
          <p className="muted">{t('purchase.empty')}</p>
        ) : (
          <ul className="list" data-testid="pu-lines">
            {lines.map((l) => {
              const item = app.index.get(l.productId)
              const sell = item ? (item.retailPaise ?? item.mrpPaise) : null
              const margin = marginBp(sell, l.unitCostPaise)
              return (
                <li key={l.key} className="row" data-testid="pu-line">
                  <button type="button" className="row-main" style={{ all: 'unset', cursor: 'pointer', flex: 1, minWidth: 0 }} onClick={() => item && setEditing({ item, line: l })}>
                    <div className="row-title">{l.name}</div>
                    <div className="muted">
                      {formatQty(l.qtyMilli, item?.uom.base ?? l.unit)} × {formatRupees(l.unitCostPaise, { paise: 'auto' })}
                      {margin !== null && ` · ${t('purchase.margin', { percent: (margin / 100).toFixed(0) })}`}
                    </div>
                    {margin !== null && margin < 0 && (
                      <span className="badge badge-warn"><Icon name="warning" size={16} />{t('purchase.sellsBelowCost')}</span>
                    )}
                  </button>
                  <strong className="num">{formatRupees(priceLines([l]).totalPaise, { paise: 'auto' })}</strong>
                  <Button variant="ghost" icon="close" onClick={() => setLines(lines.filter((x) => x.key !== l.key))} aria-label={t('bill.remove', { name: l.name })} />
                </li>
              )
            })}
          </ul>
        )}
        {error && <Banner kind="error">{error}</Banner>}
      </div>
      <footer className="screen-footer">
        <div style={{ flex: 1 }}>
          <div className="muted">{t('bill.items', { count: lines.length })}</div>
          <div className="total-big num" data-testid="pu-total">{formatRupees(total, { paise: 'auto' })}</div>
        </div>
        <Button variant="primary" disabled={lines.length === 0} onClick={() => setPaying(true)} data-testid="pu-save">{t('purchase.save')}</Button>
      </footer>

      {editing && (
        <LineDialog
          item={editing.item}
          initial={editing.line}
          lastCost={costs.get(editing.item.id) ?? null}
          onClose={() => setEditing(null)}
          onDone={(qtyMilli, unitCostPaise, unit) => {
            const it = editing.item
            const next: DraftLine = { key: editing.line?.key ?? crypto.randomUUID(), productId: it.id, name: it.name, unit, qtyMilli, unitCostPaise }
            setLines(editing.line ? lines.map((l) => (l.key === editing.line!.key ? next : l)) : [...lines, next])
            setEditing(null)
          }}
        />
      )}
      {pickSupplier && <SupplierPicker onClose={() => setPickSupplier(false)} onPicked={(s) => { setSupplier(s); setPickSupplier(false) }} />}
      {scanning && <CameraScanModal onClose={() => setScanning(false)} onCode={(c) => { setScanning(false); onCode(c) }} />}
      {paying && <PaidNowDialog totalPaise={total} hasSupplier={supplier !== null} onClose={() => setPaying(false)} onChoose={(p) => void save(p)} onPickSupplier={() => { setPaying(false); setPickSupplier(true) }} />}
    </Screen>
  )
}

function LineDialog({ item, initial, lastCost, onDone, onClose }: { item: CatalogueItem; initial?: DraftLine; lastCost: number | null; onDone: (qtyMilli: number, unitCostPaise: number, unit: Unit) => void; onClose: () => void }) {
  const { t } = useTranslation()
  const units = unitsOf(item.uom)
  const [unit, setUnit] = useState<Unit>(initial?.unit ?? item.unit)
  const [field, setField] = useState<'qty' | 'cost'>('qty')
  const [qty, setQty] = useState(initial ? formatQtyMilli(fromBaseMilli(item.uom, initial.unit, initial.qtyMilli)) : '')
  const perUnit = (base: number, u: Unit) => mulDiv(base, unitMilli(item.uom, u), 1000)
  const startCost = initial ? perUnit(initial.unitCostPaise, initial.unit) : lastCost !== null ? perUnit(lastCost, unit) : null
  const [cost, setCost] = useState(startCost !== null ? (startCost / 100).toFixed(2).replace(/\.00$/, '') : '')
  const [fresh, setFresh] = useState(initial === undefined && lastCost !== null)

  const qtyMilli = (() => {
    try {
      return qty ? toBaseMilli(item.uom, unit, qty) : 0
    } catch {
      return 0
    }
  })()
  const costPaise = parseRupeesToPaise(cost || '0')
  const value = field === 'qty' ? qty : cost
  const change = (v: string) => {
    if (field === 'cost' && fresh) {
      setCost(v.length > cost.length ? v.slice(cost.length) : '')
      setFresh(false)
    } else if (field === 'qty') setQty(v)
    else setCost(v)
  }
  const changeUnit = (u: Unit) => {
    // keep the price per BASE unit the same when the unit changes
    const base = costPaise !== null ? mulDiv(costPaise, 1000, unitMilli(item.uom, unit)) : null
    setUnit(u)
    if (base !== null) setCost((perUnit(base, u) / 100).toFixed(2).replace(/\.00$/, ''))
  }
  const ok = qtyMilli > 0 && costPaise !== null
  return (
    <Modal title={item.name} onClose={onClose} testId="pu-line-dialog">
      {units.length > 1 && (
        <div className="chips" role="group" aria-label={t('bill.unit')}>
          {units.map((u) => <button type="button" key={u} className="chip" aria-pressed={unit === u} onClick={() => changeUnit(u)}>{u}</button>)}
        </div>
      )}
      <div className="chips" role="group" aria-label={t('bill.editWhat')}>
        <button type="button" className="chip" aria-pressed={field === 'qty'} onClick={() => setField('qty')} data-testid="pu-field-qty">{t('purchase.howMany')}: {qty || '–'} {unit}</button>
        <button type="button" className="chip" aria-pressed={field === 'cost'} onClick={() => setField('cost')} data-testid="pu-field-cost">{t('purchase.costPer', { unit })}: {cost ? `₹${cost}` : '–'}</button>
      </div>
      <div className="input num" data-testid="pu-display">{value || ' '}</div>
      <Keypad value={value} onChange={change} decimal />
      <Button
        variant="primary"
        disabled={!ok}
        onClick={() => ok && costPaise !== null && onDone(qtyMilli, mulDiv(costPaise, 1000, unitMilli(item.uom, unit)), unit)}
        data-testid="pu-line-done"
      >
        {t('common.done')}
      </Button>
    </Modal>
  )
}

function PaidNowDialog({ totalPaise, hasSupplier, onChoose, onPickSupplier, onClose }: { totalPaise: number; hasSupplier: boolean; onChoose: (p: { mode: PayMode; amountPaise: number; reference?: string | null }[]) => void; onPickSupplier: () => void; onClose: () => void }) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<PayMode>('cash')
  const [text, setText] = useState(String(totalPaise / 100))
  const [fresh, setFresh] = useState(true)
  const paid = parseRupeesToPaise(text || '0') ?? 0
  const owed = Math.max(0, totalPaise - paid)
  const change = (v: string) => {
    setText(fresh ? (v.length > text.length ? v.slice(text.length) : '') : v)
    setFresh(false)
  }
  const blocked = paid > totalPaise || (owed > 0 && !hasSupplier)
  return (
    <Modal title={t('purchase.paidNow')} onClose={onClose} testId="paid-now">
      <div className="total-line"><span>{t('purchase.billTotal')}</span><strong className="num">{formatRupees(totalPaise, { paise: 'auto' })}</strong></div>
      <div className="chips" role="group" aria-label={t('tender.mode')}>
        {PAY_MODES.map((m) => <button type="button" key={m} className="chip" aria-pressed={mode === m} onClick={() => setMode(m)} data-testid={`pn-${m}`}>{t(`purchase.mode.${m}`)}</button>)}
      </div>
      <div className="input num" data-testid="pn-amount">{text ? `₹${text}` : '₹0'}</div>
      <Keypad value={text} onChange={change} decimal />
      {owed > 0 && hasSupplier && <Banner kind="warning"><span data-testid="pn-owed">{t('purchase.owedToSupplier', { amount: formatRupees(owed, { paise: 'auto' }) })}</span></Banner>}
      {owed > 0 && !hasSupplier && (
        <Banner kind="warning">
          <div>{t('purchase.needSupplier')}</div>
          <Button onClick={onPickSupplier}>{t('purchase.chooseSupplier')}</Button>
        </Banner>
      )}
      {paid > totalPaise && <Banner kind="error">{t('purchase.paidTooMuch')}</Banner>}
      <Button variant="primary" disabled={blocked} onClick={() => onChoose(paid > 0 ? [{ mode, amountPaise: paid }] : [])} data-testid="pn-confirm">
        {t('purchase.confirmSave')}
      </Button>
    </Modal>
  )
}

function SupplierPicker({ onPicked, onClose }: { onPicked: (s: { id: string; name: string } | null) => void; onClose: () => void }) {
  const { t } = useTranslation()
  const app = useApp()
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<CustomerRow[]>([])
  useEffect(() => {
    if (app.db) void listCustomers(app.db, { kind: 'supplier', filter: 'all', query: q, sort: 'name' }).then(setRows)
  }, [app.db, q])
  const create = async () => {
    if (!app.rt || !q.trim()) return
    const s = await createSupplier(app.rt.writer, { tenantId: app.rt.config.tenantId, actorUserId: app.rt.config.actorUserId }, q, null)
    onPicked(s)
  }
  return (
    <Modal title={t('purchase.supplier')} onClose={onClose} testId="supplier-modal">
      <Button onClick={() => onPicked(null)} data-testid="no-supplier">{t('purchase.noSupplier')}</Button>
      <input className="input" placeholder={t('purchase.searchSupplier')} aria-label={t('purchase.searchSupplier')} value={q} onChange={(e) => setQ(e.target.value)} data-testid="supplier-search" />
      <ul className="list">
        {rows.map((r) => (
          <li key={r.id}>
            <button type="button" className="row" style={{ width: '100%' }} onClick={() => onPicked({ id: r.id, name: r.name })}>
              <span className="row-main"><span className="row-title">{r.name}</span></span>
              {r.balancePaise < 0 && <span className="badge badge-warn">{t('purchase.youOwe', { amount: formatRupees(-r.balancePaise, { paise: 'auto' }) })}</span>}
            </button>
          </li>
        ))}
      </ul>
      {q.trim() && !rows.some((r) => r.name.toLowerCase() === q.trim().toLowerCase()) && (
        <Button icon="plus" onClick={() => void create()} data-testid="create-supplier">{t('purchase.createSupplier', { name: q.trim() })}</Button>
      )}
    </Modal>
  )
}

function PurchaseHistory() {
  const { t } = useTranslation()
  const app = useApp()
  const route = useRoute()
  const [rows, setRows] = useState<PurchaseRow[]>([])
  useEffect(() => {
    if (app.db) void listPurchases(app.db).then(setRows)
  }, [app.db])
  const saved = route.query.get('saved')
  const owed = Number(route.query.get('owed') ?? 0)
  return (
    <Screen testId="purchases-screen">
      <Header title={t('purchase.history')} />
      <div className="screen-body">
        {saved && (
          <Banner kind="ok">
            <strong data-testid="purchase-saved">{t('purchase.saved', { label: saved })}</strong>
            {owed > 0 && <div data-testid="purchase-owed">{t('purchase.owedToSupplier', { amount: formatRupees(owed, { paise: 'auto' }) })}</div>}
          </Banner>
        )}
        {rows.length === 0 && <p className="muted">{t('purchase.none')}</p>}
        <ul className="list" data-testid="purchase-list">
          {rows.map((r) => (
            <li key={r.id} className="row" data-testid="purchase-row">
              <span className="row-main">
                <span className="row-title">{r.supplierName ?? t('purchase.noSupplier')}</span>
                <span className="muted">{r.receiptDate} · {r.label}{r.supplierRef ? ` · ${r.supplierRef}` : ''} · {t('bill.items', { count: r.lineCount })}</span>
              </span>
              <strong className="num">{formatRupees(r.totalPaise, { paise: 'auto' })}</strong>
            </li>
          ))}
        </ul>
      </div>
      <footer className="screen-footer">
        <Button variant="primary" icon="plus" className="btn-block" onClick={() => navigate('/stock/in')} data-testid="new-purchase">{t('stock.cameInAction')}</Button>
      </footer>
    </Screen>
  )
}

function SupplierList() {
  const { t } = useTranslation()
  const app = useApp()
  const [rows, setRows] = useState<CustomerRow[]>([])
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const load = () => app.db && listCustomers(app.db, { kind: 'supplier', filter: 'all', sort: 'amount' }).then((r) => setRows([...r].sort((a, b) => a.balancePaise - b.balancePaise || a.name.localeCompare(b.name))))
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.db])
  const owe = rows.reduce((a, r) => a + Math.max(0, -r.balancePaise), 0)
  return (
    <Screen testId="suppliers-screen">
      <Header title={t('purchase.suppliers')} />
      <div className="screen-body">
        <div className="total-line"><span>{t('purchase.totalYouOwe')}</span><strong className="num" data-testid="suppliers-total">{formatRupees(owe, { paise: 'auto' })}</strong></div>
        {rows.length === 0 && <p className="muted">{t('purchase.noSuppliers')}</p>}
        <ul className="list" data-testid="supplier-list">
          {rows.map((r) => (
            <li key={r.id}>
              <button type="button" className="row" style={{ width: '100%', textAlign: 'left' }} onClick={() => navigate(`/stock/supplier/${r.id}`)} data-testid="supplier-row">
                <span className="row-main"><span className="row-title">{r.name}</span><span className="muted">{r.phone ?? ''}</span></span>
                {r.balancePaise < 0 ? <strong className="num">{t('purchase.youOwe', { amount: formatRupees(-r.balancePaise, { paise: 'auto' }) })}</strong> : r.balancePaise > 0 ? <span className="badge badge-ok">{t('purchase.paidAhead', { amount: formatRupees(r.balancePaise, { paise: 'auto' }) })}</span> : <span className="badge">{t('khata.clear')}</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <footer className="screen-footer">
        <Button variant="primary" icon="plus" className="btn-block" onClick={() => setAdding(true)} data-testid="add-supplier">{t('purchase.addSupplier')}</Button>
      </footer>
      {adding && (
        <Modal title={t('purchase.addSupplier')} onClose={() => setAdding(false)} testId="add-supplier-dialog">
          <div className="field"><label htmlFor="as-name">{t('purchase.supplierName')}</label><input id="as-name" className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus data-testid="as-name" /></div>
          <Button variant="primary" disabled={!name.trim()} data-testid="as-save" onClick={async () => {
            if (!app.rt) return
            await createSupplier(app.rt.writer, { tenantId: app.rt.config.tenantId, actorUserId: app.rt.config.actorUserId }, name, null)
            setName('')
            setAdding(false)
            await load()
          }}>{t('common.save')}</Button>
        </Modal>
      )}
    </Screen>
  )
}

function SupplierScreen({ id }: { id: string }) {
  const { t } = useTranslation()
  const app = useApp()
  const [st, setSt] = useState<Statement | null | undefined>(undefined)
  const [paying, setPaying] = useState(false)
  const [saved, setSaved] = useState(false)
  const load = async () => {
    if (app.db) setSt(await loadStatement(app.db, id, Date.now(), 'supplier'))
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.db, id])
  if (!st) return <Screen><Header title={t('purchase.suppliers')} /></Screen>
  const owe = -st.customer.balancePaise
  return (
    <Screen testId="supplier-screen">
      <Header title={st.customer.name} />
      <div className="screen-body">
        <Banner kind={owe > 0 ? 'warning' : 'ok'}>
          <strong data-testid="supplier-balance" style={{ fontSize: '1.4rem' }}>
            {owe > 0 ? t('purchase.youOwe', { amount: formatRupees(owe, { paise: 'auto' }) }) : owe < 0 ? t('purchase.paidAhead', { amount: formatRupees(-owe, { paise: 'auto' }) }) : t('khata.clear')}
          </strong>
        </Banner>
        {saved && <Banner kind="ok"><span data-testid="supplier-paid">{t('khata.paymentSaved')}</span></Banner>}
        <Button variant="primary" onClick={() => setPaying(true)} data-testid="i-paid">{t('purchase.iPaid')}</Button>
        <h2>{t('khata.statement')}</h2>
        <ul className="list" data-testid="supplier-statement">
          {[...st.lines].reverse().map((l) => (
            <li key={l.id} className="row" data-testid="statement-line">
              <span className="row-main">
                <span className="row-title">{l.direction === 'credit' ? t('purchase.line.bought') : t('purchase.line.paid')}</span>
                <span className="muted">{new Date(l.occurredAt).toLocaleDateString()}</span>
              </span>
              <span className="num"><strong>{formatRupees(l.amountPaise, { paise: 'auto' })}</strong></span>
            </li>
          ))}
        </ul>
      </div>
      {paying && app.rt && (
        <PayDialog
          title={t('purchase.iPaid')}
          confirmKey="purchase.paidAmount"
          modes={['cash', 'upi', 'card']}
          owedPaise={Math.max(0, owe)}
          onClose={() => setPaying(false)}
          onDone={async (amount, mode, reference) => {
            const rt = app.rt!
            await paySupplier(rt.writer, { requestId: crypto.randomUUID(), supplierId: id, amountPaise: amount, mode, reference, identity: { tenantId: rt.config.tenantId, storeId: rt.config.storeId, deviceId: rt.config.deviceId }, actorUserId: rt.config.actorUserId ?? null, now: nowMs() })
            void rt.refresh()
            setPaying(false)
            setSaved(true)
            await load()
          }}
        />
      )}
    </Screen>
  )
}
