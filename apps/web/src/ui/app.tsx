import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { loadPolicy, DEFAULT_POLICY, type BillingPolicy } from '../billing/policy'
import { cacheApprovers } from '../billing/approvals'
import { defaultProfile, getState, loadProfile, saveProfile } from '../billing/settings'
import { loadTaxRules, type TaxRule } from '../billing/tax'
import type { MerchantProfile } from '../billing/types'
import { loadCatalogue, loadPopularity } from '../catalogue/repo'
import { CatalogueIndex } from '../catalogue/search'
import type { CatalogueItem } from '../catalogue/types'
import { hasSyncConfig, loadSyncConfig, type SyncConfig } from '../sync/config'
import type { SyncRuntime } from '../sync/runtime'
import type { LocalDb } from '../sync/schemaDb'

export type AppStatus = 'no_config' | 'starting' | 'ready' | 'error'

export interface AppValue {
  status: AppStatus
  error: string | null
  rt: SyncRuntime | null
  db: LocalDb | null
  config: SyncConfig | null
  profile: MerchantProfile
  policy: BillingPolicy
  rules: TaxRule[]
  items: CatalogueItem[]
  index: CatalogueIndex
  popularity: ReadonlyMap<string, number>
  /** True once a starter pack was seeded or any product exists: onboarding is not shown again. */
  hasCatalogue: boolean
  /** Reload everything the screens show. Cheap enough to call after a local write. */
  reload(): Promise<void>
  /** Reload only some products (after a sale: their stock moved) and patch the index. */
  reloadItems(ids: readonly string[]): Promise<void>
  setProfile(p: MerchantProfile): Promise<void>
  setPolicy(p: BillingPolicy): void
}

const Ctx = createContext<AppValue | null>(null)

export function useApp(): AppValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useApp outside AppProvider')
  return v
}

const EMPTY_INDEX = new CatalogueIndex()

/** Best-effort: take business details and owner PIN verifiers from the server whenever we happen to be online. */
async function refreshFromServer(rt: SyncRuntime, onProfile: (p: MerchantProfile) => void): Promise<void> {
  if (!navigator.onLine) return
  const { apiBase, deviceToken } = rt.config
  const headers = { Authorization: `Bearer ${deviceToken}` }
  const timeout = () => AbortSignal.timeout(4000)
  try {
    const res = await fetch(`${apiBase}/v1/identity/me`, { headers, signal: timeout() })
    if (res.ok) {
      const me = (await res.json()) as { storeName?: string | null; business?: { name: string; gstMode: MerchantProfile['gstMode']; gstin?: string | null; stateCode?: string | null; upiVpa?: string | null } | null }
      if (me.business) {
        const current = await loadProfile(rt.db as unknown as LocalDb)
        const next: MerchantProfile = {
          ...current,
          businessName: me.business.name,
          gstMode: me.business.gstMode,
          gstin: me.business.gstin ?? null,
          stateCode: me.business.stateCode ?? null,
          // a UPI ID the owner typed on this counter is kept until the server has one
          upiVpa: me.business.upiVpa ?? current.upiVpa,
          storeName: me.storeName ?? current.storeName,
        }
        await saveProfile(rt.db as unknown as LocalDb, next)
        onProfile(next)
      }
    }
  } catch {
    // offline or server down: billing carries on with what the device has
  }
  try {
    const res = await fetch(`${apiBase}/v1/identity/approvers`, { headers, signal: timeout() })
    if (res.ok) await cacheApprovers(rt.db as unknown as LocalDb, await res.json())
  } catch {
    // same
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AppStatus>(hasSyncConfig() ? 'starting' : 'no_config')
  const [error, setError] = useState<string | null>(null)
  const [rt, setRt] = useState<SyncRuntime | null>(null)
  const [profile, setProfileState] = useState<MerchantProfile>(defaultProfile())
  const [policy, setPolicyState] = useState<BillingPolicy>(DEFAULT_POLICY)
  const [rules, setRules] = useState<TaxRule[]>([])
  const [items, setItems] = useState<CatalogueItem[]>([])
  const [popularity, setPopularity] = useState<ReadonlyMap<string, number>>(new Map())
  const [hasCatalogue, setHasCatalogue] = useState(false)
  const [index, setIndex] = useState<CatalogueIndex>(EMPTY_INDEX)
  const indexRef = useRef<CatalogueIndex>(EMPTY_INDEX)
  const [indexVersion, setIndexVersion] = useState(0)

  const db = rt ? (rt.db as unknown as LocalDb) : null
  const config = rt ? rt.config : loadSyncConfig()

  const reload = useCallback(async () => {
    if (!rt) return
    const d = rt.db as unknown as LocalDb
    const [loaded, taxRules, pol, prof, pop, pack] = await Promise.all([
      loadCatalogue(d, { storeId: rt.config.storeId }),
      loadTaxRules(d),
      loadPolicy(d),
      loadProfile(d),
      loadPopularity(d).catch(() => new Map<string, number>()),
      getState(d, 'starter_pack'),
    ])
    const index = new CatalogueIndex(loaded)
    index.setPopularity(pop)
    indexRef.current = index
    setIndex(index)
    setItems(loaded)
    setRules(taxRules)
    setPolicyState(pol)
    setProfileState(prof)
    setPopularity(pop)
    setHasCatalogue(loaded.length > 0 || pack !== null)
    setIndexVersion((v) => v + 1)
  }, [rt])

  const reloadItems = useCallback(
    async (ids: readonly string[]) => {
      if (!rt || ids.length === 0) return
      const d = rt.db as unknown as LocalDb
      const fresh = await loadCatalogue(d, { storeId: rt.config.storeId, ids })
      const byId = new Map(fresh.map((i) => [i.id, i]))
      for (const id of ids) {
        const f = byId.get(id)
        if (f) indexRef.current.upsert(f)
      }
      setItems((prev) => {
        const seen = new Set<string>()
        const next = prev.map((i) => {
          const f = byId.get(i.id)
          if (f) seen.add(i.id)
          return f ?? i
        })
        for (const f of fresh) if (!seen.has(f.id)) next.push(f)
        return next
      })
      setIndexVersion((v) => v + 1)
    },
    [rt],
  )

  useEffect(() => {
    if (!hasSyncConfig()) return
    let live = true
    import('../sync/runtime')
      .then((m) => m.getSyncRuntime())
      .then((runtime) => {
        if (!live) return
        setRt(runtime)
      })
      .catch((e: unknown) => {
        if (!live) return
        setError(e instanceof Error ? e.message : String(e))
        setStatus('error')
      })
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    if (!rt) return
    if (import.meta.env.VITE_E2E === 'true') {
      // Browser tests (e2e/) read the local database and seed approvers through this; absent from normal builds.
      ;(window as unknown as { __tarazu: unknown }).__tarazu = { db: rt.db, writer: rt.writer, config: rt.config, search: (q: string) => indexRef.current.search(q, { limit: 24 }).map((i) => i.name) }
    }
    let live = true
    void reload()
      .then(() => live && setStatus('ready'))
      .catch((e: unknown) => {
        if (!live) return
        setError(e instanceof Error ? e.message : String(e))
        setStatus('error')
      })
    void refreshFromServer(rt, (p) => live && setProfileState(p))
    const onOnline = () => void refreshFromServer(rt, (p) => live && setProfileState(p))
    window.addEventListener('online', onOnline)
    // products, prices and stock arriving from other devices
    const dispose = rt.db.onChange(
      { onChange: () => void reload() },
      { tables: ['product', 'price_version'], throttleMs: 2000 },
    )
    return () => {
      live = false
      window.removeEventListener('online', onOnline)
      dispose?.()
    }
  }, [rt, reload])

  const setProfile = useCallback(
    async (p: MerchantProfile) => {
      if (!db) return
      await saveProfile(db, p)
      setProfileState(p)
    },
    [db],
  )

  const value = useMemo<AppValue>(
    () => ({
      status,
      error,
      rt,
      db,
      config,
      profile,
      policy,
      rules,
      items,
      index,
      popularity,
      hasCatalogue,
      reload,
      reloadItems,
      setProfile,
      setPolicy: setPolicyState,
    }),
    // indexVersion makes consumers re-read the (mutable) index after an upsert
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [index, status, error, rt, db, config, profile, policy, rules, items, popularity, hasCatalogue, reload, reloadItems, setProfile, indexVersion],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
