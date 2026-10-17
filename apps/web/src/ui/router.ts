import { useSyncExternalStore } from 'react'

/** Hash router: no dependency, works from the installed PWA and offline. Routes look like #/bill or #/receipt/<id>. */
export interface Route {
  path: string
  segments: string[]
  query: URLSearchParams
}

function parse(hash: string): Route {
  const raw = hash.replace(/^#/, '') || '/'
  const [path, search = ''] = raw.split('?')
  return { path, segments: path.split('/').filter(Boolean), query: new URLSearchParams(search) }
}

let current = parse(typeof window === 'undefined' ? '' : window.location.hash)
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  if (listeners.size === 0) window.addEventListener('hashchange', onHashChange)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) window.removeEventListener('hashchange', onHashChange)
  }
}

function onHashChange() {
  current = parse(window.location.hash)
  listeners.forEach((l) => l())
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, () => {
    // re-read when the hash changed without a listener (first render)
    if (current.path !== parse(window.location.hash).path) current = parse(window.location.hash)
    return current
  })
}

export function navigate(path: string): void {
  window.location.hash = path
}

/** Back goes to the previous screen in this session, or Home when there is none (deep link, fresh launch). */
export function goBack(fallback = '/'): void {
  if (window.history.length > 1) window.history.back()
  else navigate(fallback)
}
