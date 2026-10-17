import { normalizeBarcode } from './barcode'
import { CatalogueIndex } from './search'
import { phoneticKey, phoneticString, phoneticTokens, rawTokens } from './translit'
import { parseQtyMilli } from './uom'
import type { CatalogueItem } from './types'

export interface DuplicateCandidate {
  name: string
  brand?: string | null
  barcode?: string | null
  /** '56 g', '1 L'... When omitted the size is read from the name. */
  size?: string | null
}

export type DuplicateCode = 'ok' | 'barcode_exists' | 'possible_duplicate'
export type DuplicateReason = 'same_name_brand_size' | 'same_name_size_unknown' | 'similar_name'

export interface DuplicateMatch {
  item: CatalogueItem
  /** 0..1 */
  score: number
  reason: DuplicateReason
}

export interface DuplicateResult {
  /**
   * The creation policy (never auto-merge, a human decides):
   * - barcode_exists: an ACTIVE item already has this barcode -> creation of a second one is blocked; open the existing item.
   * - possible_duplicate: an active item has the same phonetic name + brand + pack size -> the UI asks "same item?".
   * - ok: nothing blocks. `similar` may still hold weaker hints (same name, size unknown / near-identical name) to show.
   */
  code: DuplicateCode
  exactBarcode?: CatalogueItem
  similar: DuplicateMatch[]
}

const UNIT_RE = /(?:(\d+)\s*[x×]\s*)?(\d+(?:[.,]\d+)?)\s*(kgs?|kilograms?|kilos?|grams?|gms?|mg|g|litres?|liters?|ltrs?|ml|l|pcs?|pieces?|nos?|ct|count|tablets?)(?![a-z])/i

export interface ParsedSize {
  /** Canonical, comparable: 'g:56000' (milli-grams... milli of gram), 'ml:500000', 'pc:6000', with 'x3' for multipacks. */
  key: string
  matched: string
}

/** Devanagari digits and the unit words printed on Indian packs, rewritten as ascii so one regex reads both scripts. */
export function normalizeSizeText(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x966))
    .replace(/(\d)\s*(?:किलोग्राम|किलो|कि\.?ग्रा\.?)/g, '$1 kg')
    .replace(/(\d)\s*(?:ग्राम|ग्रा\.?)/g, '$1 g')
    .replace(/(\d)\s*(?:मिलीलीटर|मि\.?ली\.?|मिली)/g, '$1 ml')
    .replace(/(\d)\s*(?:लीटर|ली\.?)/g, '$1 l')
    .replace(/(\d)\s*(?:पीस|नग)/g, '$1 pc')
}

/** Pack size found in a name or size string, compared on canonical integers (kg = 1000 g), never floats. */
export function parseSize(text: string): ParsedSize | null {
  const m = UNIT_RE.exec(normalizeSizeText(text))
  if (!m) return null
  const mult = m[1] ? Number(m[1]) : 1
  const milli = parseQtyMilli(m[2])
  if (milli === null) return null
  const u = m[3].toLowerCase()
  let dim: string
  let v = milli
  if (u === 'mg') {
    dim = 'mg'
  } else if (/^(kg|kilo)/.test(u)) {
    dim = 'g'
    v = milli * 1000
  } else if (/^(g|gm|gram)/.test(u)) {
    dim = 'g'
  } else if (/^(l$|lit|ltr)/.test(u)) {
    dim = 'ml'
    v = milli * 1000
  } else if (u === 'ml') {
    dim = 'ml'
  } else {
    dim = 'pc'
  }
  return { key: `${dim}:${v}${mult > 1 ? 'x' + mult : ''}`, matched: m[0] }
}

const STOP = new Set(['pack', 'packet', 'pkt', 'pouch', 'bottle', 'of', 'and', 'new', 'the', 'with'])

function coreTokens(name: string, brandTokens: Set<string>): Set<string> {
  const norm = normalizeSizeText(name)
  const size = parseSize(norm)
  const text = size ? norm.replace(size.matched, ' ') : norm
  const out = new Set<string>()
  for (const raw of rawTokens(text)) {
    // model codes such as AA / AAA must stay apart: phonetic folding would collapse repeated letters
    let t = /^([a-z])\1+$/.test(raw) && raw.length <= 4 ? raw : phoneticKey(raw === 'g' ? 'ji' : raw)
    if (!t || brandTokens.has(t) || STOP.has(t)) continue
    if (t.length > 3 && t.endsWith('s')) t = t.slice(0, -1)
    out.add(t)
  }
  return out
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

export interface FindDuplicatesOptions {
  /** Ignore this item (when editing an existing one). */
  excludeId?: string
  maxSimilar?: number
}

export function findDuplicates(
  source: CatalogueIndex | readonly CatalogueItem[],
  candidate: DuplicateCandidate,
  opts: FindDuplicatesOptions = {},
): DuplicateResult {
  const index = source instanceof CatalogueIndex ? source : new CatalogueIndex(source)
  const live = (i: CatalogueItem) => i.active && i.id !== opts.excludeId

  const code = candidate.barcode ? normalizeBarcode(candidate.barcode) : ''
  let exactBarcode: CatalogueItem | undefined
  if (code && /^\d{4,14}$/.test(code)) exactBarcode = index.byBarcode(code).find(live)

  const brandStr = candidate.brand ? phoneticString(candidate.brand) : ''
  const candSize = parseSize(candidate.size ?? '') ?? parseSize(candidate.name)
  const similar: DuplicateMatch[] = []
  let strong = false

  for (const item of index.similarTo(`${candidate.brand ?? ''} ${candidate.name}`)) {
    if (!live(item) || item === exactBarcode) continue
    const itemBrand = item.brand ? phoneticString(item.brand) : ''
    if (brandStr && itemBrand && brandStr !== itemBrand) continue // another maker's version is a different product
    const itemSize = parseSize(item.name)
    if (candSize && itemSize && candSize.key !== itemSize.key) continue // 56 g vs 100 g are different packs
    // both brands known and equal: compare what is left of the names; otherwise compare the full names, so a generic
    // 'Suji Rava' is not the same product as 'Aashirvaad Suji Rawa'
    const brandTokens = brandStr && itemBrand ? new Set([...phoneticTokens(candidate.brand ?? ''), ...phoneticTokens(item.brand ?? '')]) : new Set<string>()
    const a = coreTokens(candidate.name, brandTokens)
    const b = coreTokens(item.name, brandTokens)
    const j = jaccard(a, b)
    const sizeUnknownOneSide = !!candSize !== !!itemSize
    if (j === 1) {
      if (sizeUnknownOneSide) {
        similar.push({ item, score: 0.7, reason: 'same_name_size_unknown' })
      } else {
        const bothBrands = !!brandStr && !!itemBrand
        similar.push({ item, score: bothBrands ? 1 : 0.95, reason: 'same_name_brand_size' })
        strong = true
      }
    } else if (j >= 0.6 && !sizeUnknownOneSide) {
      similar.push({ item, score: Math.round(j * 90) / 100, reason: 'similar_name' })
    }
  }
  similar.sort((x, y) => y.score - x.score)
  return {
    code: exactBarcode ? 'barcode_exists' : strong ? 'possible_duplicate' : 'ok',
    ...(exactBarcode ? { exactBarcode } : {}),
    similar: similar.slice(0, opts.maxSimilar ?? 5),
  }
}
