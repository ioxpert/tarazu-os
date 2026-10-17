import { compositionBill, dummyQr, hindiSale, plainSale, splitCreditSale } from './fixtures'
import { escapeHtml, printHtml, qrSvg, renderReceiptHtml, type IframeLike } from './html'
import { buildReceiptLayout } from './receipt'

describe('renderReceiptHtml', () => {
  it('renders a self-contained 80 mm document', () => {
    const html = renderReceiptHtml(buildReceiptLayout(plainSale, { widthMm: 80, lang: 'en' }))
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('@page { size: 80mm auto; margin: 0 }')
    expect(html).toContain('Sharma General Store')
    expect(html).toContain('Noto Sans Devanagari')
    expect(html).not.toMatch(/<script|src=|href=/)
  })
  it('uses the 58 mm page size and supports fragments', () => {
    const frag = renderReceiptHtml(buildReceiptLayout(compositionBill, { widthMm: 58, lang: 'en' }), { fragment: true })
    expect(frag).toContain('size: 58mm auto')
    expect(frag).not.toContain('<html')
  })
  it('embeds the QR as inline SVG', () => {
    const html = renderReceiptHtml(buildReceiptLayout(splitCreditSale, { widthMm: 80, lang: 'en', qrMatrix: dummyQr }))
    expect(html).toContain('<svg class="qr"')
    expect(html).toContain('viewBox="0 0 29 29"')
    const area = (qrSvg(dummyQr).match(/h(\d+)v1/g) ?? []).reduce((s, m) => s + Number(m.slice(1, -2)), 0)
    expect(area).toBe(dummyQr.flat().filter(Boolean).length)
  })
  it('renders Hindi text as-is, escaped', () => {
    expect(renderReceiptHtml(buildReceiptLayout(hindiSale, { widthMm: 80, lang: 'hi' }))).toContain('आशीर्वाद आटा 5 किलो')
  })
  it('never injects user text unescaped (XSS)', () => {
    const evil = '<script>alert(1)</script><img src=x onerror=alert(2)>"\'&'
    const data = {
      ...plainSale,
      business: { ...plainSale.business, businessName: evil, address: evil },
      customerName: evil,
      lines: [{ ...plainSale.lines[0], name: evil, localName: evil }],
    }
    for (const lang of ['en', 'en+hi', 'hi'] as const) {
      const html = renderReceiptHtml(buildReceiptLayout(data, { widthMm: 80, lang }), { title: evil })
      expect(html).not.toContain('<script')
      expect(html).not.toContain('<img')
      expect(html).toContain('&lt;script&gt;')
      expect(html).not.toMatch(/onerror=alert\(2\)>/)
    }
    expect(escapeHtml(`<a href="x">'&`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;')
  })
})

describe('printHtml', () => {
  function fakeDoc() {
    const frames: Array<IframeLike & { printed: number; focused: number }> = []
    const removed: unknown[] = []
    const document = {
      createElement: () => {
        const f = {
          style: { cssText: '' }, srcdoc: '', onload: null as (() => void) | null, parentNode: undefined,
          printed: 0, focused: 0,
          contentWindow: { focus() { f.focused++ }, print() { f.printed++ }, onafterprint: null as (() => void) | null },
        }
        frames.push(f)
        return f as IframeLike & { printed: number; focused: number }
      },
      body: { appendChild: () => {}, removeChild: (e: unknown) => void removed.push(e) },
    }
    return { document, frames, removed }
  }
  it('prints through a hidden iframe once it has loaded, then cleans up', async () => {
    const { document, frames, removed } = fakeDoc()
    const timers: Array<() => void> = []
    const p = printHtml('<p>hi</p>', { document, setTimeout: (fn) => void timers.push(fn) })
    const f = frames[0]
    expect(f.srcdoc).toBe('<p>hi</p>')
    expect(f.style.cssText).toContain('visibility:hidden')
    expect(f.printed).toBe(0)
    f.onload!()
    await p
    expect(f.printed).toBe(1)
    expect(removed).toHaveLength(0)
    f.contentWindow!.onafterprint!()
    timers[0]() // the safety timer after afterprint is a no-op
    expect(removed).toHaveLength(1)
  })
  it('rejects and cleans up when printing throws', async () => {
    const { document, frames, removed } = fakeDoc()
    const p = printHtml('x', { document })
    frames[0].contentWindow!.print = () => { throw new Error('blocked') }
    frames[0].onload!()
    await expect(p).rejects.toThrow('blocked')
    expect(removed).toHaveLength(1)
  })
})
