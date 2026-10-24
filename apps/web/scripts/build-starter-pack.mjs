#!/usr/bin/env node
// Generates apps/web/src/catalogue/starterPack/{grocery,general}.json from scripts/starter-pack-data.mjs.
// Deterministic (no clock, no randomness): same table in, same bytes out. Run: `npm run build:starter-pack`.
//
// packSku is assigned by position ('GRO-0001'...). The table is APPEND-ONLY: inserting a row in the middle renumbers
// every later SKU, and product ids on devices are derived from (storeType, packSku). Add new rows at the END of a
// section group only if you accept renumbering within it, or better, at the end of the file.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { CATEGORY_DEFAULTS, GENERAL_LOOSE_PICKS, GENERAL_PICKS, GROCERY, GROCERY_PACKS_PER_PRODUCT } from './starter-pack-data.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '..', 'src', 'catalogue', 'starterPack')
const PACK_VERSION = '2026.10.2'
const UNITS = new Set(['piece', 'packet', 'strip', 'bottle', 'dozen', 'kg', 'g', 'litre', 'ml', 'bag', 'box', 'case', 'carton', 'bundle', 'quintal'])
const CATEGORIES = new Set(Object.keys(CATEGORY_DEFAULTS))
const NOTE =
  'INDICATIVE starter data. mrpPaise is an approximate printed MRP (packaged goods) or an approximate shop rate per kg/litre ' +
  '(loose goods); indicativeTaxRateBp is an approximate GST rate. Both are typed from general knowledge, are not a price feed or ' +
  'tax advice, and must be reviewed by the merchant. Billing uses the synced server tax rule for the HSN first and falls back to ' +
  'this rate only when no rule resolves. Barcodes are deliberately null: none are invented; scanning attaches the real one.'

const fail = (m) => {
  throw new Error(`starter pack: ${m}`)
}

/** '12.5' rupees -> 1250 paise with no float arithmetic. */
function paise(rupees) {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(rupees))
  if (!m) fail(`bad price ${rupees}`)
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'))
}

const UNIT_LABEL = { g: 'g', kg: 'kg', ml: 'ml', l: 'L' }
const HI_UNIT = { g: 'ग्राम', kg: 'किलो', ml: 'मिली', l: 'लीटर', pc: 'पीस' }

function parsePack(token) {
  const m = /^(?:(\d+)x)?(\d+(?:\.\d+)?)(g|kg|ml|l|pc)$/.exec(token)
  if (!m) fail(`bad pack token '${token}'`)
  const [, mult, qty, unit] = m
  return { mult: mult ? Number(mult) : 1, qty, unit, token }
}

function packLabels({ mult, qty, unit }) {
  const u = unit === 'pc' ? (qty === '1' && mult === 1 ? 'pc' : 'pcs') : UNIT_LABEL[unit]
  const en = `${mult > 1 ? mult + ' x ' : ''}${qty} ${u}`
  const hi = `${mult > 1 ? mult + ' x ' : ''}${qty} ${HI_UNIT[unit]}`
  return { en, hi }
}

function sizeInKg(p) {
  return p.unit === 'kg' ? Number(p.qty) * p.mult : 0
}

function parseRow(row) {
  const [category, brand, name, hi, packs, opts = {}] = row
  const defaults = CATEGORY_DEFAULTS[category] ?? fail(`unknown category ${category} (${name})`)
  const list = packs
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => {
      const [tok, price] = t.split('=')
      return { ...parsePack(tok), price: paise(price) }
    })
  return { category, brand, name, hi, opts, defaults, list }
}

function chooseCapped(list, cap) {
  const n = list.length
  if (n <= cap) return list
  if (cap === 1) return [list[Math.floor((n - 1) / 2)]]
  return [list[0], list[Math.floor(n / 2)]]
}

function itemFor(row, p, isFirstKept) {
  const { category, brand, name, hi, opts, defaults } = row
  let unit = opts.unit ?? defaults.unit
  const isGrain = category === 'atta' || category === 'rice' || category === 'dal' || category === 'sugar-salt'
  if (isGrain && !opts.unit && sizeInKg(p) >= 5) unit = 'bag'
  if (p.unit === 'pc' && (p.mult > 1 || Number(p.qty) > 1) && unit === 'piece') unit = 'packet'
  const labels = packLabels(p)
  const units = []
  if (isFirstKept && opts.up) for (const [u, n] of opts.up) units.push({ unit: u, qtyMilli: n * 1000 })
  const sized = !opts.eggs
  return {
    name: sized ? `${name} ${labels.en}` : name,
    localName: sized ? `${hi} ${labels.hi}` : hi,
    brand,
    category,
    hsn: opts.hsn ?? defaults.hsn,
    unit,
    uom: { base: unit, units },
    mrpPaise: p.price,
    indicativeTaxRateBp: opts.tax ?? defaults.tax,
    taxInclusive: true,
    loose: false,
    barcode: null,
  }
}

function looseItem(l) {
  const sub = l.unit === 'kg' ? 'g' : 'ml'
  const defaults = CATEGORY_DEFAULTS[l.category] ?? fail(`unknown category ${l.category}`)
  return {
    name: l.name,
    localName: l.hi,
    brand: null,
    category: l.category,
    hsn: l.hsn ?? defaults.hsn,
    unit: l.unit,
    uom: { base: l.unit, units: [{ unit: sub, qtyMilli: 1 }] },
    mrpPaise: paise(l.rupees),
    indicativeTaxRateBp: l.tax,
    taxInclusive: true,
    loose: true,
    barcode: null,
  }
}

function validate(items, label) {
  const skus = new Set()
  const names = new Set()
  for (const it of items) {
    if (skus.has(it.packSku)) fail(`${label}: duplicate packSku ${it.packSku}`)
    skus.add(it.packSku)
    const key = it.name.toLowerCase()
    if (names.has(key)) fail(`${label}: duplicate name '${it.name}'`)
    names.add(key)
    if (!/^\d{4,8}$/.test(it.hsn)) fail(`${label}: ${it.packSku} bad hsn '${it.hsn}'`)
    if (!CATEGORIES.has(it.category)) fail(`${label}: ${it.packSku} bad category`)
    if (!UNITS.has(it.unit) || !UNITS.has(it.uom.base)) fail(`${label}: ${it.packSku} bad unit`)
    if (it.uom.units.length > 8) fail(`${label}: ${it.packSku} too many uom units`)
    for (const u of it.uom.units) if (!UNITS.has(u.unit) || !Number.isSafeInteger(u.qtyMilli) || u.qtyMilli < 1 || u.unit === it.uom.base) fail(`${label}: ${it.packSku} bad uom unit`)
    if (!Number.isSafeInteger(it.mrpPaise) || it.mrpPaise <= 0) fail(`${label}: ${it.packSku} bad price`)
    if (!Number.isInteger(it.indicativeTaxRateBp) || it.indicativeTaxRateBp < 0 || it.indicativeTaxRateBp > 10000) fail(`${label}: ${it.packSku} bad tax`)
    if (!/[ऀ-ॿ]/.test(it.localName)) fail(`${label}: ${it.packSku} localName has no Devanagari`)
    if (!it.name.trim() || it.name !== it.name.trim()) fail(`${label}: ${it.packSku} bad name`)
  }
}

function emit(storeType, prefix, items) {
  const withSku = items.map((it, i) => ({ packSku: `${prefix}-${String(i + 1).padStart(4, '0')}`, ...it }))
  validate(withSku, storeType)
  const lines = withSku.map((it) => '  ' + JSON.stringify(it))
  const text = `{"storeType":${JSON.stringify(storeType)},"version":${JSON.stringify(PACK_VERSION)},"note":${JSON.stringify(NOTE)},"items":[\n${lines.join(',\n')}\n]}\n`
  mkdirSync(OUT, { recursive: true })
  const file = join(OUT, `${storeType}.json`)
  writeFileSync(file, text)
  const gz = gzipSync(Buffer.from(text), { level: 9 }).length
  console.log(`${storeType}: ${withSku.length} items (${withSku.filter((i) => i.loose).length} loose), ${(text.length / 1024).toFixed(1)} KB raw, ${(gz / 1024).toFixed(1)} KB gzip -> ${file}`)
}

// ---- grocery
const rows = GROCERY.rows.map(parseRow)
const grocery = []
for (const row of rows) {
  const cap = GROCERY_PACKS_PER_PRODUCT[row.category] ?? 1
  const kept = row.opts.eggs ? row.list.slice(0, 1) : chooseCapped(row.list, cap)
  kept.forEach((p, i) => grocery.push(itemFor(row, p, i === 0)))
}
grocery.push(...GROCERY.loose.map(looseItem))
emit('grocery', 'GRO', grocery)

// ---- general (provision store): explicit picks from the full (uncapped) table
const byName = new Map(rows.map((r) => [r.name, r]))
const general = []
for (const pick of GENERAL_PICKS) {
  const i = pick.lastIndexOf(':')
  const name = pick.slice(0, i)
  const sizes = pick.slice(i + 1)
  const row = byName.get(name) ?? fail(`general pick '${name}' is not in the table`)
  const want = sizes === '*' ? null : new Set(sizes.split(','))
  const found = row.list.filter((p) => !want || want.has(p.token))
  if (want && found.length !== want.size) fail(`general pick '${pick}': sizes not all present (${row.list.map((p) => p.token).join(' ')})`)
  found.forEach((p, k) => general.push(itemFor(row, p, k === 0)))
}
const looseByName = new Map(GROCERY.loose.map((l) => [l.name, l]))
for (const n of GENERAL_LOOSE_PICKS) general.push(looseItem(looseByName.get(n) ?? fail(`general loose pick '${n}' missing`)))
emit('general', 'GEN', general)
