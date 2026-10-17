import { barcodeKey, normalizeBarcode } from './barcode'
import type { CatalogueItem } from './types'
import { phoneticTokens } from './translit'

export interface SearchOptions {
  limit?: number
  categoryId?: string | null
  /** Units sold per product id (recent or lifetime); a mild ranking boost. Overrides the index-wide map for this call. */
  popularity?: ReadonlyMap<string, number> | Readonly<Record<string, number>>
  /** Include items with active=false (default false). */
  includeInactive?: boolean
}

export interface SearchHit {
  item: CatalogueItem
  score: number
  via: 'barcode' | 'text' | 'popular'
}

interface Doc {
  item: CatalogueItem
  seq: number
  /** Ordered phonetic keys of the English name (for "query is the start of the name" ranking). */
  nameKeys: string[]
  /** Every distinct key of every searchable field. */
  keys: string[]
}

const Q_EXACT = 1
const Q_PREFIX = 0.85
const Q_FUZZY = 0.6
const MAX_DEL_LEN = 14

function itemKeys(item: CatalogueItem): { keys: string[]; nameKeys: string[] } {
  const nameKeys = phoneticTokens(item.name)
  const set = new Set<string>(nameKeys)
  for (const text of [item.localName, item.brand, item.category, item.sku, item.barcode]) {
    if (text) for (const k of phoneticTokens(text)) set.add(k)
  }
  return { keys: [...set], nameKeys }
}

function deletions(key: string): string[] {
  const k = key.length > MAX_DEL_LEN ? key.slice(0, MAX_DEL_LEN) : key
  const out: string[] = []
  for (let i = 0; i < k.length; i++) out.push(k.slice(0, i) + k.slice(i + 1))
  return out
}

/** True when a and b differ by at most one insertion, deletion, substitution or adjacent transposition. */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true
  const la = a.length
  const lb = b.length
  if (Math.abs(la - lb) > 1) return false
  let i = 0
  while (i < la && i < lb && a[i] === b[i]) i++
  if (la === lb) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true
    return i + 1 < la && a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2)
  }
  return la > lb ? a.slice(i + 1) === b.slice(i) : b.slice(i + 1) === a.slice(i)
}

function lowerBound(arr: string[], x: string): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid] < x) lo = mid + 1
    else hi = mid
  }
  return lo
}

function popOf(map: SearchOptions['popularity'], id: string): number {
  if (!map) return 0
  return map instanceof Map ? (map.get(id) ?? 0) : ((map as Record<string, number>)[id] ?? 0)
}

/**
 * In-memory catalogue search. Matching is on phonetic keys (translit.ts) so Hindi and spelling variants meet:
 * every query token must match; a token matches by exact key, by key prefix, or (tokens >= 4 chars with no
 * exact/prefix hit) by a key one edit away (symmetric-delete neighbourhood, verified). Exact barcode/SKU wins.
 */
export class CatalogueIndex {
  private docs = new Map<string, Doc>()
  private postings = new Map<string, Set<string>>()
  private delIndex = new Map<string, Set<string>>()
  private barcodes = new Map<string, Set<string>>()
  private skus = new Map<string, Set<string>>()
  private sorted: string[] | null = []
  private seq = 0
  private popularity: SearchOptions['popularity']

  constructor(items: Iterable<CatalogueItem> = []) {
    for (const it of items) this.upsert(it)
  }

  get size(): number {
    return this.docs.size
  }

  get(id: string): CatalogueItem | undefined {
    return this.docs.get(id)?.item
  }

  items(): CatalogueItem[] {
    return [...this.docs.values()].sort((a, b) => a.seq - b.seq).map((d) => d.item)
  }

  setPopularity(map: SearchOptions['popularity']): void {
    this.popularity = map
  }

  /** Exact barcode lookup (UPC-A and EAN-13 spellings match). */
  byBarcode(code: string): CatalogueItem[] {
    const ids = this.barcodes.get(barcodeKey(code))
    return ids ? [...ids].map((id) => this.docs.get(id)!.item).sort((a, b) => this.docs.get(a.id)!.seq - this.docs.get(b.id)!.seq) : []
  }

  upsert(item: CatalogueItem): void {
    const prev = this.docs.get(item.id)
    const { keys, nameKeys } = itemKeys(item)
    if (prev && prev.keys.length === keys.length && prev.keys.every((k, i) => k === keys[i]) && prev.item.barcode === item.barcode && prev.item.sku === item.sku) {
      prev.item = item // stock / price / pin changes: the keys did not move
      prev.nameKeys = nameKeys
      return
    }
    const seq = prev ? prev.seq : this.seq++
    if (prev) this.remove(item.id)
    this.docs.set(item.id, { item, seq, nameKeys, keys })
    for (const k of keys) this.addPosting(k, item.id)
    this.addAux(this.barcodes, item.barcode ? barcodeKey(item.barcode) : null, item.id)
    this.addAux(this.skus, item.sku ? item.sku.trim().toLowerCase() : null, item.id)
  }

  remove(id: string): void {
    const doc = this.docs.get(id)
    if (!doc) return
    this.docs.delete(id)
    for (const k of doc.keys) {
      const set = this.postings.get(k)
      if (!set) continue
      set.delete(id)
      if (set.size === 0) {
        this.postings.delete(k)
        this.sorted = null
        if (k.length >= 4) for (const v of [k, ...deletions(k)]) this.dropFrom(this.delIndex, v, k)
      }
    }
    this.dropFrom(this.barcodes, doc.item.barcode ? barcodeKey(doc.item.barcode) : null, id)
    this.dropFrom(this.skus, doc.item.sku ? doc.item.sku.trim().toLowerCase() : null, id)
  }

  clear(): void {
    this.docs.clear()
    this.postings.clear()
    this.delIndex.clear()
    this.barcodes.clear()
    this.skus.clear()
    this.sorted = []
  }

  search(query: string, opts: SearchOptions = {}): CatalogueItem[] {
    return this.hits(query, opts).map((h) => h.item)
  }

  hits(query: string, opts: SearchOptions = {}): SearchHit[] {
    const limit = opts.limit ?? 30
    const pop = opts.popularity ?? this.popularity
    const visible = (d: Doc) => (opts.includeInactive || d.item.active) && (!opts.categoryId || d.item.category === opts.categoryId)
    const q = query.trim()
    const out: SearchHit[] = []

    if (!q) return this.popular(limit, visible, pop)

    // 1. exact barcode / sku
    const code = normalizeBarcode(q)
    const seen = new Set<string>()
    if (/^\d{4,14}$/.test(code) || /^[A-Za-z0-9-]{3,}$/.test(q)) {
      const ids = new Set<string>([...(this.barcodes.get(barcodeKey(code)) ?? []), ...(this.skus.get(q.toLowerCase()) ?? [])])
      const exact = [...ids].map((id) => this.docs.get(id)!).filter(visible).sort((a, b) => a.seq - b.seq)
      for (const d of exact) {
        out.push({ item: d.item, score: 1000, via: 'barcode' })
        seen.add(d.item.id)
      }
    }

    // 2. phonetic tokens
    const tokens = phoneticTokens(q)
    if (tokens.length > 0) {
      const per: Array<Map<string, number>> = tokens.map((t, i) => this.matchToken(t, i === tokens.length - 1))
      if (per.every((m) => m.size > 0)) {
        per.sort((a, b) => a.size - b.size)
        const scored: Array<{ d: Doc; score: number }> = []
        for (const [id, q0] of per[0]) {
          let sum = q0
          let ok = true
          for (let i = 1; i < per.length; i++) {
            const qi = per[i].get(id)
            if (qi === undefined) {
              ok = false
              break
            }
            sum += qi
          }
          if (!ok || seen.has(id)) continue
          const d = this.docs.get(id)!
          if (!visible(d)) continue
          scored.push({ d, score: this.score(d, tokens, sum / tokens.length, pop) })
        }
        scored.sort((a, b) => b.score - a.score || a.d.seq - b.d.seq)
        for (const s of scored) {
          out.push({ item: s.d.item, score: s.score, via: 'text' })
          if (out.length >= limit) break
        }
      }
    }
    return out.slice(0, limit)
  }

  /**
   * Loose candidates for duplicate checks: items sharing at least half of the query's phonetic tokens (OR semantics,
   * exact/prefix/fuzzy per token), most shared tokens first. Inactive items are skipped.
   */
  similarTo(text: string, limit = 60): CatalogueItem[] {
    const tokens = [...new Set(phoneticTokens(text))]
    if (tokens.length === 0) return []
    const counts = new Map<string, number>()
    for (const t of tokens) for (const id of this.matchToken(t, false).keys()) counts.set(id, (counts.get(id) ?? 0) + 1)
    const need = Math.max(1, Math.ceil(tokens.length / 2))
    return [...counts]
      .filter(([id, c]) => c >= need && this.docs.get(id)!.item.active)
      .sort((a, b) => b[1] - a[1] || this.docs.get(a[0])!.seq - this.docs.get(b[0])!.seq)
      .slice(0, limit)
      .map(([id]) => this.docs.get(id)!.item)
  }

  // ---- internals ----

  private score(d: Doc, tokens: string[], avgQuality: number, pop: SearchOptions['popularity']): number {
    let s = avgQuality * 10
    const nk = d.nameKeys
    if (tokens.length <= nk.length && tokens.every((t, i) => nk[i].startsWith(t))) {
      s += 3 // the query is the start of the name
      if (tokens.length === nk.length && tokens.every((t, i) => nk[i] === t)) s += 2
    }
    if (d.item.pinned) s += 2
    const p = popOf(pop, d.item.id)
    if (p > 0) s += Math.min(3, Math.log2(1 + p) * 0.4)
    return s - 0.02 * nk.length
  }

  private popular(limit: number, visible: (d: Doc) => boolean, pop: SearchOptions['popularity']): SearchHit[] {
    const list: Array<{ d: Doc; score: number }> = []
    for (const d of this.docs.values()) {
      if (!visible(d)) continue
      const p = popOf(pop, d.item.id)
      const score = (d.item.pinned ? 1_000_000 : 0) + p
      if (score > 0) list.push({ d, score })
    }
    list.sort((a, b) => b.score - a.score || a.d.seq - b.d.seq)
    return list.slice(0, limit).map((x) => ({ item: x.d.item, score: x.score, via: 'popular' as const }))
  }

  private matchToken(t: string, isLast: boolean): Map<string, number> {
    const res = new Map<string, number>()
    const add = (ids: Set<string>, quality: number) => {
      for (const id of ids) if ((res.get(id) ?? 0) < quality) res.set(id, quality)
    }
    const exact = this.postings.get(t)
    if (exact) add(exact, Q_EXACT)
    const numeric = /^\d+$/.test(t)
    if (!numeric || isLast) {
      const keys = this.sortedKeys()
      for (let i = lowerBound(keys, t); i < keys.length && keys[i].startsWith(t); i++) {
        if (keys[i] !== t) add(this.postings.get(keys[i])!, Q_PREFIX)
      }
    }
    if (res.size === 0 && !numeric && t.length >= 4) {
      const cand = new Set<string>()
      for (const v of [t, ...deletions(t)]) {
        const ks = this.delIndex.get(v)
        if (ks) for (const k of ks) cand.add(k)
      }
      for (const k of cand) if (withinOneEdit(t, k)) add(this.postings.get(k)!, Q_FUZZY)
    }
    return res
  }

  private sortedKeys(): string[] {
    if (!this.sorted) this.sorted = [...this.postings.keys()].sort()
    return this.sorted
  }

  private addPosting(key: string, id: string): void {
    let set = this.postings.get(key)
    if (!set) {
      set = new Set()
      this.postings.set(key, set)
      this.sorted = null
      if (key.length >= 4) for (const v of [key, ...deletions(key)]) this.addAux(this.delIndex, v, key)
    }
    set.add(id)
  }

  private addAux(map: Map<string, Set<string>>, key: string | null, value: string): void {
    if (!key) return
    let set = map.get(key)
    if (!set) map.set(key, (set = new Set()))
    set.add(value)
  }

  private dropFrom(map: Map<string, Set<string>>, key: string | null, value: string): void {
    if (!key) return
    const set = map.get(key)
    if (!set) return
    set.delete(value)
    if (set.size === 0) map.delete(key)
  }
}
