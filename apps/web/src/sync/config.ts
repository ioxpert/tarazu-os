/**
 * Device sync configuration, persisted in localStorage.
 *
 * TODO(device-registration UI session): the device token is a bearer secret. localStorage is readable by any
 * script on the origin; move it to a more protected store (e.g. an OPFS/IndexedDB record wrapped with a
 * non-extractable WebCrypto key, or the Capacitor secure store in the native shells) when the registration flow
 * lands. Until then it is dev-harness grade.
 */
export interface SyncConfig {
  /** Same-origin prefix of the API, e.g. '/api' (Vite proxies it in dev). */
  apiBase: string
  /** `tzd.<tenantId>.<deviceId>.<secret>` issued once at device registration. */
  deviceToken: string
  deviceId: string
  storeId: string
  tenantId: string
  actorUserId?: string | null
}

const KEY = 'tarazu.sync.config'

export function loadSyncConfig(): SyncConfig | null {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as SyncConfig) : null
  } catch {
    return null
  }
}

export function saveSyncConfig(config: SyncConfig): void {
  localStorage.setItem(KEY, JSON.stringify(config))
}

export function clearSyncConfig(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // storage unavailable: nothing to clear
  }
}

export function hasSyncConfig(): boolean {
  return loadSyncConfig() !== null
}

/** Pulls tenant and device ids out of a device token without trusting anything else in it. */
export function parseDeviceToken(token: string): { tenantId: string; deviceId: string } | null {
  const m = /^tzd\.([0-9a-f-]{36})\.([0-9a-f-]{36})\.[A-Za-z0-9_-]+$/i.exec(token.trim())
  return m ? { tenantId: m[1], deviceId: m[2] } : null
}

/** Asks the server who this token belongs to (gives us the store id), validating the token on the way. */
export async function resolveConfig(apiBase: string, deviceToken: string, fetchImpl: typeof fetch = fetch): Promise<SyncConfig> {
  const ids = parseDeviceToken(deviceToken)
  if (!ids) throw new Error('Not a device token (expected tzd.<tenant>.<device>.<secret>)')
  const res = await fetchImpl(`${apiBase}/v1/identity/me`, { headers: { Authorization: `Bearer ${deviceToken.trim()}` } })
  if (!res.ok) throw new Error(`Server refused the token (${res.status})`)
  const me = (await res.json()) as { storeId?: string | null }
  if (!me.storeId) throw new Error('Token does not belong to a registered device')
  return { apiBase, deviceToken: deviceToken.trim(), deviceId: ids.deviceId, tenantId: ids.tenantId, storeId: me.storeId }
}
