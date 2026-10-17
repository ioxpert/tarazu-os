import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatRupees } from '../lib/numfmt'
import { useApp } from './app'
import { Button } from './components'
import { Modal } from './common'
import { createParty, searchParties, type PartyRow } from './parties'

/** Pick a saved customer, or create one from just a name. Walk-in (nobody) is the default and one tap. */
export function CustomerPicker({ onPicked, onClose }: { onPicked: (c: { id: string; name: string } | null) => void; onClose: () => void }) {
  const { t } = useTranslation()
  const app = useApp()
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<PartyRow[]>([])
  useEffect(() => {
    if (app.db) void searchParties(app.db, q).then(setRows)
  }, [app.db, q])

  const create = async () => {
    if (!app.rt || !q.trim()) return
    const p = await createParty(app.rt.writer, { tenantId: app.rt.config.tenantId, actorUserId: app.rt.config.actorUserId }, q, null)
    onPicked({ id: p.id, name: p.name })
  }

  return (
    <Modal title={t('customer.title')} onClose={onClose} testId="customer-modal">
      <Button variant="primary" onClick={() => onPicked(null)} data-testid="walk-in">{t('bill.walkIn')}</Button>
      <input className="input" placeholder={t('customer.search')} aria-label={t('customer.search')} value={q} onChange={(e) => setQ(e.target.value)} data-testid="customer-search" />
      <ul className="list">
        {rows.map((r) => (
          <li key={r.id}>
            <button type="button" className="row" style={{ width: '100%' }} onClick={() => onPicked({ id: r.id, name: r.name })}>
              <span className="row-main"><span className="row-title">{r.name}</span></span>
              {r.balancePaise > 0 && <span className="badge badge-warn">{t('khata.owes', { amount: formatRupees(r.balancePaise) })}</span>}
            </button>
          </li>
        ))}
      </ul>
      {q.trim() && !rows.some((r) => r.name.toLowerCase() === q.trim().toLowerCase()) && (
        <Button onClick={() => void create()} icon="plus" data-testid="create-customer">{t('customer.create', { name: q.trim() })}</Button>
      )}
    </Modal>
  )
}
