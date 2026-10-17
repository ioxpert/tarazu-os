import type { Session } from './api'

/**
 * Signed-in session, persisted in localStorage.
 *
 * TODO(device-registration UI session): the session token is a bearer secret. localStorage is readable by any script
 * on the origin; move it to a protected store (non-extractable WebCrypto key / native secure store) later.
 */
const KEY = 'tarazu.auth.session'

export function saveSession(session: Session): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(session))
  } catch {
    /* storage unavailable: the user will simply sign in again */
  }
}

/** The stored session, or null when there is none, it is unreadable, or it has expired. */
export function loadSession(now: number = Date.now()): Session | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as Session
    if (!s.token || Date.parse(s.expiresAt) <= now) {
      clearSession()
      return null
    }
    return s
  } catch {
    return null
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* nothing to clear */
  }
}
