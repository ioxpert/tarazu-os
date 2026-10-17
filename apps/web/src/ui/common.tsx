import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { verifyOwnerPinGuarded } from '../billing/approvals'
import { BillingError } from '../billing/errors'
import { istDate } from '../billing/numbering'
import { attachWedgeScanner } from '../catalogue/scanner'
import type { LocalDb } from '../sync/schemaDb'
import { Banner, Button, Keypad } from './components'

/** Wall clock behind a function so render code stays pure (handlers call it when something happens). */
export const nowMs = (): number => Date.now()

export const todayIst = (): string => istDate(nowMs())

/** Turns a thrown error into words. Library errors carry codes only (BillingError.code -> billing.error.<code>). */
export function errorText(t: TFunction, e: unknown): string {
  if (e instanceof BillingError) return t(`billing.error.${e.code}`, { defaultValue: t('billing.error.unknown') })
  return t('billing.error.unknown')
}

export function Modal({ title, onClose, children, testId }: { title: string; onClose: () => void; children: ReactNode; testId?: string }) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  return (
    <div className="modal-scrim" role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref} data-testid={testId}>
        <div className="row" style={{ border: 'none', padding: 0 }}>
          <h2 className="row-main">{title}</h2>
          <Button variant="ghost" icon="close" onClick={onClose} aria-label={t('common.close')} />
        </div>
        {children}
      </div>
    </div>
  )
}

/** The matrix from billing/qr.ts drawn as one SVG path (crisp at any size, no canvas). Adds the 4-module quiet zone. */
export function QrSvg({ matrix, size = 200, label }: { matrix: boolean[][]; size?: number; label: string }) {
  const n = matrix.length
  const quiet = 4
  let d = ''
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (matrix[y][x]) d += `M${x + quiet} ${y + quiet}h1v1h-1z`
  const dim = n + quiet * 2
  return (
    <svg role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${dim} ${dim}`} shapeRendering="crispEdges" style={{ background: '#fff' }}>
      <path d={d} fill="#000" />
    </svg>
  )
}

export interface ApprovalResult {
  approverUserId: string
  reason: string
}

/**
 * Owner PIN approval, checked on the device against the cached verifiers (works offline). Used for discounts above
 * policy, back-dated bills and returns. The reason is mandatory and ends up in the audit log on the server.
 */
export function ApprovalModal({
  db,
  title,
  onApproved,
  onCancel,
  defaultReason = '',
}: {
  db: LocalDb
  title: string
  onApproved: (a: ApprovalResult) => void
  onCancel: () => void
  defaultReason?: string
}) {
  const { t } = useTranslation()
  const [pin, setPin] = useState('')
  const [reason, setReason] = useState(defaultReason)
  const [problem, setProblem] = useState<'wrong_pin' | 'no_approvers_cached' | 'locked' | 'approvers_stale' | 'reason' | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (!reason.trim()) return setProblem('reason')
    setBusy(true)
    const r = await verifyOwnerPinGuarded(db, null, pin)
    setBusy(false)
    if (r.ok) onApproved({ approverUserId: r.approverUserId, reason: reason.trim() })
    else {
      setProblem(r.error)
      setPin('')
    }
  }

  return (
    <Modal title={title} onClose={onCancel} testId="approval-modal">
      <p className="muted">{t('approval.explain')}</p>
      <div className="field">
        <label htmlFor="appr-reason">{t('approval.reason')}</label>
        <input id="appr-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={problem === 'reason'} />
      </div>
      <div className="field">
        <span className="label" id="appr-pin-label">{t('approval.ownerPin')}</span>
        <div className="input num" aria-labelledby="appr-pin-label" data-testid="pin-display" style={{ letterSpacing: '0.5em' }}>
          {'•'.repeat(pin.length) || ' '}
        </div>
      </div>
      <Keypad value={pin} onChange={setPin} maxLength={8} ariaLabel={t('approval.ownerPin')} />
      {problem && (
        <Banner kind="error">
          {problem === 'wrong_pin' && t('approval.wrongPin')}
          {problem === 'no_approvers_cached' && t('approval.noApprovers')}
          {problem === 'locked' && t('approval.locked')}
          {problem === 'approvers_stale' && t('approval.stale')}
          {problem === 'reason' && t('approval.reasonNeeded')}
        </Banner>
      )}
      <Button variant="primary" onClick={() => void submit()} disabled={busy || pin.length < 4} data-testid="approval-confirm">
        {t('approval.approve')}
      </Button>
    </Modal>
  )
}

/** Keyboard-wedge barcode scanners type digits fast and end with Enter; this routes such a burst to `onScan`. */
export function useWedgeScanner(onScan: (code: string) => void) {
  const cb = useRef(onScan)
  useEffect(() => {
    cb.current = onScan
  })
  useEffect(() => attachWedgeScanner(window, (code) => cb.current(code)), [])
}

/** Records a latency for the browser perf tests (VITE_E2E builds only). */
export function perfNote(name: string, ms: number): void {
  if (import.meta.env.VITE_E2E !== 'true') return
  const w = window as unknown as { __timings?: Record<string, number[]> }
  ;(w.__timings ??= {})[name] = [...(w.__timings[name] ?? []), ms]
}

/** Starts a stopwatch; call the returned function to record the elapsed time under `name`. */
export function perfStart(name: string): () => void {
  const t0 = performance.now()
  return () => perfNote(name, performance.now() - t0)
}
