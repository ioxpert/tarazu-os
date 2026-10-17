import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'
import { attachWedgeScanner, FrameThrottle, ScanDeduper, WedgeDetector } from './scanner'

function burst(det: WedgeDetector, text: string, start: number, gap: number, enter = true) {
  let t = start
  let last
  for (const ch of text) {
    last = det.feed({ key: ch, t })
    t += gap
  }
  if (enter) last = det.feed({ key: 'Enter', t })
  return last!
}

describe('WedgeDetector', () => {
  it('detects a fast burst closed by Enter', () => {
    const det = new WedgeDetector()
    expect(burst(det, '8901719101236', 1000, 8).scan).toBe('8901719101236')
  })
  it('ignores human typing, even into a long code', () => {
    const det = new WedgeDetector()
    expect(burst(det, '8901719101236', 1000, 150).scan).toBeUndefined()
  })
  it('needs at least 4 characters and an Enter that follows quickly', () => {
    const det = new WedgeDetector()
    expect(burst(det, '123', 0, 5).scan).toBeUndefined()
    expect(burst(det, '1234', 100, 5).scan).toBe('1234')
    expect(burst(det, '12345', 0, 5, false).scan).toBeUndefined()
    expect(det.feed({ key: 'Enter', t: 500 }).scan).toBeUndefined() // Enter pressed by hand long after
  })
  it('a pause restarts the buffer: typed prefix + later burst yields only the burst', () => {
    const det = new WedgeDetector()
    det.feed({ key: 'a', t: 0 })
    det.feed({ key: 'b', t: 300 })
    expect(burst(det, '4006381333931', 1000, 10).scan).toBe('4006381333931')
  })
  it('strips an AIM prefix and ignores Shift', () => {
    const det = new WedgeDetector()
    det.feed({ key: ']', t: 0 })
    det.feed({ key: 'E', t: 5 })
    det.feed({ key: 'Shift', t: 7 })
    det.feed({ key: '0', t: 10 })
    for (const [i, c] of [...'12345678'].entries()) det.feed({ key: c, t: 15 + i * 5 })
    expect(det.feed({ key: 'Enter', t: 60 }).scan).toBe('12345678')
  })
  it('non-printable keys reset the buffer', () => {
    const det = new WedgeDetector()
    det.feed({ key: '1', t: 0 })
    det.feed({ key: '2', t: 5 })
    det.feed({ key: 'Backspace', t: 8 })
    expect(det.pending).toBe('')
  })
  it('any burst of 4-30 printable chars with gaps under the limit is a scan (property)', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[0-9]{4,30}$/), fc.integer({ min: 0, max: 40 }), fc.integer({ min: 0, max: 1e6 }), (code, gap, start) => {
        expect(burst(new WedgeDetector(), code, start, gap).scan).toBe(code)
      }),
    )
  })
  it('slow typing never scans (property)', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[0-9]{4,30}$/), fc.integer({ min: 41, max: 500 }), (code, gap) => {
        expect(burst(new WedgeDetector(), code, 0, gap).scan).toBeUndefined()
      }),
    )
  })
})

describe('attachWedgeScanner (DOM)', () => {
  function key(target: EventTarget, k: string) {
    const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })
    target.dispatchEvent(e)
    return e
  }

  it('reports scans on the document, swallows burst keys, and detaches', () => {
    let now = 0
    const seen: string[] = []
    const detach = attachWedgeScanner(document, (c) => seen.push(c), { clock: () => now })
    const events = []
    for (const ch of '8901234567890') {
      now += 6
      events.push(key(document.body, ch))
    }
    now += 6
    const enter = key(document.body, 'Enter')
    expect(seen).toEqual(['8901234567890'])
    expect(enter.defaultPrevented).toBe(true)
    expect(events.slice(3).every((e) => e.defaultPrevented)).toBe(true)
    detach()
    for (const ch of '12345678') {
      now += 6
      key(document.body, ch)
    }
    now += 6
    key(document.body, 'Enter')
    expect(seen).toHaveLength(1)
  })

  it('in a text field it removes the typed code again but only for a burst', () => {
    let now = 0
    const seen: string[] = []
    const input = document.createElement('input')
    document.body.appendChild(input)
    const onInput = vi.fn()
    input.addEventListener('input', onInput)
    attachWedgeScanner(document, (c) => seen.push(c), { clock: () => now })
    const type = (text: string, gap: number) => {
      for (const ch of text) {
        now += gap
        input.value += ch // the browser would have inserted it
        key(input, ch)
      }
    }
    // human typing a name, then Enter: nothing happens
    type('tata', 200)
    now += 200
    expect(key(input, 'Enter').defaultPrevented).toBe(false)
    expect(seen).toEqual([])
    expect(input.value).toBe('tata')
    // scanner burst appended: code reported, field restored
    type('8901234567890', 5)
    now += 5
    key(input, 'Enter')
    expect(seen).toEqual(['8901234567890'])
    expect(input.value).toBe('tata')
    expect(onInput).toHaveBeenCalledTimes(1)
  })

  it('ignores ctrl/meta combos', () => {
    const now = 0
    const seen: string[] = []
    attachWedgeScanner(document, (c) => seen.push(c), { clock: () => now })
    for (const ch of '1234567') document.dispatchEvent(new KeyboardEvent('keydown', { key: ch, ctrlKey: true }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }))
    expect(seen).toEqual([])
  })
})

describe('FrameThrottle', () => {
  it('allows ~8 fps and never overlaps decodes', () => {
    const th = new FrameThrottle(8)
    expect(th.tryAcquire(0)).toBe(true)
    expect(th.tryAcquire(50)).toBe(false)
    th.release()
    expect(th.tryAcquire(100)).toBe(false) // 125 ms interval
    expect(th.tryAcquire(125)).toBe(true)
    expect(th.tryAcquire(400)).toBe(false) // still busy
    th.release()
    expect(th.tryAcquire(400)).toBe(true)
  })
  it('never exceeds fps over any window (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 40 }), { minLength: 1, maxLength: 200 }), (steps) => {
        const th = new FrameThrottle(8)
        let t = 0
        const accepted: number[] = []
        for (const s of steps) {
          t += s
          if (th.tryAcquire(t)) {
            accepted.push(t)
            th.release()
          }
        }
        for (let i = 1; i < accepted.length; i++) expect(accepted[i] - accepted[i - 1]).toBeGreaterThanOrEqual(125)
      }),
    )
  })
})

describe('ScanDeduper', () => {
  it('reports a code once while it stays in view, again after 1.5 s of absence', () => {
    const d = new ScanDeduper(1500)
    expect(d.accept('111111', 0)).toBe(true)
    expect(d.accept('111111', 500)).toBe(false)
    expect(d.accept('111111', 1400)).toBe(false)
    expect(d.accept('111111', 2000)).toBe(false) // sliding window: still in view
    expect(d.accept('111111', 3600)).toBe(true)
    expect(d.accept('222222', 3700)).toBe(true)
    expect(d.accept('111111', 3800)).toBe(false)
  })
})
