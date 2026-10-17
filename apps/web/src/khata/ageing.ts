/**
 * How long customers have owed money. Payments are matched to the OLDEST open debt first (FIFO), the way a shopkeeper
 * thinks about it ("the old bill is cleared first"). Nothing is stored: the khata_entry lines are the truth and this is
 * a pure view over them, so it can never disagree with the balance.
 */
export interface AgeEntry {
  direction: 'debit' | 'credit'
  amountPaise: number
  /** ISO timestamp */
  occurredAt: string
  id?: string
}

export interface OpenDebt {
  occurredAt: string
  remainingPaise: number
}

export interface Ageing {
  /** What is still owed, oldest first, each with the date it started. */
  open: OpenDebt[]
  /** Money the customer paid ahead of any bill (shown as "advance"). */
  advancePaise: number
  /** open total - advance = the khata balance. */
  owedPaise: number
  /** Whole days since the oldest open debt, 0 when nothing is owed. */
  oldestDays: number
  buckets: { upTo30: number; from31To60: number; over60: number }
}

const DAY_MS = 86_400_000

export function wholeDays(fromIso: string, to: Date | number): number {
  const ms = new Date(to).getTime() - new Date(fromIso).getTime()
  return Math.max(0, Math.floor(ms / DAY_MS))
}

export function ageing(entries: readonly AgeEntry[], asOf: Date | number): Ageing {
  const sorted = [...entries].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || (a.id ?? '').localeCompare(b.id ?? ''))
  const open: OpenDebt[] = []
  let advance = 0
  for (const e of sorted) {
    let amount = e.amountPaise
    if (e.direction === 'debit') {
      // an advance paid earlier settles a new bill first
      const used = Math.min(advance, amount)
      advance -= used
      amount -= used
      if (amount > 0) open.push({ occurredAt: e.occurredAt, remainingPaise: amount })
    } else {
      while (amount > 0 && open.length > 0) {
        const head = open[0]
        const used = Math.min(head.remainingPaise, amount)
        head.remainingPaise -= used
        amount -= used
        if (head.remainingPaise === 0) open.shift()
      }
      advance += amount
    }
  }
  const buckets = { upTo30: 0, from31To60: 0, over60: 0 }
  for (const d of open) {
    const days = wholeDays(d.occurredAt, asOf)
    if (days <= 30) buckets.upTo30 += d.remainingPaise
    else if (days <= 60) buckets.from31To60 += d.remainingPaise
    else buckets.over60 += d.remainingPaise
  }
  const owedPaise = open.reduce((a, d) => a + d.remainingPaise, 0)
  return { open, advancePaise: advance, owedPaise, oldestDays: open.length ? wholeDays(open[0].occurredAt, asOf) : 0, buckets }
}
