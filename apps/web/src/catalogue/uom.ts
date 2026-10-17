import type { UomSpec, Unit } from './types'

/** The UomUnit enum of the contract. */
export const UNITS: readonly Unit[] = [
  'piece', 'packet', 'strip', 'bottle', 'dozen', 'kg', 'g', 'litre', 'ml', 'bag', 'box', 'case', 'carton', 'bundle',
]
export const MAX_UOM_UNITS = 8
/** Largest milli-quantity of one unit we accept (1e12 = a billion base units): far below 2^53 so products stay exact. */
export const MAX_UNIT_MILLI = 1_000_000_000_000

export type UomIssue =
  | 'bad_base'
  | 'too_many_units'
  | 'bad_unit'
  | 'duplicate_unit'
  | 'unit_equals_base'
  | 'bad_qty'

const UNIT_SET = new Set<string>(UNITS)
export function isUnit(v: unknown): v is Unit {
  return typeof v === 'string' && UNIT_SET.has(v)
}

/** Returns the list of problems with a spec (empty = valid). Mirrors the server's ProductHandler.uomJson checks. */
export function uomIssues(spec: unknown): UomIssue[] {
  const out: UomIssue[] = []
  if (typeof spec !== 'object' || spec === null) return ['bad_base']
  const s = spec as { base?: unknown; units?: unknown }
  if (!isUnit(s.base)) out.push('bad_base')
  if (!Array.isArray(s.units)) return [...out, 'too_many_units']
  if (s.units.length > MAX_UOM_UNITS) out.push('too_many_units')
  const seen = new Set<string>()
  for (const u of s.units as Array<{ unit?: unknown; qtyMilli?: unknown }>) {
    if (typeof u !== 'object' || u === null || !isUnit(u.unit)) {
      out.push('bad_unit')
      continue
    }
    if (u.unit === s.base) out.push('unit_equals_base')
    if (seen.has(u.unit)) out.push('duplicate_unit')
    seen.add(u.unit)
    if (!Number.isSafeInteger(u.qtyMilli) || (u.qtyMilli as number) < 1 || (u.qtyMilli as number) > MAX_UNIT_MILLI) out.push('bad_qty')
  }
  return out
}

export function isValidUom(spec: unknown): spec is UomSpec {
  return uomIssues(spec).length === 0
}

export function assertValidUom(spec: unknown): UomSpec {
  const issues = uomIssues(spec)
  if (issues.length) throw new UomError(issues[0])
  return spec as UomSpec
}

export class UomError extends Error {
  constructor(readonly code: UomIssue | 'unknown_unit' | 'bad_quantity' | 'overflow' | 'bad_chain') {
    super(code)
    this.name = 'UomError'
  }
}

/** Milli-base-units held by ONE `unit` (the base itself is 1000). Throws unknown_unit. */
export function unitMilli(spec: UomSpec, unit: Unit): number {
  if (unit === spec.base) return 1000
  const u = spec.units.find((x) => x.unit === unit)
  if (!u) throw new UomError('unknown_unit')
  return u.qtyMilli
}

export function hasUnit(spec: UomSpec, unit: Unit): boolean {
  return unit === spec.base || spec.units.some((x) => x.unit === unit)
}

/** Every unit the item can be sold in, base first. */
export function unitsOf(spec: UomSpec): Unit[] {
  return [spec.base, ...spec.units.map((u) => u.unit)]
}

/** Integer round-half-up of a*b/d for non-negative integers, exact (BigInt) so no intermediate can lose precision. */
export function mulDivRound(a: number, b: number, d: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(d) || d <= 0) throw new UomError('overflow')
  const neg = a < 0 !== b < 0
  const A = BigInt(Math.abs(a))
  const B = BigInt(Math.abs(b))
  const D = BigInt(d)
  const q = (A * B * 2n + D) / (2n * D)
  const n = Number(q)
  if (!Number.isSafeInteger(n)) throw new UomError('overflow')
  return neg ? -n : n
}

/**
 * Parses a typed decimal quantity ('0.25', '1,5', ' 12 ') into milli-units WITHOUT floats. More than 3 decimals are
 * rounded half-up on the digits. Returns null for anything that is not a non-negative plain decimal.
 */
export function parseQtyMilli(text: string): number | null {
  const m = /^(\d{1,12})(?:[.,](\d*))?$/.exec(text.trim())
  if (!m) return null
  const frac = m[2] ?? ''
  const whole = BigInt(m[1]) * 1000n
  let milli = BigInt((frac + '000').slice(0, 3))
  if (frac.length > 3 && frac.charCodeAt(3) >= 53) milli += 1n // '5'
  const n = Number(whole + milli)
  return Number.isSafeInteger(n) ? n : null
}

/** '250' -> '0.25'; milli quantity as a trimmed decimal string (no float involved). */
export function formatQtyMilli(milli: number): string {
  const neg = milli < 0
  const a = Math.abs(milli)
  const whole = Math.floor(a / 1000)
  const frac = String(a % 1000).padStart(3, '0').replace(/0+$/, '')
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`
}

function qtyToMilli(qty: string | number): number {
  const text = typeof qty === 'number' ? (Number.isFinite(qty) && !/e/i.test(String(qty)) ? String(qty) : '') : qty
  const m = parseQtyMilli(text)
  if (m === null) throw new UomError('bad_quantity')
  return m
}

/**
 * Quantity typed in `unit` ('0.25' kg, '2' dozen, 3) -> milli-units of the BASE unit, half-up.
 * 0.25 of a kg-base item in kg = 250; 250 g = 250 (g qtyMilli is 1, so 250 g = 250000 milli-g -> 250 milli-kg).
 */
export function toBaseMilli(spec: UomSpec, unit: Unit, qty: string | number): number {
  return mulDivRound(qtyToMilli(qty), unitMilli(spec, unit), 1000)
}

/** Milli-base quantity -> milli-units of `unit` (e.g. 6000 pieces-milli -> 500 = half a packet of 12). Half-up. */
export function fromBaseMilli(spec: UomSpec, unit: Unit, baseMilli: number): number {
  return mulDivRound(baseMilli, 1000, unitMilli(spec, unit))
}

/** Price per base unit -> price per `unit`, round-half-up(base * unitMilli / 1000). */
export function unitPriceFor(spec: UomSpec, unit: Unit, basePricePaise: number): number {
  return mulDivRound(basePricePaise, unitMilli(spec, unit), 1000)
}

/** Amount for qty (milli of base) at price per base unit: round(qtyMilli * price / 1000). */
export function lineGross(qtyMilli: number, basePricePaise: number): number {
  return mulDivRound(qtyMilli, basePricePaise, 1000)
}

export interface ChainLevel {
  unit: Unit
  /** How many of the NEXT (smaller) level one of this holds. Omitted on the last level, which becomes the base. */
  per?: number
}

/**
 * "1 case = 24 packets = 288 pieces": buildChain([{unit:'case',per:24},{unit:'packet',per:12},{unit:'piece'}]).
 * Levels run largest to smallest; the last is the base unit.
 */
export function buildChain(levels: ChainLevel[]): UomSpec {
  if (levels.length === 0) throw new UomError('bad_chain')
  const base = levels[levels.length - 1].unit
  const units: UomSpec['units'] = []
  let milli = 1000
  for (let i = levels.length - 2; i >= 0; i--) {
    const per = levels[i].per
    if (per === undefined || !Number.isSafeInteger(per) || per < 1) throw new UomError('bad_chain')
    milli = milli * per
    if (!Number.isSafeInteger(milli) || milli > MAX_UNIT_MILLI) throw new UomError('overflow')
    units.push({ unit: levels[i].unit, qtyMilli: milli })
  }
  return assertValidUom({ base, units })
}

/** A weighed/measured item: kg base with g = 1, or litre base with ml = 1. */
export function looseSpec(base: 'kg' | 'litre'): UomSpec {
  return { base, units: [{ unit: base === 'kg' ? 'g' : 'ml', qtyMilli: 1 }] }
}

export function simpleSpec(base: Unit): UomSpec {
  return { base, units: [] }
}

export interface ChainRow {
  unit: Unit
  qtyMilli: number
  isBase: boolean
  /** Units of the next smaller row inside one of this, when that is a whole number (the editor's "x 12" column). */
  perNext: number | null
  /** How many BASE units one holds, as a decimal string ('288', '0.001'). */
  inBase: string
}

/** Rows for the unit editor, largest first, base included. */
export function describeChain(spec: UomSpec): ChainRow[] {
  const all = [{ unit: spec.base, qtyMilli: 1000, isBase: true }, ...spec.units.map((u) => ({ unit: u.unit, qtyMilli: u.qtyMilli, isBase: false }))]
  const sorted = all.map((r, i) => ({ r, i })).sort((a, b) => b.r.qtyMilli - a.r.qtyMilli || a.i - b.i).map((x) => x.r)
  return sorted.map((r, i) => {
    const next = sorted[i + 1]
    return {
      ...r,
      perNext: next && r.qtyMilli % next.qtyMilli === 0 ? r.qtyMilli / next.qtyMilli : null,
      inBase: formatQtyMilli(r.qtyMilli),
    }
  })
}

/** Rebuilds a spec from editor rows (any order); the row flagged isBase is the base. */
export function specFromRows(rows: Array<{ unit: Unit; qtyMilli: number; isBase?: boolean }>): UomSpec {
  const base = rows.find((r) => r.isBase)
  if (!base) throw new UomError('bad_base')
  return assertValidUom({ base: base.unit, units: rows.filter((r) => !r.isBase).map(({ unit, qtyMilli }) => ({ unit, qtyMilli })) })
}

/** Reads a stored uom (JSON text or object); anything invalid falls back to a plain chain on `fallbackUnit`. */
export function parseUomOr(raw: unknown, fallbackUnit: Unit): UomSpec {
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (isValidUom(v)) return v
  } catch {
    // fall through
  }
  return simpleSpec(fallbackUnit)
}
