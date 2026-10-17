import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setPixel, emptyBitmap } from './bitmap'
import { hindiSale } from './fixtures'
import { buildReceiptPdf } from './pdf'
import { rasterizeLayout } from './rasterize'
import { buildReceiptLayout } from './receipt'
import { fakeDraw } from './testing'

const latin1 = (b: Uint8Array) => Buffer.from(b).toString('latin1')

async function sample() {
  return rasterizeLayout(buildReceiptLayout(hindiSale, { widthMm: 80, lang: 'en+hi' }), fakeDraw)
}

describe('buildReceiptPdf', () => {
  for (const compress of [true, false]) {
    it(`is structurally valid (${compress ? 'Flate' : 'uncompressed'})`, async () => {
      const bm = await sample()
      const pdf = await buildReceiptPdf(bm, { widthMm: 80, compress: compress ? undefined : async () => null })
      const s = latin1(pdf)
      expect(s.startsWith('%PDF-1.4\n')).toBe(true)
      expect(s.endsWith('%%EOF\n')).toBe(true)
      expect(s).toContain('/ColorSpace /DeviceGray /BitsPerComponent 1')
      expect(s.includes('/FlateDecode')).toBe(compress)
      // startxref points at the xref table; every entry points at "N 0 obj"
      const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(s)![1])
      expect(s.slice(startxref, startxref + 4)).toBe('xref')
      const entries = [...s.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)]
      expect(entries).toHaveLength(6)
      entries.forEach((m, i) => expect(s.slice(Number(m[1]), Number(m[1]) + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`))
      expect(s).toContain('trailer\n<< /Size 7 /Root 1 0 R')
      // page size = 80 mm wide, height from the bitmap aspect
      const mb = /MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(s)!
      expect(Number(mb[1])).toBeCloseTo((80 / 25.4) * 72, 1)
      expect(Number(mb[2])).toBeCloseTo((bm.heightPx / bm.widthPx) * Number(mb[1]), 0)
      // declared stream length matches the bytes between stream/endstream
      const m = /\/Length (\d+) >>\nstream\n/.exec(s.slice(s.indexOf('/Subtype /Image')))!
      const start = s.indexOf('stream\n', s.indexOf('/Subtype /Image')) + 7
      expect(s.slice(start + Number(m[1]), start + Number(m[1]) + 10)).toBe('\nendstream')
    })
  }

  it('compresses a mostly-white receipt well', async () => {
    const bm = await sample()
    const flate = await buildReceiptPdf(bm)
    const raw = await buildReceiptPdf(bm, { compress: async () => null })
    expect(flate.length).toBeLessThan(raw.length / 3)
  })

  it('opens in real PDF tools when available (pdfinfo / pypdf)', async () => {
    const bm = emptyBitmap(16, 16)
    setPixel(bm, 0, 0)
    const dir = mkdtempSync(join(tmpdir(), 'tarazu-pdf-'))
    const file = join(dir, 'r.pdf')
    writeFileSync(file, await buildReceiptPdf(await sample(), { widthMm: 80 }))
    let validated = 0
    if (spawnSync('pdfinfo', ['-v']).error === undefined) {
      const out = execFileSync('pdfinfo', [file]).toString()
      expect(out).toMatch(/Pages:\s+1/)
      expect(out).toMatch(/Page size:\s+226\.77 x/)
      validated++
    }
    const py = spawnSync('python3', ['-I', '-c', 'import pypdf,sys; r=pypdf.PdfReader(sys.argv[1]); p=r.pages[0]; print(len(r.pages), round(float(p.mediabox.width)))', file])
    if (py.status === 0) {
      expect(py.stdout.toString().trim()).toBe('1 227')
      validated++
    }
    if (validated === 0) console.warn('no pdfinfo/pypdf available: structural checks only')
  })
})
