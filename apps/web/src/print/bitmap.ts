/** 1-bit bitmap, rows packed MSB first, 1 = black ink. Row stride is ceil(widthPx / 8) bytes. */
export interface Bitmap {
  widthPx: number
  heightPx: number
  data: Uint8Array
}

export function rowBytes(widthPx: number): number {
  return Math.ceil(widthPx / 8)
}

export function emptyBitmap(widthPx: number, heightPx: number): Bitmap {
  return { widthPx, heightPx, data: new Uint8Array(rowBytes(widthPx) * heightPx) }
}

export function getPixel(b: Bitmap, x: number, y: number): boolean {
  return (b.data[y * rowBytes(b.widthPx) + (x >> 3)] & (0x80 >> (x & 7))) !== 0
}

export function setPixel(b: Bitmap, x: number, y: number): void {
  b.data[y * rowBytes(b.widthPx) + (x >> 3)] |= 0x80 >> (x & 7)
}

/** RGBA pixels as returned by CanvasRenderingContext2D.getImageData. */
export interface RgbaImage {
  width: number
  height: number
  data: ArrayLike<number>
}

/**
 * Plain threshold (no dithering: dithered text is unreadable at 203 dpi). Luminance is computed in integers after
 * compositing on white, so transparent pixels are paper. A pixel is ink when luminance < threshold.
 */
export function thresholdToBitmap(img: RgbaImage, threshold = 128): Bitmap {
  const out = emptyBitmap(img.width, img.height)
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4
      const a = img.data[i + 3]
      const r = (img.data[i] * a + 255 * (255 - a)) / 255
      const g = (img.data[i + 1] * a + 255 * (255 - a)) / 255
      const bl = (img.data[i + 2] * a + 255 * (255 - a)) / 255
      const lum = (299 * r + 587 * g + 114 * bl) / 1000
      if (lum < threshold) setPixel(out, x, y)
    }
  }
  return out
}

/** Render a QR module matrix as a bitmap with a quiet zone, each module `moduleDots` square. */
export function matrixToBitmap(matrix: boolean[][], moduleDots: number, quietModules = 2): Bitmap {
  const n = matrix.length
  const size = (n + quietModules * 2) * moduleDots
  const out = emptyBitmap(size, size)
  for (let my = 0; my < n; my++) {
    for (let mx = 0; mx < n; mx++) {
      if (!matrix[my][mx]) continue
      for (let dy = 0; dy < moduleDots; dy++) {
        for (let dx = 0; dx < moduleDots; dx++) {
          setPixel(out, (mx + quietModules) * moduleDots + dx, (my + quietModules) * moduleDots + dy)
        }
      }
    }
  }
  return out
}
