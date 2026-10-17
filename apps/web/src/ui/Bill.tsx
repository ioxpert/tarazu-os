import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { priceCart } from '../billing/calc'
import { holdBill, listHeld, discardHeld, resumeHeld, type HeldBill } from '../billing/hold'
import { cartLineFromItem, loadCustomerRate } from '../billing/pricing'
import type { CartLine, Discount } from '../billing/types'
import { formatQty, formatRupees, parseRupeesToPaise } from '../lib/numfmt'
import { listCategories } from '../catalogue/repo'
import { CATEGORY_TILES } from '../catalogue/starterPack/categories'
import { toBaseMilli, unitPriceFor, unitsOf, fromBaseMilli, formatQtyMilli } from '../catalogue/uom'
import type { CatalogueItem, Unit } from '../catalogue/types'
import { useApp } from './app'
import { billStore, useBill } from './billStore'
import { Banner, Button, Header, Keypad, Screen } from './components'
import { Modal, todayIst, useWedgeScanner } from './common'
import { CustomerPicker } from './CustomerPicker'
import { Icon } from './icons'
import { navigate } from './router'
import { CameraScanModal } from './scan'

function useDisplayName() {
  const { i18n } = useTranslation()
  return (x: { name: string; localName: string | null }) => (i18n.language === 'hi' && x.localName ? x.localName : x.name)
}

export default function BillScreen() {
  const { t } = useTranslation()
  const app = useApp()
  const bill = useBill()
  const nameOf = useDisplayName()
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [pickCustomer, setPickCustomer] = useState(false)
  const [showHeld, setShowHeld] = useState(false)
  const [held, setHeld] = useState<HeldBill[]>([])
  const [scanning, setScanning] = useState(false)
  const [needPrice, setNeedPrice] = useState<CatalogueItem | null>(null)
  const [looseItem, setLooseItem] = useState<CatalogueItem | null>(null)
  const [unknownCode, setUnknownCode] = useState<string | null>(null)
  const [discountOpen, setDiscountOpen] = useState(false)

  const onDate = todayIst()
  const priced = useMemo(() => {
    if (bill.lines.length === 0) return null
    try {
      return priceCart(
        { lines: bill.lines, billDiscount: bill.billDiscount },
        { gstMode: app.profile.gstMode, rounding: app.profile.rounding, rules: app.rules, onDate },
      )
    } catch {
      return null
    }
  }, [bill.lines, bill.billDiscount, app.profile.gstMode, app.profile.rounding, app.rules, onDate])

  const refreshHeld = useCallback(async () => {
    if (app.db) setHeld(await listHeld(app.db))
  }, [app.db])
  useEffect(() => {
    void refreshHeld()
  }, [refreshHeld])

  const addItem = useCallback(
    async (item: CatalogueItem, qtyMilli = 1000, unit?: Unit) => {
      if (item.loose && qtyMilli === 1000 && !unit) return setLooseItem(item)
      const rate = bill.customer && app.db ? await loadCustomerRate(app.db, item.id, bill.customer.id, new Date()) : null
      const line = cartLineFromItem(item, { qtyMilli, unit: item.uom.base, customerRatePaise: rate, rules: app.rules, gstMode: app.profile.gstMode, onDate })
      if (!line) return setNeedPrice(item)
      setUnknownCode(null)
      billStore.addLine(line, !item.loose)
    },
    [app.db, app.profile.gstMode, app.rules, bill.customer, onDate],
  )

  const onScan = useCallback(
    (code: string) => {
      const hits = app.index.byBarcode(code)
      if (hits.length > 0) void addItem(hits[0])
      else setUnknownCode(code)
    },
    [app.index, addItem],
  )
  useWedgeScanner(onScan)

  const popular = useMemo(() => {
    const pinned = app.items.filter((i) => i.active && i.pinned)
    const seen = new Set(pinned.map((i) => i.id))
    const top = app.items
      .filter((i) => i.active && !seen.has(i.id) && (app.popularity.get(i.id) ?? 0) > 0)
      .sort((a, b) => (app.popularity.get(b.id) ?? 0) - (app.popularity.get(a.id) ?? 0))
      .slice(0, 12)
    return [...pinned, ...top]
  }, [app.items, app.popularity])

  const results = useMemo<CatalogueItem[]>(() => {
    if (query.trim()) return app.index.search(query, { limit: 24, categoryId: category })
    if (category) return app.items.filter((i) => i.active && i.category === category).slice(0, 60)
    return popular
  }, [query, category, app.index, app.items, popular])

  const categories = useMemo(() => listCategories(app.items, CATEGORY_TILES).filter((c) => c.count > 0), [app.items])
  const { i18n } = useTranslation()
  const catLabel = (id: string) => {
    const c = CATEGORY_TILES.find((x) => x.id === id)
    return c ? (i18n.language === 'hi' ? c.hi : c.en) : id
  }

  const hold = async () => {
    if (!app.db || bill.lines.length === 0) return
    const first = bill.lines[0]
    await holdBill(app.db, billStore.toCart(), `${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ${first.name}`, priced?.totalPaise ?? 0)
    billStore.clear()
    await refreshHeld()
  }

  const resume = async (id: string) => {
    if (!app.db) return
    if (bill.lines.length > 0) await hold() // never lose the bill on the counter
    const cart = await resumeHeld(app.db, id)
    const customer = bill.customer
    billStore.load(cart, cart.partyId ? { id: cart.partyId, name: customer?.id === cart.partyId ? customer.name : t('bill.savedCustomer') } : null)
    setShowHeld(false)
    await refreshHeld()
  }

  const editingLine = bill.lines.find((l) => l.lineId === editing) ?? null

  return (
    <Screen testId="bill-screen">
      <Header
        title={t('bill.title')}
        onUndo={() => billStore.undo()}
        undoDisabled={!billStore.canUndo()}
        actions={
          <>
            <Button variant="ghost" icon="hold" onClick={() => void hold()} disabled={bill.lines.length === 0} data-testid="hold-bill" aria-label={t('bill.hold')}>
              <span className="topbar-label">{t('bill.hold')}</span>
            </Button>
            {held.length > 0 && (
              <Button variant="ghost" onClick={() => setShowHeld(true)} data-testid="held-bills">
                {t('bill.heldCount', { count: held.length })}
              </Button>
            )}
          </>
        }
      />
      <div className="screen-body bill-body">
        <section className="bill-pick" aria-label={t('bill.findItems')}>
          <div className="row" style={{ padding: 4 }}>
            <Icon name="search" />
            <input
              className="input"
              style={{ border: 'none' }}
              type="search"
              inputMode="search"
              enterKeyHint="search"
              placeholder={t('bill.searchPlaceholder')}
              aria-label={t('bill.searchPlaceholder')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              data-testid="item-search"
              autoFocus
            />
            <Button variant="ghost" icon="scan" onClick={() => setScanning(true)} aria-label={t('bill.scan')} data-testid="open-camera" />
          </div>
          {unknownCode && (
            <Banner kind="warning">
              <div>{t('bill.unknownBarcode', { code: unknownCode })}</div>
              <Button onClick={() => navigate(`/stock/new?barcode=${encodeURIComponent(unknownCode)}`)}>{t('bill.addThisItem')}</Button>
            </Banner>
          )}
          <div className="chips" role="group" aria-label={t('bill.categories')}>
            <button type="button" className="chip" aria-pressed={category === null} onClick={() => setCategory(null)}>
              {t('bill.popular')}
            </button>
            {categories.map((c) => (
              <button type="button" key={c.id} className="chip" aria-pressed={category === c.id} onClick={() => setCategory(c.id)}>
                {catLabel(c.id)}
              </button>
            ))}
          </div>
          {results.length === 0 ? (
            <p className="muted" data-testid="no-results">{query ? t('bill.noMatch') : t('bill.nothingPinned')}</p>
          ) : (
            <ul className="grid-items list" style={{ display: 'grid' }} data-testid="item-results">
              {results.map((it) => (
                <li key={it.id}>
                  <button type="button" className="item-card" style={{ width: '100%' }} onClick={() => void addItem(it)} data-testid="item-card">
                    <span className="row-title">{nameOf(it)}</span>
                    <span className="price">
                      {it.retailPaise ?? it.mrpPaise ? formatRupees((it.retailPaise ?? it.mrpPaise)!) : t('bill.noPrice')}
                      {it.loose ? ` / ${it.uom.base}` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="bill-cart" aria-label={t('bill.cart')}>
          <button type="button" className="row" onClick={() => setPickCustomer(true)} data-testid="customer-chip">
            <Icon name="khata" />
            <span className="row-main">{bill.customer ? bill.customer.name : t('bill.walkIn')}</span>
            <span className="muted">{t('bill.change')}</span>
          </button>
          {bill.lines.length === 0 ? (
            <p className="muted" data-testid="empty-cart">{t('bill.emptyCart')}</p>
          ) : (
            <ul className="list" data-testid="cart-lines">
              {priced &&
                bill.lines.map((l, i) => {
                  const pl = priced.lines[i]
                  const item = app.index.get(l.productId)
                  const short = item?.stockMilli != null && l.qtyMilli > item.stockMilli
                  return (
                    <li key={l.lineId} className="row" data-testid="cart-line">
                      <button type="button" className="row-main" style={{ all: 'unset', cursor: 'pointer', flex: 1, minWidth: 0 }} onClick={() => setEditing(l.lineId)} aria-label={t('bill.editLine', { name: nameOf(l) })}>
                        <div className="row-title">{nameOf(l)}</div>
                        <div className="muted">
                          {formatQty(l.qtyMilli, l.unit)} × {formatRupees(l.unitPricePaise)}
                          {pl.discountPaise > 0 && ` − ${formatRupees(pl.discountPaise)}`}
                        </div>
                        {short && (
                          <span className="badge badge-warn">
                            <Icon name="warning" size={16} />
                            {t('bill.shortStock')}
                          </span>
                        )}
                      </button>
                      {!item?.loose && (
                        <span className="qty">
                          <button type="button" aria-label={t('bill.less')} onClick={() => (l.qtyMilli > 1000 ? billStore.updateLine(l.lineId, { qtyMilli: l.qtyMilli - 1000 }) : billStore.removeLine(l.lineId))}>−</button>
                          <button type="button" aria-label={t('bill.more')} onClick={() => billStore.updateLine(l.lineId, { qtyMilli: l.qtyMilli + 1000 })}>+</button>
                        </span>
                      )}
                      <strong className="num" style={{ minWidth: 72 }}>{formatRupees(pl.lineTotalPaise)}</strong>
                      <Button variant="ghost" icon="close" onClick={() => billStore.removeLine(l.lineId)} aria-label={t('bill.remove', { name: nameOf(l) })} />
                    </li>
                  )
                })}
            </ul>
          )}
          {bill.lines.length > 0 && (
            <Button onClick={() => setDiscountOpen(true)} data-testid="bill-discount">
              {bill.billDiscount ? t('bill.discountSet') : t('bill.addDiscount')}
            </Button>
          )}
        </section>
      </div>

      <footer className="screen-footer">
        <div style={{ flex: 1 }}>
          <div className="muted">{t('bill.items', { count: bill.lines.length })}</div>
          <div className="total-big num" data-testid="bill-total">{formatRupees(priced?.totalPaise ?? 0, { paise: 'auto' })}</div>
        </div>
        <Button variant="primary" onClick={() => navigate('/tender')} disabled={!priced} data-testid="pay">
          {t('bill.pay')}
        </Button>
      </footer>

      {editingLine && app.db && (
        <LineEditor
          line={editingLine}
          item={app.index.get(editingLine.productId) ?? null}
          onClose={() => setEditing(null)}
        />
      )}
      {pickCustomer && <CustomerPicker onClose={() => setPickCustomer(false)} onPicked={(c) => { void repriceForCustomer(c); setPickCustomer(false) }} />}
      {showHeld && (
        <Modal title={t('bill.heldTitle')} onClose={() => setShowHeld(false)} testId="held-modal">
          <ul className="list">
            {held.map((h) => (
              <li key={h.id} className="row">
                <span className="row-main">
                  <div className="row-title">{h.label}</div>
                  <div className="muted">{formatRupees(h.totalPaise)}</div>
                </span>
                <Button onClick={() => void resume(h.id)} data-testid="resume-bill">{t('bill.resume')}</Button>
                <Button variant="danger" onClick={() => app.db && void discardHeld(app.db, h.id).then(refreshHeld)}>{t('bill.discard')}</Button>
              </li>
            ))}
          </ul>
        </Modal>
      )}
      {scanning && <CameraScanModal onClose={() => setScanning(false)} onCode={(c) => { setScanning(false); onScan(c) }} />}
      {needPrice && <PricePrompt item={needPrice} onClose={() => setNeedPrice(null)} onPrice={(paise) => {
        const line = cartLineFromItem(needPrice, { qtyMilli: 1000, unit: needPrice.uom.base, manualUnitPricePaise: paise, rules: app.rules, gstMode: app.profile.gstMode, onDate })
        if (line) billStore.addLine(line, false)
        setNeedPrice(null)
      }} />}
      {looseItem && <LooseQuantity item={looseItem} onClose={() => setLooseItem(null)} onQty={(q, u) => { const it = looseItem; setLooseItem(null); void addItem(it, q, u) }} />}
      {discountOpen && <BillDiscountModal current={bill.billDiscount} onClose={() => setDiscountOpen(false)} />}
    </Screen>
  )

  async function repriceForCustomer(c: { id: string; name: string } | null) {
    billStore.setCustomer(c)
    if (!app.db || !c) return
    const next: CartLine[] = []
    for (const l of billStore.get().lines) {
      if (l.priceSource === 'manual') {
        next.push(l)
        continue
      }
      const rate = await loadCustomerRate(app.db, l.productId, c.id, new Date())
      const item = app.index.get(l.productId)
      if (rate != null) next.push({ ...l, unitPricePaise: rate, priceSource: 'customer' })
      else if (item) {
        const fresh = cartLineFromItem(item, { qtyMilli: l.qtyMilli, unit: l.unit, rules: app.rules, gstMode: app.profile.gstMode, onDate, lineId: l.lineId })
        next.push(fresh ? { ...fresh, discount: l.discount } : l)
      } else next.push(l)
    }
    billStore.replaceLines(next)
  }
}

function PricePrompt({ item, onPrice, onClose }: { item: CatalogueItem; onPrice: (paise: number) => void; onClose: () => void }) {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const paise = parseRupeesToPaise(text)
  return (
    <Modal title={t('bill.setPriceTitle', { name: item.name })} onClose={onClose} testId="price-prompt">
      <p className="muted">{t('bill.setPriceHint')}</p>
      <div className="input num" data-testid="price-display">{text ? `₹${text}` : ' '}</div>
      <Keypad value={text} onChange={setText} decimal />
      <Button variant="primary" disabled={paise === null || paise <= 0} onClick={() => paise && onPrice(paise)} data-testid="price-confirm">{t('bill.addToBill')}</Button>
    </Modal>
  )
}

function LooseQuantity({ item, onQty, onClose }: { item: CatalogueItem; onQty: (qtyMilli: number, unit: Unit) => void; onClose: () => void }) {
  const { t } = useTranslation()
  const units = unitsOf(item.uom)
  const [unit, setUnit] = useState<Unit>(item.uom.base)
  const [text, setText] = useState('')
  const milli = text ? safeMilli(item, unit, text) : null
  return (
    <Modal title={t('bill.howMuch', { name: item.name })} onClose={onClose} testId="loose-qty">
      <div className="chips" role="group">
        {units.map((u) => (
          <button type="button" key={u} className="chip" aria-pressed={unit === u} onClick={() => setUnit(u)}>{u}</button>
        ))}
      </div>
      <div className="input num" data-testid="qty-display">{text || ' '} {unit}</div>
      <Keypad value={text} onChange={setText} decimal />
      <Button variant="primary" disabled={!milli || milli <= 0} onClick={() => milli && onQty(milli, unit)} data-testid="qty-confirm">{t('bill.addToBill')}</Button>
    </Modal>
  )
}

function safeMilli(item: CatalogueItem, unit: Unit, text: string): number | null {
  try {
    return toBaseMilli(item.uom, unit, text)
  } catch {
    return null
  }
}

/** Quantity, unit, price and discount of one line. */
function LineEditor({ line, item, onClose }: { line: CartLine; item: CatalogueItem | null; onClose: () => void }) {
  const { t } = useTranslation()
  const units = item ? unitsOf(item.uom) : [line.unit]
  const [unit, setUnit] = useState<Unit>(line.unit)
  const [qty, setQty] = useState(() => (item ? formatQtyMilli(fromBaseMilli(item.uom, line.unit, line.qtyMilli) * 1000) : String(line.qtyMilli / 1000)))
  const [price, setPrice] = useState(() => (line.unitPricePaise / 100).toFixed(2).replace(/\.00$/, ''))
  const [dKind, setDKind] = useState<'percent' | 'amount'>(line.discount?.kind ?? 'percent')
  const [dText, setDText] = useState(() => (line.discount ? (line.discount.kind === 'percent' ? String(line.discount.bp / 100) : String(line.discount.paise / 100)) : ''))
  const [field, setField] = useState<'qty' | 'price' | 'discount'>('qty')

  const value = field === 'qty' ? qty : field === 'price' ? price : dText
  const setValue = field === 'qty' ? setQty : field === 'price' ? setPrice : setDText

  const save = () => {
    const patch: Partial<CartLine> = {}
    const milli = item ? safeMilli(item, unit, qty) : Math.round(Number(qty) * 1000)
    if (milli && milli > 0) patch.qtyMilli = milli
    const p = parseRupeesToPaise(price)
    if (p !== null && p !== line.unitPricePaise) {
      patch.unitPricePaise = p
      patch.priceSource = 'manual'
    }
    let discount: Discount | null = null
    if (dText) {
      if (dKind === 'percent') {
        const bp = Math.round(Number(dText) * 100)
        if (bp > 0 && bp <= 10000) discount = { kind: 'percent', bp }
      } else {
        const paise = parseRupeesToPaise(dText)
        if (paise && paise > 0) discount = { kind: 'amount', paise }
      }
    }
    patch.discount = discount
    billStore.updateLine(line.lineId, patch)
    onClose()
  }

  return (
    <Modal title={line.name} onClose={onClose} testId="line-editor">
      <div className="chips" role="group" aria-label={t('bill.editWhat')}>
        <button type="button" className="chip" aria-pressed={field === 'qty'} onClick={() => setField('qty')}>{t('bill.qty')}: {qty} {unit}</button>
        <button type="button" className="chip" aria-pressed={field === 'price'} onClick={() => setField('price')}>{t('bill.rate')}: ₹{price}</button>
        <button type="button" className="chip" aria-pressed={field === 'discount'} onClick={() => setField('discount')} data-testid="edit-discount">
          {t('bill.discount')}: {dText ? (dKind === 'percent' ? `${dText}%` : `₹${dText}`) : '–'}
        </button>
      </div>
      {field === 'qty' && units.length > 1 && (
        <div className="chips" role="group" aria-label={t('bill.unit')}>
          {units.map((u) => (
            <button type="button" key={u} className="chip" aria-pressed={unit === u} onClick={() => { if (item) setQty(formatQtyMilli(fromBaseMilli(item.uom, u, safeMilli(item, unit, qty) ?? 0) * 1000)); setUnit(u) }}>{u}</button>
          ))}
        </div>
      )}
      {field === 'price' && item && unit !== item.uom.base && (
        <p className="muted">{t('bill.pricePerBase', { unit: item.uom.base, price: formatRupees(unitPriceFor(item.uom, unit, line.unitPricePaise)), other: unit })}</p>
      )}
      {field === 'discount' && (
        <div className="chips" role="group" aria-label={t('bill.discountKind')}>
          <button type="button" className="chip" aria-pressed={dKind === 'percent'} onClick={() => setDKind('percent')}>%</button>
          <button type="button" className="chip" aria-pressed={dKind === 'amount'} onClick={() => setDKind('amount')}>₹</button>
        </div>
      )}
      <div className="input num" data-testid="editor-display">{value || ' '}</div>
      <Keypad value={value} onChange={setValue} decimal />
      <Button variant="primary" onClick={save} data-testid="line-save">{t('common.done')}</Button>
    </Modal>
  )
}

function BillDiscountModal({ current, onClose }: { current: Discount | null; onClose: () => void }) {
  const { t } = useTranslation()
  const [kind, setKind] = useState<'percent' | 'amount'>(current?.kind ?? 'percent')
  const [text, setText] = useState(current ? (current.kind === 'percent' ? String(current.bp / 100) : String(current.paise / 100)) : '')
  const apply = () => {
    let d: Discount | null = null
    if (kind === 'percent') {
      const bp = Math.round(Number(text) * 100)
      if (bp > 0 && bp <= 10000) d = { kind: 'percent', bp }
    } else {
      const paise = parseRupeesToPaise(text)
      if (paise && paise > 0) d = { kind: 'amount', paise }
    }
    billStore.setBillDiscount(d)
    onClose()
  }
  return (
    <Modal title={t('bill.discountTitle')} onClose={onClose} testId="discount-modal">
      <div className="chips" role="group" aria-label={t('bill.discountKind')}>
        <button type="button" className="chip" aria-pressed={kind === 'percent'} onClick={() => setKind('percent')}>%</button>
        <button type="button" className="chip" aria-pressed={kind === 'amount'} onClick={() => setKind('amount')}>₹</button>
      </div>
      <div className="input num" data-testid="discount-display">{text || ' '}</div>
      <Keypad value={text} onChange={setText} decimal />
      <p className="muted">{t('bill.discountPolicyHint')}</p>
      <Button variant="primary" onClick={apply} data-testid="discount-apply">{text ? t('common.done') : t('bill.removeDiscount')}</Button>
    </Modal>
  )
}
