import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { lookupBarcode, type ItemPrefill } from '../catalogue/master'
import { createItem, type DraftIssue } from '../catalogue/repo'
import { CATEGORY_TILES } from '../catalogue/starterPack/categories'
import type { DuplicateResult } from '../catalogue/duplicates'
import type { Unit, UomSpec } from '../catalogue/types'
import { buildChain, looseSpec, simpleSpec, UNITS } from '../catalogue/uom'
import { parseRupeesToPaise } from '../lib/numfmt'
import { useApp } from './app'
import { Banner, Button, Header, Screen } from './components'
import { Modal, useWedgeScanner } from './common'
import { navigate, useRoute } from './router'
import { CameraScanModal } from './scan'
import { Icon } from './icons'

const PACK_UNITS: Unit[] = ['packet', 'strip', 'bottle', 'dozen', 'bag', 'box', 'case', 'carton', 'bundle']

/**
 * Add an item. The only required field is the name, so a new item takes seconds: name, price, Save.
 * An unknown barcode (typed, wedge-scanned or camera) is looked up locally, then in the platform master, and the
 * form is pre-filled from it. Every pre-filled field stays editable.
 */
export default function ItemFormScreen() {
  const { t, i18n } = useTranslation()
  const app = useApp()
  const route = useRoute()
  const [name, setName] = useState('')
  const [localName, setLocalName] = useState('')
  const [brand, setBrand] = useState('')
  const [category, setCategory] = useState<string | null>(null)
  const [barcode, setBarcode] = useState(route.query.get('barcode') ?? '')
  const [hsn, setHsn] = useState('')
  const [unit, setUnit] = useState<Unit>('piece')
  const [loose, setLoose] = useState(false)
  const [mrp, setMrp] = useState('')
  const [price, setPrice] = useState('')
  const [opening, setOpening] = useState('')
  const [taxRate, setTaxRate] = useState('')
  const [more, setMore] = useState(false)
  const [packUnit, setPackUnit] = useState<Unit | ''>('')
  const [packCount, setPackCount] = useState('')
  const [issues, setIssues] = useState<DraftIssue[]>([])
  const [dup, setDup] = useState<DuplicateResult | null>(null)
  const [lookup, setLookup] = useState<'idle' | 'busy' | 'master' | 'none' | 'offline' | 'local'>('idle')
  const [scanning, setScanning] = useState(false)
  const [saving, setSaving] = useState(false)

  const fill = (p: ItemPrefill) => {
    setName(p.name)
    setLocalName(p.localName ?? '')
    setBrand(p.brand ?? '')
    setCategory(p.category)
    setHsn(p.hsn ?? '')
    if (p.mrpPaise) setMrp(String(p.mrpPaise / 100))
    setUnit(p.unit)
    setMore(true)
  }

  const runLookup = async (code: string) => {
    if (!app.db || !app.rt || !code) return
    setLookup('busy')
    const res = await lookupBarcode(app.db, code, fetch, { storeId: app.rt.config.storeId, timeoutMs: 1500 })
    if (res.source === 'local') {
      setLookup('local')
      navigate(`/stock/item/${res.item.id}`)
    } else if (res.source === 'master') {
      fill(res.draft)
      setLookup('master')
    } else setLookup(res.source === 'offline' ? 'offline' : 'none')
  }

  useEffect(() => {
    const code = route.query.get('barcode')
    if (code) void runLookup(code)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useWedgeScanner((code) => {
    setBarcode(code)
    void runLookup(code)
  })

  const buildUom = (): UomSpec => {
    const count = Number(packCount)
    if (packUnit && count >= 1 && Number.isInteger(count)) return buildChain([{ unit: packUnit, per: count }, { unit }])
    if (loose && (unit === 'kg' || unit === 'litre')) return looseSpec(unit)
    return simpleSpec(unit)
  }

  const save = async (allowDuplicate = false) => {
    if (!app.rt || !app.db) return
    setSaving(true)
    setIssues([])
    try {
      const mrpPaise = mrp ? parseRupeesToPaise(mrp) : null
      const retail = price ? parseRupeesToPaise(price) : null
      const rate = taxRate ? Math.round(Number(taxRate) * 100) : null
      const res = await createItem(
        app.rt.writer,
        app.db,
        { tenantId: app.rt.config.tenantId, storeId: app.rt.config.storeId, deviceId: app.rt.config.deviceId, actorUserId: app.rt.config.actorUserId },
        {
          name,
          localName: localName || null,
          brand: brand || null,
          category,
          barcode: barcode || null,
          hsn: hsn || null,
          unit,
          uom: buildUom(),
          loose,
          mrpPaise,
          retailPaise: retail ?? mrpPaise,
          taxRateBp: rate,
          openingStock: opening ? { qty: opening, unit } : null,
          allowDuplicate,
        },
        { index: app.index },
      )
      if (res.status === 'created') {
        await app.reloadItems([res.item.id])
        void app.rt.refresh()
        navigate('/stock')
      } else if (res.status === 'duplicate') setDup(res.duplicate)
      else setIssues(res.issues)
    } catch {
      setIssues(['bad_uom'])
    } finally {
      setSaving(false)
    }
  }

  const issue = (i: DraftIssue) => issues.includes(i)

  return (
    <Screen testId="item-form">
      <Header title={t('itemForm.title')} />
      <div className="screen-body">
        {lookup === 'busy' && <Banner kind="info">{t('itemForm.lookingUp')}</Banner>}
        {lookup === 'master' && <Banner kind="ok">{t('itemForm.foundInMaster')}</Banner>}
        {lookup === 'none' && <Banner kind="info">{t('itemForm.notInMaster')}</Banner>}
        {lookup === 'offline' && <Banner kind="info">{t('itemForm.lookupOffline')}</Banner>}

        <div className="field">
          <label htmlFor="if-name">{t('itemForm.name')}</label>
          <input id="if-name" className="input" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={issue('name_required')} autoFocus data-testid="if-name" />
          {issue('name_required') && <span className="error-text"><Icon name="warning" size={16} />{t('itemForm.nameRequired')}</span>}
        </div>
        <div className="field">
          <label htmlFor="if-price">{t('itemForm.price', { unit })}</label>
          <input id="if-price" className="input num" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} aria-invalid={issue('bad_price')} data-testid="if-price" />
        </div>
        <div className="field">
          <span className="label">{t('itemForm.category')}</span>
          <div className="chips" role="group">
            {CATEGORY_TILES.map((c) => (
              <button type="button" key={c.id} className="chip" aria-pressed={category === c.id} onClick={() => setCategory(category === c.id ? null : c.id)}>
                {i18n.language === 'hi' ? c.hi : c.en}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <label htmlFor="if-barcode">{t('itemForm.barcode')}</label>
          <div className="row" style={{ padding: 4 }}>
            <input id="if-barcode" className="input" style={{ border: 'none' }} inputMode="numeric" value={barcode} onChange={(e) => setBarcode(e.target.value)} onBlur={() => barcode && lookup === 'idle' && void runLookup(barcode)} aria-invalid={issue('bad_barcode')} data-testid="if-barcode" />
            <Button variant="ghost" icon="scan" onClick={() => setScanning(true)} aria-label={t('bill.scan')} />
          </div>
        </div>

        <button type="button" className="chip" aria-expanded={more} onClick={() => setMore(!more)}>{more ? t('itemForm.fewer') : t('itemForm.more')}</button>
        {more && (
          <>
            <div className="field"><label htmlFor="if-local">{t('itemForm.localName')}</label><input id="if-local" className="input" value={localName} onChange={(e) => setLocalName(e.target.value)} /></div>
            <div className="field"><label htmlFor="if-brand">{t('itemForm.brand')}</label><input id="if-brand" className="input" value={brand} onChange={(e) => setBrand(e.target.value)} /></div>
            <div className="field"><label htmlFor="if-mrp">{t('itemForm.mrp')}</label><input id="if-mrp" className="input num" inputMode="decimal" value={mrp} onChange={(e) => setMrp(e.target.value)} /></div>
            <div className="field"><label htmlFor="if-hsn">{t('itemForm.hsn')}</label><input id="if-hsn" className="input" inputMode="numeric" value={hsn} onChange={(e) => setHsn(e.target.value)} aria-invalid={issue('bad_hsn')} /></div>
            <div className="field"><label htmlFor="if-tax">{t('itemForm.taxRate')}</label><input id="if-tax" className="input num" inputMode="decimal" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} aria-invalid={issue('bad_tax_rate')} /><span className="hint">{t('itemForm.taxRateHint')}</span></div>
            <div className="field">
              <label htmlFor="if-unit">{t('itemForm.unit')}</label>
              <select id="if-unit" className="input" value={unit} onChange={(e) => setUnit(e.target.value as Unit)}>
                {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>
            <label className="row"><input type="checkbox" checked={loose} onChange={(e) => { setLoose(e.target.checked); if (e.target.checked && unit !== 'kg' && unit !== 'litre') setUnit('kg') }} style={{ width: 24, height: 24 }} />{t('itemForm.loose')}</label>
            <div className="field">
              <span className="label">{t('itemForm.packChain')}</span>
              <div className="row">
                <span>1</span>
                <select className="input" aria-label={t('itemForm.bigUnit')} value={packUnit} onChange={(e) => setPackUnit(e.target.value as Unit | '')}>
                  <option value="">–</option>
                  {PACK_UNITS.filter((u) => u !== unit).map((u) => <option key={u} value={u}>{u}</option>)}
                </select>
                <span>=</span>
                <input className="input num" style={{ maxWidth: 90 }} inputMode="numeric" aria-label={t('itemForm.howMany')} value={packCount} onChange={(e) => setPackCount(e.target.value)} />
                <span>{unit}</span>
              </div>
              <span className="hint">{t('itemForm.packChainHint')}</span>
            </div>
            <div className="field"><label htmlFor="if-open">{t('itemForm.opening', { unit })}</label><input id="if-open" className="input num" inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value)} /></div>
          </>
        )}
        {issues.length > 0 && !issue('name_required') && <Banner kind="error">{t('itemForm.checkFields')}</Banner>}
      </div>
      <footer className="screen-footer">
        <Button variant="primary" className="btn-block" disabled={saving} onClick={() => void save()} data-testid="if-save">{t('common.save')}</Button>
      </footer>
      {scanning && <CameraScanModal onClose={() => setScanning(false)} onCode={(c) => { setScanning(false); setBarcode(c); void runLookup(c) }} />}
      {dup && (
        <Modal title={dup.code === 'barcode_exists' ? t('itemForm.barcodeExists') : t('itemForm.maybeSame')} onClose={() => setDup(null)} testId="dup-modal">
          <ul className="list">
            {(dup.exactBarcode ? [dup.exactBarcode] : dup.similar.map((s) => s.item)).map((it) => (
              <li key={it.id} className="row">
                <span className="row-main">{it.name}{it.brand ? ` · ${it.brand}` : ''}</span>
                <Button onClick={() => navigate(`/stock/item/${it.id}`)}>{t('itemForm.useThis')}</Button>
              </li>
            ))}
          </ul>
          {dup.code !== 'barcode_exists' && (
            <Button variant="primary" onClick={() => { setDup(null); void save(true) }} data-testid="create-anyway">{t('itemForm.createAnyway')}</Button>
          )}
        </Modal>
      )}
    </Screen>
  )
}
