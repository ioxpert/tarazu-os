import { getPixel, matrixToBitmap, thresholdToBitmap, type Bitmap } from './bitmap'
import { dummyQr, hindiSale, plainSale } from './fixtures'
import { buildPaintList, createCanvasDraw, rasterizeLayout, type CanvasLike } from './rasterize'
import { buildReceiptLayout } from './receipt'
import { fakeDraw } from './testing'

const ink = (b: Bitmap) => {
  let n = 0
  for (let y = 0; y < b.heightPx; y++) for (let x = 0; x < b.widthPx; x++) if (getPixel(b, x, y)) n++
  return n
}

describe('thresholdToBitmap', () => {
  it('is a plain threshold on luminance, transparent = paper', () => {
    const data = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 127, 127, 127, 255, 129, 129, 129, 255, 0, 0, 0, 0])
    const b = thresholdToBitmap({ width: 5, height: 1, data })
    expect([0, 1, 2, 3, 4].map((x) => getPixel(b, x, 0))).toEqual([true, false, true, false, false])
    expect(b.data).toHaveLength(1)
  })
  it('does not dither: mid-grey is uniformly one value', () => {
    const data = Uint8ClampedArray.from({ length: 64 * 4 }, (_, i) => (i % 4 === 3 ? 255 : 100))
    const b = thresholdToBitmap({ width: 8, height: 8, data }, 128)
    expect(ink(b)).toBe(64)
  })
})

describe('rasterizeLayout', () => {
  it('produces a bitmap at the paper width with ink where text and rules are', async () => {
    for (const [mm, dots] of [[58, 384], [80, 576]] as const) {
      const bm = await rasterizeLayout(buildReceiptLayout(hindiSale, { widthMm: mm, lang: 'en+hi', qrMatrix: dummyQr }), fakeDraw)
      expect(bm.widthPx).toBe(dots)
      expect(bm.heightPx).toBeGreaterThan(300)
      expect(bm.data.length).toBe((dots / 8) * bm.heightPx)
      expect(ink(bm)).toBeGreaterThan(1000)
    }
  })
  it('is deterministic', async () => {
    const l = buildReceiptLayout(plainSale, { widthMm: 80, lang: 'en' })
    const a = await rasterizeLayout(l, fakeDraw)
    const b = await rasterizeLayout(l, fakeDraw)
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true)
  })
  it('paints the QR modules exactly', async () => {
    const paint = buildPaintList(buildReceiptLayout(plainSale, { widthMm: 58, lang: 'en', qrMatrix: dummyQr }))
    const rects = paint.ops.filter((o) => o.kind === 'rect' && o.h > 2)
    const modules = rects.reduce((s, r) => s + (r.kind === 'rect' ? r.w / r.h : 0), 0)
    expect(modules).toBe(dummyQr.flat().filter(Boolean).length)
  })
  it('rejects a renderer that returns the wrong size', async () => {
    const l = buildReceiptLayout(plainSale, { widthMm: 58, lang: 'en' })
    await expect(rasterizeLayout(l, () => ({ width: 1, height: 1, data: new Uint8ClampedArray(4) }))).rejects.toThrow()
  })
  it('createCanvasDraw drives a 2d context', async () => {
    const calls: string[] = []
    const ctx = {
      fillStyle: '', font: '', textAlign: '', textBaseline: '',
      fillRect: (x: number, y: number, w: number, h: number) => calls.push(`rect ${x},${y},${w},${h}`),
      fillText: (t: string, x: number) => calls.push(`text ${t}@${x} ${ctx.font} ${ctx.textAlign}`),
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(255) }),
    }
    const canvas: CanvasLike = { getContext: () => ctx }
    const bm = await rasterizeLayout(buildReceiptLayout(hindiSale, { widthMm: 58, lang: 'hi' }), createCanvasDraw(() => canvas, 'X'))
    expect(calls[0]).toMatch(/^rect 0,0,384,/)
    expect(calls.some((c) => c.includes('आशीर्वाद') && c.includes('22px X left'))).toBe(true)
    expect(ink(bm)).toBe(0)
  })
  it('matrixToBitmap scales modules and adds a quiet zone', () => {
    const b = matrixToBitmap([[true]], 3, 1)
    expect(b.widthPx).toBe(9)
    expect(getPixel(b, 3, 3)).toBe(true)
    expect(getPixel(b, 2, 3)).toBe(false)
  })
})
