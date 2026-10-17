import { rowBytes, type Bitmap } from './bitmap'

/**
 * Minimal single-page PDF holding the receipt as a 1-bit DeviceGray image XObject. Because the glyphs are already
 * pixels (rendered with system fonts), Hindi shows correctly with no font embedding. Dependency-free.
 */
export interface PdfOptions {
  /** Paper width in mm; the page is this wide and as tall as the bitmap's aspect ratio needs. Default: bitmap at 203 dpi. */
  widthMm?: number
  title?: string
  /** Override compression (tests). Return null to store uncompressed. Default: CompressionStream('deflate') if present. */
  compress?: (data: Uint8Array) => Promise<Uint8Array | null>
}

const enc = new TextEncoder()

export async function deflate(data: Uint8Array): Promise<Uint8Array | null> {
  const CS = (globalThis as { CompressionStream?: new (f: 'deflate') => { writable: WritableStream<Uint8Array>; readable: ReadableStream<Uint8Array> } }).CompressionStream
  if (!CS) return null
  try {
    const cs = new CS('deflate') // zlib wrapper, which is what FlateDecode expects
    const writer = cs.writable.getWriter()
    void writer.write(data).then(() => writer.close())
    const buf = await new Response(cs.readable).arrayBuffer()
    return new Uint8Array(buf)
  } catch {
    return null
  }
}

const num = (n: number) => n.toFixed(2).replace(/\.?0+$/, '')

function pdfString(s: string): string {
  // PDF literal string, ASCII only (non-ASCII dropped: the title is cosmetic)
  return '(' + s.replace(/[^\x20-\x7e]/g, '').replace(/([\\()])/g, '\\$1') + ')'
}

export async function buildReceiptPdf(bitmap: Bitmap, opts: PdfOptions = {}): Promise<Uint8Array> {
  const { widthPx, heightPx } = bitmap
  const wPt = opts.widthMm !== undefined ? (opts.widthMm / 25.4) * 72 : (widthPx / 203) * 72
  const hPt = (heightPx / widthPx) * wPt
  // 1-bit DeviceGray: 0 = black, 1 = white, so invert the ink bitmap (padding bits become white)
  const stride = rowBytes(widthPx)
  const raw = new Uint8Array(bitmap.data.length)
  for (let i = 0; i < raw.length; i++) raw[i] = ~bitmap.data[i] & 0xff
  const compressed = await (opts.compress ?? deflate)(raw)
  const imgData = compressed ?? raw
  if (stride * heightPx !== raw.length) throw new Error('bitmap data size does not match its dimensions')

  const content = enc.encode(`q ${num(wPt)} 0 0 ${num(hPt)} 0 0 cm /Im0 Do Q\n`)
  const chunks: Uint8Array[] = []
  const offsets: number[] = []
  let pos = 0
  const push = (b: Uint8Array | string) => {
    const bytes = typeof b === 'string' ? enc.encode(b) : b
    chunks.push(bytes)
    pos += bytes.length
  }
  const obj = (n: number, body: string, stream?: Uint8Array) => {
    offsets[n] = pos
    push(`${n} 0 obj\n${body}`)
    if (stream) {
      push('\nstream\n')
      push(stream)
      push('\nendstream')
    }
    push('\nendobj\n')
  }

  push('%PDF-1.4\n')
  push(Uint8Array.of(0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a)) // binary marker comment
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  obj(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(wPt)} ${num(hPt)}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`,
  )
  obj(4, `<< /Length ${content.length} >>`, content)
  obj(
    5,
    `<< /Type /XObject /Subtype /Image /Width ${widthPx} /Height ${heightPx} /ColorSpace /DeviceGray /BitsPerComponent 1 ${compressed ? '/Filter /FlateDecode ' : ''}/Length ${imgData.length} >>`,
    imgData,
  )
  obj(6, `<< /Title ${pdfString(opts.title ?? 'Receipt')} /Producer (Tarazu OS) >>`)
  const xref = pos
  let table = `xref\n0 7\n0000000000 65535 f \n`
  for (let n = 1; n <= 6; n++) table += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`
  push(table + `trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`)

  const out = new Uint8Array(pos)
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return out
}
