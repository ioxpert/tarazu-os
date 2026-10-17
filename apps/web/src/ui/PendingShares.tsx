import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useApp } from './app'
import { Banner, Button } from './components'

interface Row { id: string; phone: string; body: string }

/** Receipts queued for WhatsApp while offline. Opening WhatsApp needs a tap, so we ask once there is a connection. */
export function PendingShares() {
  const { t } = useTranslation()
  const app = useApp()
  const [rows, setRows] = useState<Row[]>([])
  const [online, setOnline] = useState(navigator.onLine)
  const load = useCallback(async () => {
    if (!app.db) return
    const { listPending } = await import('../print/share')
    setRows(await listPending(app.db))
  }, [app.db])
  useEffect(() => {
    void load()
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [load])
  if (rows.length === 0 || !app.db) return null
  const db = app.db
  const send = async () => {
    const { whatsappUrl, markSent } = await import('../print/share')
    const next = rows[0]
    window.open(whatsappUrl(next.phone, next.body), '_blank', 'noopener')
    await markSent(db, next.id)
    await load()
  }
  return (
    <div style={{ padding: '8px 16px' }}>
      <Banner kind="info">
        <div data-testid="pending-shares">{online ? t('receipt.pendingOnline', { count: rows.length }) : t('receipt.pendingOffline', { count: rows.length })}</div>
        {online && <Button onClick={() => void send()}>{t('receipt.sendNext')}</Button>}
      </Banner>
    </div>
  )
}
