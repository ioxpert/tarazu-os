import { NoPrinterError, writeChunked, type PrinterTransport } from './types'

export interface SerialPortLike {
  readable: unknown
  writable: { getWriter(): { ready: Promise<void>; write(chunk: Uint8Array): Promise<void>; releaseLock(): void } } | null
  open(o: { baudRate: number }): Promise<void>
  close(): Promise<void>
}
export interface SerialApiLike {
  getPorts(): Promise<SerialPortLike[]>
  requestPort(o?: object): Promise<SerialPortLike>
}

export interface WebSerialOptions {
  serial?: SerialApiLike
  /** 9600 for most RS-232/USB-serial printers, 115200 for fast ones. */
  baudRate?: number
  chunkSize?: number
  sleep?: (ms: number) => Promise<void>
}

export class WebSerialTransport implements PrinterTransport {
  readonly kind = 'webserial' as const
  private port: SerialPortLike | null = null
  private writer: ReturnType<NonNullable<SerialPortLike['writable']>['getWriter']> | null = null
  private connected = false
  constructor(private readonly o: WebSerialOptions = {}) {}

  get name(): string {
    return `Serial printer @${this.o.baudRate ?? 9600}`
  }
  get isConnected(): boolean {
    return this.connected
  }

  async connect(): Promise<void> {
    if (this.connected) return
    const serial = this.o.serial ?? (globalThis.navigator as unknown as { serial?: SerialApiLike } | undefined)?.serial
    if (!serial) throw new NoPrinterError('Web Serial not available')
    if (!this.port) {
      const [granted] = await serial.getPorts()
      if (granted) this.port = granted
      else {
        try {
          this.port = await serial.requestPort()
        } catch (e) {
          throw new NoPrinterError(e instanceof Error ? e.message : 'no printer selected')
        }
      }
    }
    await this.port.open({ baudRate: this.o.baudRate ?? 9600 })
    if (!this.port.writable) throw new Error('serial port is not writable')
    this.writer = this.port.writable.getWriter()
    this.connected = true
  }

  async write(bytes: Uint8Array): Promise<void> {
    const w = this.writer
    if (!this.connected || !w) throw new Error('printer not connected')
    await writeChunked(
      async (chunk) => {
        await w.ready
        await w.write(chunk)
      },
      bytes,
      { chunkSize: this.o.chunkSize ?? 1024, sleep: this.o.sleep },
    )
  }

  async disconnect(): Promise<void> {
    this.connected = false
    try {
      this.writer?.releaseLock()
    } catch {
      /* ignore */
    }
    this.writer = null
    try {
      await this.port?.close()
    } catch {
      /* ignore */
    }
  }
}
