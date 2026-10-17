import type { ReceiptData } from '../billing/types'
import { getJson, setJson } from '../billing/settings'
import { qrMatrix } from '../billing/qr'
import type { LocalDb } from '../sync/schemaDb'
import type { ReceiptLang } from '../print/labels'
import type { TransportKind, PrinterTransport } from '../print/transports/types'

/**
 * Glue between the screens and the print module. The print module (ESC/POS, rasteriser, PDF, transports) is
 * imported on demand so none of it is in first-load JS; a sale never waits on any of it (rule 1).
 */
export interface PrinterSettings {
  kind: TransportKind | null
  widthMm: 58 | 80
  lang: ReceiptLang
  autoPrint: boolean
  /** Name shown in settings (e.g. the USB product name) */
  name: string | null
}

export const DEFAULT_PRINTER: PrinterSettings = { kind: null, widthMm: 80, lang: 'en', autoPrint: false, name: null }

export async function loadPrinterSettings(db: Pick<LocalDb, 'getAll'>): Promise<PrinterSettings> {
  return { ...DEFAULT_PRINTER, ...((await getJson<Partial<PrinterSettings>>(db, 'printer')) ?? {}) }
}
export const savePrinterSettings = (db: LocalDb, s: PrinterSettings) => setJson(db, 'printer', s)

let transport: PrinterTransport | null = null

/** Opens the browser chooser (needs a click) and remembers the transport for this session. */
export async function connectPrinter(kind: TransportKind): Promise<PrinterTransport> {
  const { createTransport } = await import('../print/transports')
  if (!transport || transport.kind !== kind) transport = createTransport(kind)
  await transport.connect()
  return transport
}

export async function getTransport(kind: TransportKind | null): Promise<PrinterTransport | null> {
  if (!kind) return null
  if (transport && transport.kind === kind) return transport
  const { createTransport } = await import('../print/transports')
  transport = createTransport(kind)
  return transport
}

export function canvasDraw() {
  return import('../print/rasterize').then(({ createCanvasDraw }) =>
    createCanvasDraw((w, h) => {
      if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h) as never
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      return c as never
    }),
  )
}

export interface ReceiptQr {
  matrix: boolean[][] | undefined
  data: string | undefined
}

export function receiptQr(upiUri: string | null): ReceiptQr {
  return upiUri ? { matrix: qrMatrix(upiUri), data: upiUri } : { matrix: undefined, data: undefined }
}

export async function printToDevice(data: ReceiptData, upiUri: string | null, s: PrinterSettings) {
  const [{ printReceipt }, tr, draw] = await Promise.all([import('../print/printer'), getTransport(s.kind), canvasDraw()])
  const qr = receiptQr(upiUri)
  return printReceipt({
    data,
    transport: tr,
    draw,
    widthMm: s.widthMm,
    lang: s.lang,
    qrMatrix: qr.matrix,
    qrData: qr.data,
    staticQr: data.creditPaise === 0,
    qrAmountPaise: data.creditPaise > 0 ? data.creditPaise : undefined,
  })
}

/** 80 mm (or 58 mm) CSS print: works on any printer the OS knows, and "Save as PDF" in the print dialog. */
export async function printWithBrowser(data: ReceiptData, upiUri: string | null, s: PrinterSettings): Promise<void> {
  const [{ buildReceiptLayout }, { renderReceiptHtml, printHtml }] = await Promise.all([import('../print/receipt'), import('../print/html')])
  const qr = receiptQr(upiUri)
  const layout = buildReceiptLayout(data, {
    widthMm: s.widthMm,
    lang: s.lang,
    qrMatrix: qr.matrix,
    qrData: qr.data,
    staticQr: data.creditPaise === 0,
    qrAmountPaise: data.creditPaise > 0 ? data.creditPaise : undefined,
  })
  await printHtml(renderReceiptHtml(layout, { title: data.label }))
}

export async function receiptPdf(data: ReceiptData, upiUri: string | null, s: PrinterSettings): Promise<Blob> {
  const [{ buildReceiptLayout }, { rasterizeLayout }, { buildReceiptPdf }, draw] = await Promise.all([
    import('../print/receipt'),
    import('../print/rasterize'),
    import('../print/pdf'),
    canvasDraw(),
  ])
  const qr = receiptQr(upiUri)
  const layout = buildReceiptLayout(data, { widthMm: s.widthMm, lang: s.lang, qrMatrix: qr.matrix, qrData: qr.data, staticQr: data.creditPaise === 0 })
  const bytes = await buildReceiptPdf(await rasterizeLayout(layout, draw), { widthMm: s.widthMm, title: data.label })
  return new Blob([bytes as BlobPart], { type: 'application/pdf' })
}

export async function receiptPreviewLines(data: ReceiptData, s: PrinterSettings): Promise<string[]> {
  const [{ buildReceiptLayout, layoutLines }] = await Promise.all([import('../print/receipt')])
  return layoutLines(buildReceiptLayout(data, { widthMm: s.widthMm, lang: s.lang }))
}
