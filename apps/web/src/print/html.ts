import type { Block, Cell, ReceiptLayout } from './receipt'

/** Escape text for HTML element content and double/single-quoted attributes. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export interface HtmlOptions {
  /** Document <title>. */
  title?: string
  /** Return only the receipt <div> (+ <style>) instead of a full document. */
  fragment?: boolean
}

const FONT_STACK =
  '"Noto Sans Devanagari","Mangal","Nirmala UI","Lohit Devanagari","Kohinoor Devanagari",ui-monospace,"Courier New",monospace'

const CSS = (widthMm: number) => `
@page { size: ${widthMm}mm auto; margin: 0 }
html, body { margin: 0; padding: 0; background: #fff; color: #000 }
.rcpt { box-sizing: border-box; width: ${widthMm}mm; padding: 2mm ${widthMm === 80 ? 4 : 2}mm 6mm; font-family: ${FONT_STACK}; font-size: 10.5px; line-height: 1.35 }
.r { display: flex; white-space: pre-wrap; overflow-wrap: anywhere; min-height: 1.35em }
.r.b { font-weight: 700 }
.r.x2 { font-size: 2em; line-height: 1.2 }
.c { box-sizing: border-box; flex: none; overflow: hidden }
.l { text-align: left } .rt { text-align: right } .ct { text-align: center }
.rule { border-top: 1px dashed #000; margin: 0.4em 0 }
.rule.eq { border-top: 3px double #000 }
.qr { display: block; margin: 0.5em auto; width: 40mm; height: 40mm }
@media print { .rcpt { margin: 0 } }
`

function cell(c: Cell, rowWidth: number): string {
  const pct = ((c.width / rowWidth) * 100).toFixed(3)
  const al = c.align === 'right' ? 'rt' : c.align === 'center' ? 'ct' : 'l'
  return `<span class="c ${al}" style="width:${pct}%">${escapeHtml(c.text)}</span>`
}

/** QR as inline SVG: one path of unit squares merged into horizontal runs, with a 2-module quiet zone. */
export function qrSvg(matrix: boolean[][]): string {
  const n = matrix.length
  const q = 2
  let d = ''
  for (let y = 0; y < n; y++) {
    let x = 0
    while (x < n) {
      if (!matrix[y][x]) {
        x++
        continue
      }
      let run = 1
      while (x + run < n && matrix[y][x + run]) run++
      d += `M${x + q} ${y + q}h${run}v1h-${run}z`
      x += run
    }
  }
  const s = n + q * 2
  return `<svg class="qr" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${s}" height="${s}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`
}

function block(b: Block, layout: ReceiptLayout): string {
  if (b.kind === 'row') {
    const rowWidth = Math.floor(layout.cols / b.scale)
    return `<div class="r${b.bold ? ' b' : ''}${b.scale === 2 ? ' x2' : ''}">${b.cells.map((c) => cell(c, rowWidth)).join('')}</div>`
  }
  if (b.kind === 'rule') return `<div class="rule${b.char === '=' ? ' eq' : ''}"></div>`
  if (b.kind === 'qr') return qrSvg(b.matrix)
  return `<div style="height:${b.lines * 1.35}em"></div>`
}

/** Self-contained printable receipt (80 mm or 58 mm). Every piece of user text goes through escapeHtml. */
export function renderReceiptHtml(layout: ReceiptLayout, opts: HtmlOptions = {}): string {
  const body = `<div class="rcpt">${layout.blocks.map((b) => block(b, layout)).join('')}</div>`
  const style = `<style>${CSS(layout.widthMm)}</style>`
  if (opts.fragment) return style + body
  return `<!doctype html><html lang="${layout.lang === 'en' ? 'en' : 'hi'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(opts.title ?? 'Receipt')}</title>${style}</head><body>${body}</body></html>`
}

/** The slice of the DOM printHtml needs, injectable for tests. */
export interface PrintDeps {
  document?: {
    createElement(tag: 'iframe'): IframeLike
    body: { appendChild(e: IframeLike): unknown; removeChild(e: IframeLike): unknown }
  }
  setTimeout?: (fn: () => void, ms: number) => unknown
  /** Remove the iframe after this long even if afterprint never fires (default 60 s). */
  cleanupMs?: number
}
export interface IframeLike {
  style: { cssText: string }
  srcdoc: string
  onload: (() => void) | null
  contentWindow: { focus(): void; print(): void; onafterprint: (() => void) | null } | null
  parentNode?: unknown
}

/** Print an HTML string through a hidden iframe. Call from a user gesture. Resolves when the print dialog was invoked. */
export function printHtml(html: string, deps: PrintDeps = {}): Promise<void> {
  const doc = deps.document ?? (globalThis.document as unknown as NonNullable<PrintDeps['document']>)
  const later = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
  return new Promise<void>((resolve, reject) => {
    const frame = doc.createElement('iframe')
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
    let removed = false
    const cleanup = () => {
      if (removed) return
      removed = true
      try {
        doc.body.removeChild(frame)
      } catch {
        /* already detached */
      }
    }
    frame.onload = () => {
      const w = frame.contentWindow
      if (!w) {
        cleanup()
        reject(new Error('print frame unavailable'))
        return
      }
      try {
        w.onafterprint = cleanup
        w.focus()
        w.print()
        later(cleanup, deps.cleanupMs ?? 60000)
        resolve()
      } catch (e) {
        cleanup()
        reject(e instanceof Error ? e : new Error('print failed'))
      }
    }
    frame.srcdoc = html
    doc.body.appendChild(frame)
  })
}
