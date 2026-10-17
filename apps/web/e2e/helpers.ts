import { expect, type BrowserContext, type Page } from '@playwright/test'

export const DEVICE = {
  apiBase: '/api',
  deviceToken: 'tzd.11111111-1111-4111-8111-111111111111.a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d.e2e',
  deviceId: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
  storeId: '22222222-2222-4222-8222-222222222222',
  tenantId: '11111111-1111-4111-8111-111111111111',
}

type Tarazu = { db: { getAll: (s: string, p?: unknown[]) => Promise<Record<string, unknown>[]>; execute: (s: string, p?: unknown[]) => Promise<unknown> } }

/** A linked device on a fresh browser profile (own OPFS database). No backend exists: sync fails quietly, as when offline. */
export async function linkDevice(page: Page) {
  await page.addInitScript((c) => {
    if (!localStorage.getItem('tarazu.sync.config')) localStorage.setItem('tarazu.sync.config', JSON.stringify(c))
  }, DEVICE)
  await page.goto('/')
}

export async function pickPack(page: Page, type: 'grocery' | 'general' = 'grocery') {
  await page.getByTestId(`pack-${type}`).click()
  await expect(page.getByTestId('home-screen')).toBeVisible({ timeout: 30_000 })
}

export async function readyHome(page: Page) {
  await linkDevice(page)
  await expect(page.getByTestId('onboarding-screen')).toBeVisible({ timeout: 30_000 })
  await pickPack(page)
}

/** Service worker active, so the next reload works with no network. */
export async function waitForOfflineReady(page: Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready
  })
}

export const goOffline = (context: BrowserContext) => context.setOffline(true)

export function sql<T = Record<string, unknown>>(page: Page, query: string, params: unknown[] = []): Promise<T[]> {
  return page.evaluate(([q, p]) => (window as unknown as { __tarazu: Tarazu }).__tarazu.db.getAll(q as string, p as unknown[]), [query, params] as const) as Promise<T[]>
}

export function exec(page: Page, query: string, params: unknown[] = []) {
  return page.evaluate(([q, p]) => (window as unknown as { __tarazu: Tarazu }).__tarazu.db.execute(q as string, p as unknown[]), [query, params] as const)
}

export interface QueuedOp {
  entity_type: string
  op_type: string
  local_seq: number
  payload: Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** op_log is insert-only in PowerSync, so unsent operations are read from its upload queue (ps_crud), oldest first. */
export async function queuedOps(page: Page): Promise<QueuedOp[]> {
  const rows = await sql<{ data: string }>(page, 'SELECT data FROM ps_crud ORDER BY id')
  return rows
    .map((r) => JSON.parse(r.data) as { type: string; data?: Record<string, unknown> })
    .filter((c) => c.type === 'op_log')
    .map((c) => ({
      entity_type: c.data!.entity_type as string,
      op_type: c.data!.op_type as string,
      local_seq: c.data!.local_seq as number,
      payload: JSON.parse(c.data!.payload as string),
    }))
    .sort((x, y) => x.local_seq - y.local_seq)
}

/** Queued operations by entity type, in the order the server will receive them. */
export async function opTypes(page: Page): Promise<string[]> {
  return (await queuedOps(page)).map((o) => o.entity_type)
}

/** Gives the device an owner PIN verifier (what GET /v1/identity/approvers caches) so approvals work offline. */
export async function cacheOwnerPin(page: Page, pin = '1234') {
  await page.evaluate(async (p) => {
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(p), 'PBKDF2', false, ['deriveBits'])
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 1000 }, key, 256)
    const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u))
    const t = (window as unknown as { __tarazu: Tarazu }).__tarazu
    await t.db.execute('INSERT OR REPLACE INTO approver (id, display_name, pin_salt, pin_hash, iterations, fetched_at) VALUES (?, ?, ?, ?, ?, ?)', [
      '99999999-9999-4999-8999-999999999999', 'Owner', b64(salt), b64(new Uint8Array(bits)), 1000, new Date().toISOString(),
    ])
  }, pin)
}

export async function setProfile(page: Page, patch: Record<string, unknown>) {
  await page.evaluate(async (p) => {
    const t = (window as unknown as { __tarazu: Tarazu }).__tarazu
    const rows = await t.db.getAll("SELECT value FROM device_state WHERE id = 'profile'")
    const cur = rows[0] ? JSON.parse(rows[0].value as string) : {}
    await t.db.execute("INSERT OR REPLACE INTO device_state (id, value) VALUES ('profile', ?)", [JSON.stringify({ businessName: 'Test Kirana', gstMode: 'non_gst', gstin: null, stateCode: null, upiVpa: null, address: null, phone: null, storeName: null, rounding: 'nearest_rupee', ...cur, ...p })])
  }, patch)
}

export async function typeKeypad(page: Page, digits: string) {
  // a dialog's keypad wins over the one behind it
  const scope = (await page.locator('.modal').count()) > 0 ? '.modal .keypad' : '.keypad'
  for (const ch of digits) await page.locator(`${scope} [data-key="${ch}"]`).click()
}

export async function timings(page: Page, name: string): Promise<number[]> {
  return page.evaluate((n) => (window as unknown as { __timings?: Record<string, number[]> }).__timings?.[n] ?? [], name)
}

/** Search Parle-G, tap the first card, Pay, Done in cash: the three-tap bill. Returns after the receipt shows. */
export async function sellFirstResult(page: Page, query = 'parle g') {
  await page.goto('/#/bill')
  await page.getByTestId('item-search').fill(query)
  await page.getByTestId('item-card').first().click()
  await page.getByTestId('pay').click()
  await page.getByTestId('complete-sale').click()
  await expect(page.getByTestId('sale-saved')).toBeVisible()
}
