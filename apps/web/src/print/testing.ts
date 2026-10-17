import type { RgbaImage } from './bitmap'
import type { DrawFn, DrawOp } from './rasterize'

/**
 * Deterministic in-memory painter for tests: rects are filled, each non-space character of a text op becomes a solid
 * box, so the output depends only on layout geometry (no fonts). Not imported by the app.
 */
export const fakeDraw: DrawFn = (ops: DrawOp[], w: number, h: number): RgbaImage => {
  const data = new Uint8ClampedArray(w * h * 4).fill(255)
  const fill = (x: number, y: number, bw: number, bh: number) => {
    for (let yy = Math.max(0, y); yy < Math.min(h, y + bh); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(w, x + bw); xx++) {
        const i = (yy * w + xx) * 4
        data[i] = data[i + 1] = data[i + 2] = 0
      }
    }
  }
  for (const op of ops) {
    if (op.kind === 'rect') {
      fill(op.x, op.y, op.w, op.h)
      continue
    }
    const chars = [...op.text]
    const cw = Math.min(op.fontPx / 2, op.w / chars.length)
    const total = cw * chars.length
    const x0 = op.align === 'left' ? op.x : op.align === 'right' ? op.x + op.w - total : op.x + (op.w - total) / 2
    chars.forEach((c, i) => {
      if (c.trim()) fill(Math.round(x0 + i * cw) + 1, op.y + 4, Math.max(1, Math.round(cw) - 2), op.h - 8)
    })
  }
  return { width: w, height: h, data }
}
