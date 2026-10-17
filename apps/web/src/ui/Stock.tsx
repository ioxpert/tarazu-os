import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatQtyMilli, fromBaseMilli } from '../catalogue/uom'
import { formatRupees } from '../lib/numfmt'
import { setPrice, pinItem, stockIn } from '../catalogue/repo'
import { countStock } from '../purchase/stockCount'
import { toBaseMilli } from '../catalogue/uom'
import type { CatalogueItem } from '../catalogue/types'
import { useApp } from './app'
import { Banner, Button, Header, Keypad, Screen } from './components'
import { Modal, useWedgeScanner } from './common'
import { Icon } from './icons'
import { navigate } from './router'
import { CameraScanModal } from './scan'
import { parseRupeesToPaise } from '../lib/numfmt'

/** Stock: what is on the shelf, what came in, what is short. Adding an item is the one dominant action. */
export default function StockScreen() {
  const { t, i18n } = useTranslation()
  const app = useApp()
  const [q, setQ] = useState('')
  const [scanning, setScanning] = useState(false)
  const [filter, setFilter] = useState<'all' | 'short'>('all')

  const onCode = (code: string) => {
    const hit = app.index.byBarcode(code)[0]
    navigate(hit ? `/stock/item/${hit.id}` : `/stock/new?barcode=${encodeURIComponent(code)}`)
  }
  useWedgeScanner(onCode)

  const list = useMemo(() => {
    const base = q.trim() ? app.index.search(q, { limit: 80 }) : app.items.filter((i) => i.active).slice(0, 200)
    return filter === 'short' ? base.filter((i) => i.stockMilli !== null && i.stockMilli <= 0) : base
  }, [q, filter, app.index, app.items])

  return (
    <Screen testId="stock-screen">
      <Header title={t('stock.title')} />
      <div className="screen-body">
        <div className="row" style={{ padding: 4 }}>
          <Icon name="search" />
          <input className="input" style={{ border: 'none' }} type="search" placeholder={t('stock.search')} aria-label={t('stock.search')} value={q} onChange={(e) => setQ(e.target.value)} data-testid="stock-search" />
          <Button variant="ghost" icon="scan" onClick={() => setScanning(true)} aria-label={t('bill.scan')} />
        </div>
        <div className="chips" role="group">
          <button type="button" className="chip" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>{t('stock.all')}</button>
          <button type="button" className="chip" aria-pressed={filter === 'short'} onClick={() => setFilter('short')}>{t('stock.short')}</button>
        </div>
        <ul className="list" data-testid="stock-list">
          {list.map((it) => (
            <li key={it.id}>
              <button type="button" className="row" style={{ width: '100%', textAlign: 'left' }} onClick={() => navigate(`/stock/item/${it.id}`)} data-testid="stock-row">
                <span className="row-main">
                  <span className="row-title">{i18n.language === 'hi' && it.localName ? it.localName : it.name}</span>
                  <span className="muted">{it.retailPaise ?? it.mrpPaise ? formatRupees((it.retailPaise ?? it.mrpPaise)!) : t('bill.noPrice')}</span>
                </span>
                <StockBadge item={it} />
              </button>
            </li>
          ))}
        </ul>
      </div>
      <footer className="screen-footer" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
        <Button variant="primary" icon="plus" className="btn-block" onClick={() => navigate('/stock/in')} data-testid="stock-in">{t('stock.cameInAction')}</Button>
        <div className="tender-row">
          <Button onClick={() => navigate('/stock/new')} data-testid="add-item">{t('stock.addItem')}</Button>
          <Button onClick={() => navigate('/stock/purchases')} data-testid="open-purchases">{t('purchase.history')}</Button>
          <Button onClick={() => navigate('/stock/suppliers')} data-testid="open-suppliers">{t('purchase.suppliers')}</Button>
        </div>
      </footer>
      {scanning && <CameraScanModal onClose={() => setScanning(false)} onCode={(c) => { setScanning(false); onCode(c) }} />}
    </Screen>
  )
}

export function StockBadge({ item }: { item: CatalogueItem }) {
  const { t } = useTranslation()
  if (item.stockMilli === null) return <span className="badge">{t('stock.notCounted')}</span>
  const shown = formatQtyMilli(fromBaseMilli(item.uom, item.uom.base, item.stockMilli))
  if (item.stockMilli < 0 || item.oversold)
    return (
      <span className="badge badge-warn" data-testid="oversold-badge">
        <Icon name="warning" size={16} />
        {t('stock.oversold', { qty: shown, unit: item.uom.base })}
      </span>
    )
  if (item.stockMilli === 0)
    return (
      <span className="badge badge-warn">
        <Icon name="warning" size={16} />
        {t('stock.none')}
      </span>
    )
  return <span className="badge badge-ok">{t('stock.inStock', { qty: shown, unit: item.uom.base })}</span>
}

/** One item: price, "stock came in", pin to the billing screen. */
export function ItemDetail({ id }: { id: string }) {
  const { t } = useTranslation()
  const app = useApp()
  const item = app.index.get(id)
  const [mode, setMode] = useState<'stock' | 'price' | 'count' | null>(null)
  const [damage, setDamage] = useState(false)
  const [text, setText] = useState('')
  const [unit, setUnit] = useState(item?.uom.base)
  const [msg, setMsg] = useState<string | null>(null)
  if (!item || !app.rt) {
    return (
      <Screen>
        <Header title={t('stock.title')} />
        <div className="screen-body"><p className="muted">{t('stock.notFound')}</p></div>
      </Screen>
    )
  }
  const rt = app.rt
  const ctx = { tenantId: rt.config.tenantId, storeId: rt.config.storeId, deviceId: rt.config.deviceId, actorUserId: rt.config.actorUserId }
  const units = [item.uom.base, ...item.uom.units.map((u) => u.unit)]

  const save = async () => {
    try {
      if (mode === 'stock') {
        await stockIn(rt.writer, ctx, item, text, unit ?? item.uom.base)
        setMsg(t('stock.cameIn'))
      } else if (mode === 'count') {
        const counted = toBaseMilli(item.uom, unit ?? item.uom.base, text)
        const r = await countStock(rt.writer, ctx, item.id, counted, { reason: damage ? 'damage' : 'adjustment' })
        setMsg(r.deltaMilli === 0 ? t('stock.countMatches') : t('stock.countSaved'))
      } else if (mode === 'price') {
        const p = parseRupeesToPaise(text)
        if (!p) return
        await setPrice(rt.writer, ctx, item.id, 'retail', p)
        setMsg(t('stock.priceSaved'))
      }
      setMode(null)
      setText('')
      await app.reloadItems([item.id])
      void rt.refresh()
    } catch {
      setMsg(t('billing.error.unknown'))
    }
  }

  return (
    <Screen testId="item-detail">
      <Header title={item.name} />
      <div className="screen-body">
        {msg && <Banner kind="ok">{msg}</Banner>}
        <div className="row"><span className="row-main">{t('stock.onShelf')}</span><StockBadge item={item} /></div>
        <div className="row"><span className="row-main">{t('stock.sellingPrice')}</span><strong>{item.retailPaise ?? item.mrpPaise ? formatRupees((item.retailPaise ?? item.mrpPaise)!) : t('bill.noPrice')}</strong></div>
        {item.mrpPaise != null && <div className="row"><span className="row-main">{t('stock.mrp')}</span><span>{formatRupees(item.mrpPaise)}</span></div>}
        <div className="row"><span className="row-main">{t('stock.barcode')}</span><span>{item.barcode ?? '–'}</span></div>
        <Button variant="primary" icon="plus" onClick={() => { setMode('stock'); setText('') }} data-testid="stock-came-in">{t('stock.cameInAction')}</Button>
        <Button onClick={() => { setMode('count'); setText('') }} data-testid="count-stock">{t('stock.countAction')}</Button>
        <Button onClick={() => { setMode('price'); setText('') }}>{t('stock.changePrice')}</Button>
        <Button icon="star" onClick={() => void pinItem(rt.writer, ctx, item.id, !item.pinned).then(() => app.reloadItems([item.id]))}>
          {item.pinned ? t('stock.unpin') : t('stock.pin')}
        </Button>
      </div>
      {mode && (
        <Modal title={mode === 'stock' ? t('stock.cameInAction') : mode === 'count' ? t('stock.countAction') : t('stock.changePrice')} onClose={() => setMode(null)} testId="stock-modal">
          {mode === 'count' && <p className="muted">{t('stock.countHint')}</p>}
          {(mode === 'stock' || mode === 'count') && units.length > 1 && (
            <div className="chips" role="group">
              {units.map((u) => <button type="button" className="chip" key={u} aria-pressed={unit === u} onClick={() => setUnit(u)}>{u}</button>)}
            </div>
          )}
          {mode === 'count' && (
            <label className="row"><input type="checkbox" style={{ width: 24, height: 24 }} checked={damage} onChange={(e) => setDamage(e.target.checked)} />{t('stock.countDamage')}</label>
          )}
          <div className="input num" data-testid="stock-display">{text || ' '}</div>
          <Keypad value={text} onChange={setText} decimal />
          <Button variant="primary" onClick={() => void save()} disabled={!text} data-testid="stock-save">{t('common.save')}</Button>
        </Modal>
      )}
    </Screen>
  )
}
