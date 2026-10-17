import { useSyncExternalStore } from 'react'
import type { Cart, CartLine, Discount } from '../billing/types'

/**
 * The bill being built on this counter. A module-level store so Back from the payment screen keeps the cart, and
 * the cashier can undo the last change (add, quantity, remove, discount, customer). Drafts never leave the device.
 */
export interface Customer {
  id: string
  name: string
}

export interface BillState {
  lines: CartLine[]
  billDiscount: Discount | null
  customer: Customer | null
  /** Set when Pay is first tapped; a retry of the same bill reuses it so a double tap cannot make two invoices. */
  requestId: string | null
}

const EMPTY: BillState = { lines: [], billDiscount: null, customer: null, requestId: null }
const MAX_UNDO = 30

let state: BillState = EMPTY
let undoStack: BillState[] = []
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((l) => l())
}

function commit(next: BillState, remember = true) {
  if (remember) undoStack = [...undoStack.slice(-(MAX_UNDO - 1)), state]
  state = { ...next, requestId: null }
  emit()
}

export const billStore = {
  get: (): BillState => state,
  subscribe(l: () => void) {
    listeners.add(l)
    return () => listeners.delete(l)
  },
  canUndo: () => undoStack.length > 0,
  toCart: (): Cart => ({ lines: state.lines, billDiscount: state.billDiscount, partyId: state.customer?.id ?? null }),

  /** Same product again adds to the line (unless it is a weighed line with its own quantity). */
  addLine(line: CartLine, mergeInto = true) {
    const existing = mergeInto ? state.lines.findIndex((l) => l.productId === line.productId && l.priceSource === line.priceSource && l.discount === null) : -1
    if (existing >= 0) {
      const lines = state.lines.map((l, i) => (i === existing ? { ...l, qtyMilli: l.qtyMilli + line.qtyMilli } : l))
      commit({ ...state, lines })
    } else {
      commit({ ...state, lines: [...state.lines, line] })
    }
  },
  updateLine(lineId: string, patch: Partial<CartLine>) {
    commit({ ...state, lines: state.lines.map((l) => (l.lineId === lineId ? { ...l, ...patch } : l)) })
  },
  /** Reprice lines after the customer changes (customer rates). `fn` maps each line to its new version. */
  replaceLines(lines: CartLine[]) {
    commit({ ...state, lines })
  },
  removeLine(lineId: string) {
    commit({ ...state, lines: state.lines.filter((l) => l.lineId !== lineId) })
  },
  setBillDiscount(d: Discount | null) {
    commit({ ...state, billDiscount: d })
  },
  setCustomer(c: Customer | null) {
    commit({ ...state, customer: c })
  },
  /** Called when Pay is tapped; stable until the cart changes. */
  ensureRequestId(): string {
    if (!state.requestId) state = { ...state, requestId: crypto.randomUUID() }
    return state.requestId!
  },
  undo() {
    const prev = undoStack.pop()
    if (!prev) return
    state = prev
    emit()
  },
  /** Start a new bill (after a sale, or discard). Not undoable on purpose: a finished sale must stay finished. */
  clear() {
    state = EMPTY
    undoStack = []
    emit()
  },
  load(cart: Cart, customer: Customer | null) {
    state = { lines: cart.lines, billDiscount: cart.billDiscount, customer, requestId: null }
    undoStack = []
    emit()
  },
}

export function useBill(): BillState {
  return useSyncExternalStore(billStore.subscribe, billStore.get)
}
