import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { savePolicy } from '../billing/policy'
import { VPA_PATTERN } from '../billing/settings'
import { LANGUAGES, setLanguage, storedLanguage, type LanguageCode } from '../i18n'
import { SyncStatusBadge } from '../sync/SyncStatusBadge'
import { useApp } from './app'
import { Banner, Button, Header, Screen } from './components'
import { connectPrinter, DEFAULT_PRINTER, loadPrinterSettings, savePrinterSettings, type PrinterSettings } from './printing'

export default function SettingsScreen() {
  const { t } = useTranslation()
  const app = useApp()
  const [lang, setLang] = useState<LanguageCode>(storedLanguage())
  const [vpa, setVpa] = useState(app.profile.upiVpa ?? '')
  const [address, setAddress] = useState(app.profile.address ?? '')
  const [phone, setPhone] = useState(app.profile.phone ?? '')
  const [rounding, setRounding] = useState(app.profile.rounding)
  const [maxDiscount, setMaxDiscount] = useState(String(app.policy.maxCashierDiscountBp / 100))
  const [printer, setPrinter] = useState<PrinterSettings>(DEFAULT_PRINTER)
  const [kinds, setKinds] = useState<string[]>([])
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  useEffect(() => {
    if (app.db) void loadPrinterSettings(app.db).then(setPrinter)
    void import('../print/transports').then((m) => setKinds(m.availableTransports()))
  }, [app.db])

  const vpaOk = vpa === '' || VPA_PATTERN.test(vpa)

  const saveBusiness = async () => {
    if (!vpaOk) return setMsg({ kind: 'error', text: t('settings.badVpa') })
    await app.setProfile({ ...app.profile, upiVpa: vpa || null, address: address || null, phone: phone || null, rounding })
    if (app.db) {
      const bp = Math.min(10000, Math.max(0, Math.round(Number(maxDiscount) * 100) || 0))
      const next = { ...app.policy, maxCashierDiscountBp: bp }
      await savePolicy(app.db, next)
      app.setPolicy(next)
    }
    setMsg({ kind: 'ok', text: t('settings.saved') })
  }

  const updatePrinter = async (patch: Partial<PrinterSettings>) => {
    const next = { ...printer, ...patch }
    setPrinter(next)
    if (app.db) await savePrinterSettings(app.db, next)
  }

  const connect = async (kind: PrinterSettings['kind']) => {
    if (!kind) return
    try {
      const tr = await connectPrinter(kind)
      await updatePrinter({ kind, name: tr.name })
      setMsg({ kind: 'ok', text: t('settings.printerConnected', { name: tr.name }) })
    } catch {
      setMsg({ kind: 'error', text: t('settings.printerFailed') })
    }
  }

  return (
    <Screen testId="settings-screen">
      <Header title={t('settings.title')} />
      <div className="screen-body">
        {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}
        <section className="field">
          <span className="label">{t('settings.language')}</span>
          <div className="chips" role="group">
            {LANGUAGES.map((l) => (
              <button type="button" key={l.code} className="chip" aria-pressed={lang === l.code} onClick={() => { setLang(l.code); void setLanguage(l.code) }} data-testid={`lang-${l.code}`}>{l.label}</button>
            ))}
          </div>
        </section>

        <section className="field">
          <span className="label">{t('settings.business')}</span>
          <div className="row"><span className="row-main">{app.profile.businessName || t('settings.notSet')}</span><span className="badge">{t(`settings.gst.${app.profile.gstMode}`)}</span></div>
          <label htmlFor="s-vpa">{t('settings.upiId')}</label>
          <input id="s-vpa" className="input" value={vpa} onChange={(e) => setVpa(e.target.value.trim())} placeholder="shopname@bank" aria-invalid={!vpaOk} data-testid="set-vpa" />
          <label htmlFor="s-addr">{t('settings.address')}</label>
          <input id="s-addr" className="input" value={address} onChange={(e) => setAddress(e.target.value)} />
          <label htmlFor="s-phone">{t('settings.phone')}</label>
          <input id="s-phone" className="input" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <label className="row"><input type="checkbox" style={{ width: 24, height: 24 }} checked={rounding === 'nearest_rupee'} onChange={(e) => setRounding(e.target.checked ? 'nearest_rupee' : 'none')} />{t('settings.roundOff')}</label>
          <label htmlFor="s-disc">{t('settings.maxDiscount')}</label>
          <input id="s-disc" className="input num" inputMode="decimal" value={maxDiscount} onChange={(e) => setMaxDiscount(e.target.value)} data-testid="set-max-discount" />
          <span className="hint">{t('settings.maxDiscountHint')}</span>
          <Button variant="primary" onClick={() => void saveBusiness()} data-testid="save-settings">{t('common.save')}</Button>
        </section>

        <section className="field">
          <span className="label">{t('settings.printer')}</span>
          <div className="row"><span className="row-main">{printer.kind ? `${printer.name ?? ''} (${printer.kind})` : t('settings.noPrinter')}</span></div>
          <div className="tender-row">
            {kinds.length === 0 && <span className="muted">{t('settings.noPrinterSupport')}</span>}
            {kinds.map((k) => <Button key={k} onClick={() => void connect(k as PrinterSettings['kind'])}>{t(`settings.connect.${k}`)}</Button>)}
          </div>
          <div className="chips" role="group" aria-label={t('settings.paperWidth')}>
            {([58, 80] as const).map((w) => <button type="button" key={w} className="chip" aria-pressed={printer.widthMm === w} onClick={() => void updatePrinter({ widthMm: w })}>{w} mm</button>)}
          </div>
          <div className="chips" role="group" aria-label={t('settings.receiptLanguage')}>
            {(['en', 'hi', 'en+hi'] as const).map((l) => <button type="button" key={l} className="chip" aria-pressed={printer.lang === l} onClick={() => void updatePrinter({ lang: l })}>{t(`settings.receiptLang.${l}`)}</button>)}
          </div>
          <label className="row"><input type="checkbox" style={{ width: 24, height: 24 }} checked={printer.autoPrint} onChange={(e) => void updatePrinter({ autoPrint: e.target.checked })} />{t('settings.autoPrint')}</label>
        </section>

        <section className="field">
          <span className="label">{t('settings.sync')}</span>
          <SyncStatusBadge />
        </section>
      </div>
    </Screen>
  )
}
