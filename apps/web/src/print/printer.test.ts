import { bigSale, dummyQr, hindiSale, plainSale } from './fixtures'
import { printReceipt } from './printer'
import { fakeDraw } from './testing'
import { NoPrinterError, type PrinterTransport } from './transports/types'

function fakeTransport(o: { connected?: boolean; connectError?: Error; writeError?: Error } = {}) {
  const writes: Uint8Array[] = []
  const t: PrinterTransport & { writes: Uint8Array[]; connects: number } = {
    kind: 'webusb', name: 'fake', isConnected: o.connected ?? true, writes, connects: 0,
    async connect() { t.connects++; if (o.connectError) throw o.connectError; (t as { isConnected: boolean }).isConnected = true },
    async write(b) { if (o.writeError) throw o.writeError; writes.push(b) },
    async disconnect() {},
  }
  return t
}

describe('printReceipt', () => {
  it('prints an all-Latin receipt as text', async () => {
    const t = fakeTransport()
    const r = await printReceipt({ data: plainSale, widthMm: 80, lang: 'en', transport: t })
    expect(r).toMatchObject({ ok: true, mode: 'text' })
    expect(t.writes).toHaveLength(1)
    expect(t.writes[0][0]).toBe(0x1b) // starts with ESC @
  })
  it('prints Hindi through the raster path', async () => {
    const t = fakeTransport()
    const r = await printReceipt({ data: hindiSale, widthMm: 58, lang: 'hi', transport: t, draw: fakeDraw })
    expect(r).toMatchObject({ ok: true, mode: 'raster' })
    expect([...t.writes[0].subarray(5, 8)]).toEqual([0x1d, 0x76, 0x30])
  })
  it('meets the print-start budget: 40-line bilingual raster receipt, bytes ready and first write < 1 s', async () => {
    const t = fakeTransport({ connected: false })
    const r = await printReceipt({ data: bigSale, widthMm: 80, lang: 'en+hi', transport: t, draw: fakeDraw, qrMatrix: dummyQr })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.mode).toBe('raster')
      expect(r.msBytesReady).toBeLessThan(1000)
      expect(r.msFirstWrite).toBeLessThan(1000)
      expect(t.writes).toHaveLength(1)
    }
  })
  it('reports failures with codes the UI can act on', async () => {
    expect(await printReceipt({ data: plainSale, widthMm: 58, lang: 'en', transport: null })).toMatchObject({ ok: false, code: 'no_printer' })
    expect(await printReceipt({ data: hindiSale, widthMm: 58, lang: 'hi', transport: fakeTransport() })).toMatchObject({ ok: false, code: 'not_supported' })
    expect(await printReceipt({ data: plainSale, widthMm: 58, lang: 'en', transport: fakeTransport({ connected: false, connectError: new NoPrinterError() }) })).toMatchObject({ ok: false, code: 'no_printer' })
    expect(await printReceipt({ data: plainSale, widthMm: 58, lang: 'en', transport: fakeTransport({ connected: false, connectError: new Error('busy') }) })).toMatchObject({ ok: false, code: 'transport_error' })
    expect(await printReceipt({ data: plainSale, widthMm: 58, lang: 'en', transport: fakeTransport({ writeError: new Error('pipe') }) })).toMatchObject({ ok: false, code: 'transport_error', message: 'pipe' })
  })
  it('never throws, even if the renderer does', async () => {
    const r = await printReceipt({ data: hindiSale, widthMm: 58, lang: 'hi', transport: fakeTransport(), draw: () => { throw new Error('canvas lost') } })
    expect(r).toMatchObject({ ok: false, code: 'not_supported' })
  })
  it('forceRaster rasterizes Latin receipts too', async () => {
    const r = await printReceipt({ data: plainSale, widthMm: 58, lang: 'en', transport: fakeTransport(), draw: fakeDraw, forceRaster: true })
    expect(r).toMatchObject({ ok: true, mode: 'raster' })
  })
})
