import type { ReceiptData } from '../billing/types'
import { encodeReceiptRaster, encodeReceiptText, layoutNeedsRaster, type Codepage } from './escpos'
import { rasterizeLayout, type DrawFn } from './rasterize'
import { buildReceiptLayout, type ReceiptLayout, type ReceiptOptions } from './receipt'
import { NoPrinterError, type PrinterTransport } from './transports/types'

export type PrintFailure = 'no_printer' | 'transport_error' | 'not_supported'

export type PrintResult =
  | { ok: true; mode: 'text' | 'raster'; bytes: number; msBytesReady: number; msFirstWrite: number; layout: ReceiptLayout }
  | { ok: false; code: PrintFailure; message: string; layout: ReceiptLayout }

export interface PrintJob extends ReceiptOptions {
  data: ReceiptData
  /** Null/undefined when no printer is configured. */
  transport?: PrinterTransport | null
  /** Painter for the raster path (app: createCanvasDraw(...)). Without it, non-Latin receipts are 'not_supported'. */
  draw?: DrawFn
  codepage?: Codepage
  /** Force raster even for all-Latin text (e.g. a printer with a broken code page). */
  forceRaster?: boolean
  now?: () => number
}

/**
 * Build, encode and send a receipt. Never throws: the UI switches on `code` and offers the CSS print fallback
 * (print/html.ts) for every failure. The commit path never waits on this (rule 1): call it after the sale is saved.
 */
export async function printReceipt(job: PrintJob): Promise<PrintResult> {
  const now = job.now ?? (() => performance.now())
  const t0 = now()
  const layout = buildReceiptLayout(job.data, job)
  const fail = (code: PrintFailure, message: string): PrintResult => ({ ok: false, code, message, layout })

  if (!job.transport) return fail('no_printer', 'no printer configured')

  const raster = job.forceRaster === true || layoutNeedsRaster(layout)
  let bytes: Uint8Array
  try {
    if (raster) {
      if (!job.draw) return fail('not_supported', 'receipt needs a bitmap but no renderer is available')
      bytes = encodeReceiptRaster(await rasterizeLayout(layout, job.draw))
    } else {
      bytes = encodeReceiptText(layout, { codepage: job.codepage })
    }
  } catch (e) {
    return fail('not_supported', e instanceof Error ? e.message : 'could not encode receipt')
  }
  const tReady = now()

  const transport = job.transport
  try {
    if (!transport.isConnected) await transport.connect()
  } catch (e) {
    if (e instanceof NoPrinterError) return fail('no_printer', e.message)
    return fail('transport_error', e instanceof Error ? e.message : 'could not connect to printer')
  }
  try {
    const tFirst = now()
    await transport.write(bytes)
    return { ok: true, mode: raster ? 'raster' : 'text', bytes: bytes.length, msBytesReady: tReady - t0, msFirstWrite: tFirst - t0, layout }
  } catch (e) {
    return fail('transport_error', e instanceof Error ? e.message : 'write failed')
  }
}
