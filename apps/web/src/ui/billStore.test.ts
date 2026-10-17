import { beforeEach, describe, expect, it } from 'vitest'
import type { CartLine } from '../billing/types'
import { billStore } from './billStore'

const line = (productId: string, qtyMilli = 1000): CartLine => ({
  lineId: crypto.randomUUID(),
  productId,
  name: productId,
  localName: null,
  hsn: null,
  qtyMilli,
  unit: 'piece',
  unitPricePaise: 1000,
  priceSource: 'retail',
  taxInclusive: true,
  taxRateBp: 0,
  taxRateSource: 'none',
  discount: null,
})

describe('billStore', () => {
  beforeEach(() => billStore.clear())

  it('adds the same product to the existing line', () => {
    billStore.addLine(line('a'))
    billStore.addLine(line('a'))
    expect(billStore.get().lines).toHaveLength(1)
    expect(billStore.get().lines[0].qtyMilli).toBe(2000)
  })

  it('keeps weighed lines separate when merging is off', () => {
    billStore.addLine(line('rice', 250), false)
    billStore.addLine(line('rice', 500), false)
    expect(billStore.get().lines).toHaveLength(2)
  })

  it('undoes the last change step by step, and a finished bill cannot be undone', () => {
    billStore.addLine(line('a'))
    billStore.addLine(line('b'))
    billStore.setBillDiscount({ kind: 'percent', bp: 100 })
    billStore.undo()
    expect(billStore.get().billDiscount).toBeNull()
    billStore.undo()
    expect(billStore.get().lines.map((l) => l.productId)).toEqual(['a'])
    billStore.clear()
    expect(billStore.canUndo()).toBe(false)
  })

  it('keeps the same request id until the cart changes, so a double tap cannot make two invoices', () => {
    billStore.addLine(line('a'))
    const first = billStore.ensureRequestId()
    expect(billStore.ensureRequestId()).toBe(first)
    billStore.addLine(line('b'))
    expect(billStore.ensureRequestId()).not.toBe(first)
  })
})
