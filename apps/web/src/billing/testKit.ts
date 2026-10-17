/** Test helpers shared by the billing tests (not imported by app code). */
import type { CartLine } from './types'

export function line(over: Partial<CartLine> & { qtyMilli: number; unitPricePaise: number }): CartLine {
  return {
    lineId: over.lineId ?? `l${Math.random().toString(36).slice(2, 8)}`,
    productId: over.productId ?? '22222222-2222-4222-8222-222222222222',
    name: 'Item',
    localName: null,
    hsn: null,
    unit: 'piece',
    priceSource: 'retail',
    taxInclusive: true,
    taxRateBp: 0,
    taxRateSource: 'none',
    discount: null,
    ...over,
  }
}

interface Stmt {
  all(...p: unknown[]): unknown[]
}
/** First row of a query on the node:sqlite handle from makeSchemaDb, or undefined. */
export function first<T = Record<string, unknown>>(sqlite: { prepare(sql: string): Stmt }, sql: string, ...params: unknown[]): T | undefined {
  return sqlite.prepare(sql).all(...params)[0] as T | undefined
}
