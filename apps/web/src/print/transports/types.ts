export type TransportKind = 'webusb' | 'webserial' | 'webbluetooth'

export interface PrinterTransport {
  readonly kind: TransportKind
  /** Human label, e.g. the device name. */
  readonly name: string
  readonly isConnected: boolean
  /**
   * Open the printer. Re-opens a previously granted device silently when there is one; otherwise shows the browser
   * chooser, which REQUIRES a user gesture (call from a click handler).
   */
  connect(): Promise<void>
  write(bytes: Uint8Array): Promise<void>
  disconnect(): Promise<void>
}

/** Thrown by connect() when no device is available or the user dismissed the chooser. */
export class NoPrinterError extends Error {
  constructor(message = 'no printer selected') {
    super(message)
    this.name = 'NoPrinterError'
  }
}

export interface ChunkOptions {
  chunkSize: number
  /** Pause between chunks (BLE printers drop data when flooded). */
  delayMs?: number
  /** Extra attempts per chunk after a failure (default 1). */
  retries?: number
  sleep?: (ms: number) => Promise<void>
  /** Called before a retry, e.g. to reconnect. If it throws, the write fails. */
  beforeRetry?: (error: unknown) => Promise<void>
}

export const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Send bytes in order in chunks; a failed chunk is retried (it was not delivered) and the next never overtakes it. */
export async function writeChunked(send: (chunk: Uint8Array) => Promise<void>, bytes: Uint8Array, o: ChunkOptions): Promise<void> {
  if (o.chunkSize < 1) throw new RangeError('chunkSize must be >= 1')
  const retries = o.retries ?? 1
  const sleep = o.sleep ?? realSleep
  for (let i = 0; i < bytes.length; i += o.chunkSize) {
    const chunk = bytes.subarray(i, Math.min(bytes.length, i + o.chunkSize))
    for (let attempt = 0; ; attempt++) {
      try {
        await send(chunk)
        break
      } catch (e) {
        if (attempt >= retries) throw e
        if (o.beforeRetry) await o.beforeRetry(e)
      }
    }
    if (o.delayMs && i + o.chunkSize < bytes.length) await sleep(o.delayMs)
  }
}
