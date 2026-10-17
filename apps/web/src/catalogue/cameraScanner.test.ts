import { describe, expect, it } from 'vitest'
import { createCameraScanner, type BarcodeDetectorCtor, type CameraDeps } from './cameraScanner'

function fakeStream() {
  const stops: boolean[] = []
  const tracks = [{ stop: () => stops.push(true) }, { stop: () => stops.push(true) }]
  return { stream: { getTracks: () => tracks } as unknown as MediaStream, stops }
}

function fakeVideo() {
  const el = document.createElement('video')
  Object.defineProperty(el, 'play', { value: () => Promise.resolve() })
  return el
}

/** Manual clock + timers so frames are driven deterministically. */
function harness(extra: Partial<CameraDeps> = {}) {
  let now = 0
  const timers: Array<{ at: number; fn: () => void; id: number }> = []
  let nextId = 1
  const s = fakeStream()
  const constraints: unknown[] = []
  const deps: CameraDeps = {
    mediaDevices: {
      getUserMedia: async (c) => {
        constraints.push(c)
        return s.stream
      },
    },
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextId++
      timers.push({ at: now + ms, fn, id })
      return id
    },
    clearTimer: (h) => {
      const i = timers.findIndex((t) => t.id === h)
      if (i >= 0) timers.splice(i, 1)
    },
    ...extra,
  }
  async function advance(ms: number) {
    const end = now + ms
    for (;;) {
      timers.sort((a, b) => a.at - b.at)
      const next = timers[0]
      if (!next || next.at > end) break
      timers.shift()
      now = Math.max(now, next.at)
      next.fn()
      await new Promise((r) => setTimeout(r, 0)) // let the async tick settle
    }
    now = end
  }
  return { deps, advance, stops: s.stops, constraints, timers }
}

describe('camera scanner', () => {
  it('uses BarcodeDetector when present, asks for the rear camera at 1280x720, dedupes repeats', async () => {
    let detects = 0
    const reads = ['8901719101236', '8901719101236', '8901719101236', '5449000000996']
    class FakeDetector {
      constructor(public opts: { formats: string[] }) {}
      async detect() {
        const v = reads[Math.min(detects++, reads.length - 1)]
        return [{ rawValue: ` ${v}\n` }]
      }
    }
    const h = harness({ barcodeDetector: FakeDetector as unknown as BarcodeDetectorCtor })
    const sc = createCameraScanner(h.deps)
    const codes: string[] = []
    await sc.start(fakeVideo(), (c) => codes.push(c))
    expect(sc.engine).toBe('native')
    expect(h.constraints[0]).toMatchObject({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } })
    await h.advance(1000)
    expect(codes).toEqual(['8901719101236', '5449000000996'])
    expect(detects).toBeGreaterThanOrEqual(7) // ~8 fps for 1 s, not one per timer tick storm
    expect(detects).toBeLessThanOrEqual(10)
    sc.stop()
  })

  it('falls back to zxing (lazy loader) on frames from grabFrame, and does not load it when native exists', async () => {
    let loads = 0
    let frames = 0
    const h = harness({
      barcodeDetector: null,
      loadZxing: async () => {
        loads++
        return { readBarcodes: async () => [{ text: '4006381333931', isValid: true }, { text: 'junk', isValid: false }] }
      },
      grabFrame: () => {
        frames++
        return {} as ImageData
      },
    })
    const sc = createCameraScanner(h.deps)
    const codes: string[] = []
    await sc.start(fakeVideo(), (c) => codes.push(c))
    expect(loads).toBe(1)
    expect(sc.engine).toBe('zxing')
    await h.advance(600)
    expect(codes).toEqual(['4006381333931'])
    expect(frames).toBeGreaterThan(2)

    let loads2 = 0
    const sc2 = createCameraScanner({ ...harness({ barcodeDetector: class { async detect() { return [] } } as unknown as BarcodeDetectorCtor, loadZxing: async () => { loads2++; throw new Error('no') } }).deps })
    await sc2.start(fakeVideo(), () => undefined)
    expect(loads2).toBe(0)
    sc2.stop()
    sc.stop()
  })

  it('stop() stops every track, cancels the loop and silences callbacks', async () => {
    const h = harness({ barcodeDetector: class { async detect() { return [{ rawValue: '1234567' }] } } as unknown as BarcodeDetectorCtor })
    const sc = createCameraScanner(h.deps)
    const codes: string[] = []
    await sc.start(fakeVideo(), (c) => codes.push(c))
    await h.advance(300)
    sc.stop()
    expect(h.stops).toHaveLength(2)
    expect(sc.active).toBe(false)
    expect(h.timers).toHaveLength(0)
    const n = codes.length
    await h.advance(5000)
    expect(codes).toHaveLength(n)
  })

  it('a decode error does not kill the loop; a missing camera rejects', async () => {
    let n = 0
    const h = harness({
      barcodeDetector: class {
        async detect() {
          if (n++ === 0) throw new Error('bad frame')
          return [{ rawValue: '1234567' }]
        }
      } as unknown as BarcodeDetectorCtor,
    })
    const sc = createCameraScanner(h.deps)
    const codes: string[] = []
    await sc.start(fakeVideo(), (c) => codes.push(c))
    await h.advance(600)
    expect(codes).toEqual(['1234567'])
    sc.stop()
    await expect(createCameraScanner({ mediaDevices: { getUserMedia: undefined as never } }).start(fakeVideo(), () => undefined)).rejects.toThrow('camera_unavailable')
  })

  it('stop() while the permission prompt is open releases the stream when it arrives', async () => {
    const h = harness({ barcodeDetector: null, loadZxing: async () => ({ readBarcodes: async () => [] }) })
    const sc = createCameraScanner(h.deps)
    const p = sc.start(fakeVideo(), () => undefined)
    sc.stop()
    await p
    expect(h.stops).toHaveLength(2)
    expect(sc.active).toBe(false)
  })
})
