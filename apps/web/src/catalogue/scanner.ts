import { normalizeBarcode } from './barcode'

/** Keyboard-wedge scanners type the code like a very fast keyboard and finish with Enter. */
export interface WedgeOptions {
  /** Longest gap between two keys of one scan. Human typing is >100 ms per key; scanners are 1-30 ms. */
  maxGapMs?: number
  /** Shortest code that counts as a scan (shop codes are 4+ digits). */
  minLength?: number
  maxLength?: number
}

export interface WedgeKey {
  key: string
  /** Milliseconds, any monotonic clock (KeyboardEvent.timeStamp in the browser). */
  t: number
}

export interface WedgeResult {
  /** The scanned code (normalised) when this key was the closing Enter of a burst. */
  scan?: string
  /** True once the keys so far look like a scanner burst; callers may stop the keys reaching shortcuts. */
  burst: boolean
}

/**
 * Pure core of the wedge detector. A scan is >= minLength printable characters each arriving within maxGapMs of the
 * previous one, closed by Enter within maxGapMs. Slower typing, even into a text field, never qualifies; a burst
 * qualifies wherever the focus is. A longer pause simply restarts the buffer (a scanner that stalls before its
 * first character loses that character: such a scan is rejected by the check digit/lookup, never mis-booked).
 */
export class WedgeDetector {
  private buf = ''
  private last = Number.NEGATIVE_INFINITY
  private readonly maxGap: number
  private readonly minLen: number
  private readonly maxLen: number

  constructor(opts: WedgeOptions = {}) {
    this.maxGap = opts.maxGapMs ?? 40
    this.minLen = opts.minLength ?? 4
    this.maxLen = opts.maxLength ?? 48
  }

  feed({ key, t }: WedgeKey): WedgeResult {
    if (key === 'Shift' || key === 'CapsLock' || key === 'Control' || key === 'Alt' || key === 'Meta') return { burst: this.buf.length >= 3 }
    const gapOk = t - this.last <= this.maxGap
    if (key === 'Enter' || key === 'Tab') {
      const wasBurst = this.buf.length >= this.minLen && gapOk
      const code = wasBurst ? normalizeBarcode(this.buf) : ''
      this.reset()
      return code.length >= this.minLen ? { scan: code, burst: true } : { burst: false }
    }
    if (key.length !== 1) {
      this.reset()
      return { burst: false }
    }
    if (!gapOk) this.buf = ''
    this.buf = this.buf.length >= this.maxLen ? key : this.buf + key
    this.last = t
    return { burst: this.buf.length >= 3 }
  }

  reset(): void {
    this.buf = ''
    this.last = Number.NEGATIVE_INFINITY
  }

  /** The characters buffered so far (tests, and "remove what the scanner typed into the field"). */
  get pending(): string {
    return this.buf
  }
}

export interface AttachOptions extends WedgeOptions {
  /** Test seam: time of a key event. Defaults to event.timeStamp. */
  clock?: (e: KeyboardEvent) => number
}

type KeyTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>

function isTextField(el: EventTarget | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (!el || typeof (el as HTMLElement).tagName !== 'string') return false
  const tag = (el as HTMLElement).tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || (el as HTMLElement).isContentEditable === true
}

/**
 * Listens for scanner bursts on `target` (document or an element). Outside text fields the burst keys are
 * swallowed so they cannot trigger shortcuts; inside a text field the characters already landed, so after a
 * scan the typed code is removed from the field again (and an 'input' event fires so frameworks resync).
 * Returns detach().
 */
export function attachWedgeScanner(target: KeyTarget, onScan: (code: string) => void, opts: AttachOptions = {}): () => void {
  const det = new WedgeDetector(opts)
  const clock = opts.clock ?? ((e: KeyboardEvent) => e.timeStamp)
  const handler = (ev: Event) => {
    const e = ev as KeyboardEvent
    if (e.ctrlKey || e.altKey || e.metaKey || e.isComposing || e.repeat) return
    const field = isTextField(e.target)
    const res = det.feed({ key: e.key, t: clock(e) })
    if (res.scan) {
      e.preventDefault()
      if (field && 'value' in e.target! && typeof (e.target as HTMLInputElement).value === 'string') {
        const el = e.target as HTMLInputElement
        if (el.value.endsWith(res.scan)) {
          el.value = el.value.slice(0, el.value.length - res.scan.length)
          el.dispatchEvent(new Event('input', { bubbles: true }))
        }
      }
      onScan(res.scan)
    } else if (res.burst && !field) {
      e.preventDefault()
    }
  }
  target.addEventListener('keydown', handler)
  return () => target.removeEventListener('keydown', handler)
}

/** Lets a decode start at most `fps` times a second and never while the previous one is still running. */
export class FrameThrottle {
  private last = Number.NEGATIVE_INFINITY
  private busy = false
  private readonly interval: number

  constructor(fps = 8) {
    this.interval = 1000 / fps
  }

  tryAcquire(now: number): boolean {
    if (this.busy || now - this.last < this.interval) return false
    this.busy = true
    this.last = now
    return true
  }

  release(): void {
    this.busy = false
  }
}

/**
 * Camera frames see the same barcode many times a second. A code is reported once, then ignored while it keeps
 * being seen: the window slides, so holding the item in view books it once; look away for windowMs to scan it again.
 */
export class ScanDeduper {
  private seen = new Map<string, number>()

  constructor(private readonly windowMs = 1500) {}

  accept(code: string, now: number): boolean {
    const prev = this.seen.get(code)
    this.seen.set(code, now)
    if (this.seen.size > 64) for (const [c, t] of this.seen) if (now - t > this.windowMs) this.seen.delete(c)
    return prev === undefined || now - prev >= this.windowMs
  }

  reset(): void {
    this.seen.clear()
  }
}
