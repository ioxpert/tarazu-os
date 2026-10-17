import { thresholdToBitmap, type Bitmap, type RgbaImage } from './bitmap'
import type { Cell, ReceiptLayout } from './receipt'

/**
 * Layout -> monochrome bitmap. The glyph painting is injected (`draw`) so this stays pure and testable: the app passes
 * createCanvasDraw(...) backed by OffscreenCanvas/HTMLCanvasElement (system Devanagari fonts do the shaping), tests
 * pass a deterministic in-memory painter.
 */
export type DrawOp =
  | { kind: 'rect'; x: number; y: number; w: number; h: number }
  | { kind: 'text'; text: string; x: number; y: number; w: number; h: number; align: 'left' | 'right' | 'center'; fontPx: number; bold: boolean }

/** Paint ops on a white canvas of the given size (black ink) and return its RGBA pixels. */
export type DrawFn = (ops: DrawOp[], widthPx: number, heightPx: number) => RgbaImage | Promise<RgbaImage>

export const LINE_HEIGHT = 28
export const FONT_PX = 22

export interface PaintList {
  ops: DrawOp[]
  widthPx: number
  heightPx: number
}

function cellX(cells: Cell[], index: number, unit: number): number {
  let x = 0
  for (let i = 0; i < index; i++) x += cells[i].width * unit
  return x
}

export function buildPaintList(layout: ReceiptLayout): PaintList {
  const widthPx = layout.dots
  const cellW = widthPx / layout.cols
  const ops: DrawOp[] = []
  let y = 4
  for (const b of layout.blocks) {
    if (b.kind === 'row') {
      const unit = cellW * b.scale
      const h = LINE_HEIGHT * b.scale
      b.cells.forEach((c, i) => {
        if (!c.text.trim()) return
        ops.push({
          kind: 'text', text: c.text, x: Math.round(cellX(b.cells, i, unit)), y, w: Math.round(c.width * unit), h,
          align: c.align, fontPx: FONT_PX * b.scale, bold: b.bold,
        })
      })
      y += h
    } else if (b.kind === 'rule') {
      if (b.char === '-') ops.push({ kind: 'rect', x: 0, y: y + 7, w: widthPx, h: 2 })
      else {
        ops.push({ kind: 'rect', x: 0, y: y + 5, w: widthPx, h: 2 })
        ops.push({ kind: 'rect', x: 0, y: y + 10, w: widthPx, h: 2 })
      }
      y += 16
    } else if (b.kind === 'qr') {
      const n = b.matrix.length
      const dot = Math.max(1, Math.floor(Math.min(widthPx, 320) / (n + 4)))
      const side = (n + 4) * dot
      const x0 = Math.floor((widthPx - side) / 2) + 2 * dot
      for (let my = 0; my < n; my++) {
        let mx = 0
        while (mx < n) {
          if (!b.matrix[my][mx]) {
            mx++
            continue
          }
          let run = 1
          while (mx + run < n && b.matrix[my][mx + run]) run++
          ops.push({ kind: 'rect', x: x0 + mx * dot, y: y + (2 + my) * dot, w: run * dot, h: dot })
          mx += run
        }
      }
      y += side + 8
    } else {
      y += b.lines * LINE_HEIGHT
    }
  }
  return { ops, widthPx, heightPx: y + 4 }
}

export interface RasterizeOptions {
  /** Luminance below this is ink (default 128). */
  threshold?: number
}

export async function rasterizeLayout(layout: ReceiptLayout, draw: DrawFn, opts: RasterizeOptions = {}): Promise<Bitmap> {
  const paint = buildPaintList(layout)
  const img = await draw(paint.ops, paint.widthPx, paint.heightPx)
  if (img.width !== paint.widthPx || img.height !== paint.heightPx) throw new Error('draw returned an image of the wrong size')
  return thresholdToBitmap(img, opts.threshold ?? 128)
}

export const DEFAULT_FONT_STACK =
  '"Noto Sans Devanagari", "Noto Sans", "Mangal", "Nirmala UI", "Lohit Devanagari", "Kohinoor Devanagari", "Droid Sans", sans-serif'

interface Ctx2D {
  fillStyle: string
  font: string
  textAlign: string
  textBaseline: string
  fillRect(x: number, y: number, w: number, h: number): void
  fillText(text: string, x: number, y: number, maxWidth?: number): void
  getImageData(x: number, y: number, w: number, h: number): RgbaImage
}
export interface CanvasLike {
  getContext(id: '2d'): Ctx2D | null
}

/** DrawFn over any canvas factory: `(w, h) => new OffscreenCanvas(w, h)` or an HTMLCanvasElement. */
export function createCanvasDraw(makeCanvas: (w: number, h: number) => CanvasLike, fontFamily = DEFAULT_FONT_STACK): DrawFn {
  return (ops, w, h) => {
    const ctx = makeCanvas(w, h).getContext('2d')
    if (!ctx) throw new Error('2d canvas unavailable')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = '#000'
    ctx.textBaseline = 'middle'
    for (const op of ops) {
      if (op.kind === 'rect') ctx.fillRect(op.x, op.y, op.w, op.h)
      else {
        ctx.font = `${op.bold ? 'bold ' : ''}${op.fontPx}px ${fontFamily}`
        ctx.textAlign = op.align
        const x = op.align === 'left' ? op.x : op.align === 'right' ? op.x + op.w : op.x + op.w / 2
        ctx.fillText(op.text, x, op.y + op.h / 2, op.w)
      }
    }
    return ctx.getImageData(0, 0, w, h)
  }
}

