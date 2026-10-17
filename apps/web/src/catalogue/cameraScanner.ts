/**
 * Camera barcode scanner. IMPORTANT: import this module ONLY dynamically (`await import('./cameraScanner')`) from
 * the screen that opens the camera, so neither this code nor zxing-wasm is in the first-load bundle.
 *
 * Engine: the browser's BarcodeDetector when it exists (Chrome/Android: hardware-backed, no download), otherwise
 * zxing-wasm's reader, loaded lazily on the first start(). zxing-wasm defaults to fetching its .wasm from the
 * jsDelivr CDN; that would break offline use and send the device's IP to a third party, so locateFile is pointed
 * at the file Vite fingerprints and serves from our own origin (`...zxing_reader.wasm?url`).
 */
import { normalizeBarcode } from './barcode'
import { FrameThrottle, ScanDeduper } from './scanner'

export interface DetectedBarcode {
  rawValue: string
}
export interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>
}
export type BarcodeDetectorCtor = new (opts: { formats: string[] }) => BarcodeDetectorLike

export interface ZxingLike {
  readBarcodes(img: ImageData, opts?: Record<string, unknown>): Promise<Array<{ text: string; isValid?: boolean }>>
}

export interface CameraDeps {
  mediaDevices?: Pick<MediaDevices, 'getUserMedia'>
  barcodeDetector?: BarcodeDetectorCtor | null
  loadZxing?: () => Promise<ZxingLike>
  /** Copies the current video frame to pixels for zxing. */
  grabFrame?: (video: HTMLVideoElement) => ImageData | null
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  fps?: number
  dedupeMs?: number
}

export interface CameraScanner {
  start(video: HTMLVideoElement, onCode: (code: string) => void): Promise<void>
  stop(): void
  readonly active: boolean
  /** Which decoder is running ('native' | 'zxing'); null when stopped. */
  readonly engine: 'native' | 'zxing' | null
}

const NATIVE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf']
const ZXING_FORMATS = ['EAN13', 'EAN8', 'UPCA', 'UPCE', 'Code128', 'Code39', 'ITF']

async function defaultLoadZxing(): Promise<ZxingLike> {
  const [mod, wasm] = await Promise.all([import('zxing-wasm/reader'), import('zxing-wasm/reader/zxing_reader.wasm?url')])
  const wasmUrl = wasm.default
  mod.prepareZXingModule({
    overrides: { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) },
  })
  return {
    readBarcodes: (img, opts) => mod.readBarcodes(img, opts as never) as Promise<Array<{ text: string; isValid?: boolean }>>,
  }
}

function defaultGrabFrame(): (video: HTMLVideoElement) => ImageData | null {
  let canvas: HTMLCanvasElement | null = null
  return (video) => {
    const w = video.videoWidth
    const h = video.videoHeight
    if (!w || !h) return null
    canvas ??= document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(video, 0, 0, w, h)
    return ctx.getImageData(0, 0, w, h)
  }
}

export function createCameraScanner(deps: CameraDeps = {}): CameraScanner {
  const now = deps.now ?? (() => performance.now())
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const grab = deps.grabFrame ?? defaultGrabFrame()
  const fps = deps.fps ?? 8

  let stream: MediaStream | null = null
  let video: HTMLVideoElement | null = null
  let timer: unknown = null
  let running = false
  let engine: 'native' | 'zxing' | null = null
  let generation = 0

  function stop(): void {
    running = false
    generation++
    if (timer !== null) clearTimer(timer)
    timer = null
    stream?.getTracks().forEach((t) => t.stop())
    stream = null
    if (video) {
      try {
        video.srcObject = null
      } catch {
        // detached element: nothing to clear
      }
    }
    video = null
    engine = null
  }

  async function start(el: HTMLVideoElement, onCode: (code: string) => void): Promise<void> {
    stop()
    const gen = ++generation
    const md = deps.mediaDevices ?? navigator.mediaDevices
    if (!md?.getUserMedia) throw new Error('camera_unavailable')
    const media = await md.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    })
    if (gen !== generation) {
      media.getTracks().forEach((t) => t.stop()) // stop() was called while the permission prompt was open
      return
    }
    stream = media
    video = el
    el.setAttribute('playsinline', 'true')
    el.muted = true
    el.srcObject = media
    await el.play?.()

    const Native = deps.barcodeDetector === undefined ? (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector ?? null : deps.barcodeDetector
    let detect: (() => Promise<string[]>) | null = null
    if (Native) {
      try {
        const d = new Native({ formats: NATIVE_FORMATS })
        detect = async () => (await d.detect(el)).map((b) => b.rawValue)
        engine = 'native'
      } catch {
        detect = null
      }
    }
    if (!detect) {
      const zx = await (deps.loadZxing ?? defaultLoadZxing)()
      if (gen !== generation) return
      detect = async () => {
        const img = grab(el)
        if (!img) return []
        const res = await zx.readBarcodes(img, { formats: ZXING_FORMATS, tryHarder: true, maxNumberOfSymbols: 1 })
        return res.filter((r) => r.isValid !== false).map((r) => r.text)
      }
      engine = 'zxing'
    }

    const throttle = new FrameThrottle(fps)
    const dedupe = new ScanDeduper(deps.dedupeMs ?? 1500)
    running = true
    const tick = async () => {
      if (!running || gen !== generation) return
      const t = now()
      if (throttle.tryAcquire(t)) {
        try {
          for (const raw of await detect!()) {
            const code = normalizeBarcode(raw)
            if (code && dedupe.accept(code, now()) && running && gen === generation) onCode(code)
          }
        } catch {
          // one bad frame must not stop the scanner
        } finally {
          throttle.release()
        }
      }
      if (running && gen === generation) timer = setTimer(tick, 1000 / fps)
    }
    timer = setTimer(tick, 0)
  }

  return {
    start,
    stop,
    get active() {
      return running
    },
    get engine() {
      return engine
    },
  }
}

const shared = createCameraScanner()
export const start = shared.start
export const stop = shared.stop
