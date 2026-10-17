import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon, type IconName } from './icons'
import { goBack } from './router'

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost'

/** Every button is at least 48 x 48 dp (see .btn in index.css). One `primary` per screen. */
export function Button({
  variant = 'secondary',
  icon,
  children,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; icon?: IconName }) {
  return (
    <button type="button" {...rest} className={`btn btn-${variant} ${className}`.trim()}>
      {icon && <Icon name={icon} />}
      {children}
    </button>
  )
}

/** Warnings and errors always carry an icon and words, never colour alone. */
export function Banner({ kind, children, role }: { kind: 'warning' | 'error' | 'ok' | 'info'; children: ReactNode; role?: string }) {
  const icon: IconName = kind === 'ok' ? 'check' : 'warning'
  return (
    <div className={`banner banner-${kind}`} role={role ?? (kind === 'error' ? 'alert' : 'status')}>
      <Icon name={icon} />
      <div>{children}</div>
    </div>
  )
}

/** Persistent top bar: Back on the left, optional Undo on the right, one title. */
export function Header({ title, onUndo, undoDisabled, actions }: { title: string; onUndo?: () => void; undoDisabled?: boolean; actions?: ReactNode }) {
  const { t } = useTranslation()
  return (
    <header className="topbar">
      <Button variant="ghost" icon="back" onClick={() => goBack()} aria-label={t('common.back')}>
        <span className="topbar-label">{t('common.back')}</span>
      </Button>
      <h1 className="topbar-title">{title}</h1>
      <div className="topbar-actions">
        {actions}
        {onUndo && (
          <Button variant="ghost" icon="undo" onClick={onUndo} disabled={undoDisabled} aria-label={t('common.undo')}>
            <span className="topbar-label">{t('common.undo')}</span>
          </Button>
        )}
      </div>
    </header>
  )
}

export function Screen({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div className="screen" data-testid={testId}>
      {children}
    </div>
  )
}

/**
 * Large one-hand numeric keypad. Pure presentation: the parent owns the text value.
 * `decimal` adds a dot key (weights, rupees). Keys are 64 dp tall.
 */
export function Keypad({
  value,
  onChange,
  decimal = false,
  maxLength = 9,
  ariaLabel,
}: {
  value: string
  onChange: (next: string) => void
  decimal?: boolean
  maxLength?: number
  ariaLabel?: string
}) {
  const { t } = useTranslation()
  const press = (k: string) => {
    if (k === 'back') return onChange(value.slice(0, -1))
    if (k === '.') {
      if (!decimal || value.includes('.')) return
      return onChange(value === '' ? '0.' : value + '.')
    }
    if (k === '00') {
      if (value === '' || value === '0' || value.length + 2 > maxLength) return
      return onChange(value + '00')
    }
    if (value.length >= maxLength) return
    if (value === '0') return onChange(k)
    onChange(value + k)
  }
  const keys = ['7', '8', '9', '4', '5', '6', '1', '2', '3', decimal ? '.' : '00', '0', 'back']
  return (
    <div className="keypad" role="group" aria-label={ariaLabel ?? t('common.keypad')}>
      {keys.map((k) => (
        <button
          type="button"
          key={k}
          className="key"
          onClick={() => press(k)}
          aria-label={k === 'back' ? t('common.delete') : k === '.' ? t('common.point') : k}
          data-key={k}
        >
          {k === 'back' ? <Icon name="backspace" /> : k}
        </button>
      ))}
    </div>
  )
}

export function BigTile({ icon, label, onClick, testId }: { icon: IconName; label: string; onClick: () => void; testId?: string }) {
  return (
    <button type="button" className="bigtile" onClick={onClick} data-testid={testId}>
      <Icon name={icon} size={40} />
      <span>{label}</span>
    </button>
  )
}
