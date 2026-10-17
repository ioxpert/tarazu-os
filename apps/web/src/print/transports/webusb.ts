import { NoPrinterError, writeChunked, type PrinterTransport } from './types'

/** The slice of WebUSB we use (lib.dom has no USB types). */
export interface UsbEndpointLike {
  endpointNumber: number
  direction: 'in' | 'out'
  type: 'bulk' | 'interrupt' | 'isochronous'
}
export interface UsbAlternateLike {
  alternateSetting: number
  interfaceClass: number
  endpoints: UsbEndpointLike[]
}
export interface UsbInterfaceLike {
  interfaceNumber: number
  alternates: UsbAlternateLike[]
}
export interface UsbDeviceLike {
  productName?: string
  opened: boolean
  configuration: { interfaces: UsbInterfaceLike[] } | null
  open(): Promise<void>
  close(): Promise<void>
  selectConfiguration(n: number): Promise<void>
  claimInterface(n: number): Promise<void>
  releaseInterface(n: number): Promise<void>
  selectAlternateInterface(iface: number, alt: number): Promise<void>
  transferOut(endpoint: number, data: Uint8Array): Promise<{ status: string; bytesWritten?: number }>
  clearHalt?(direction: 'in' | 'out', endpoint: number): Promise<void>
}
export interface UsbApiLike {
  getDevices(): Promise<UsbDeviceLike[]>
  requestDevice(o: { filters: Array<{ classCode?: number }> }): Promise<UsbDeviceLike>
}

const PRINTER_CLASS = 7
const VENDOR_CLASS = 255

export interface WebUsbOptions {
  usb?: UsbApiLike
  /** Bytes per transferOut (default 16384; 4096..65536 are safe). */
  chunkSize?: number
  sleep?: (ms: number) => Promise<void>
}

/** Pick the printer-class (7) interface with a bulk-OUT endpoint; fall back to vendor-specific (255) clones. */
export function findPrinterEndpoint(
  device: Pick<UsbDeviceLike, 'configuration'>,
): { interfaceNumber: number; alternateSetting: number; endpointNumber: number } | null {
  const ifaces = device.configuration?.interfaces ?? []
  for (const wanted of [PRINTER_CLASS, VENDOR_CLASS]) {
    for (const i of ifaces) {
      for (const a of i.alternates) {
        if (a.interfaceClass !== wanted) continue
        const ep = a.endpoints.find((e) => e.direction === 'out' && e.type === 'bulk')
        if (ep) return { interfaceNumber: i.interfaceNumber, alternateSetting: a.alternateSetting, endpointNumber: ep.endpointNumber }
      }
    }
  }
  return null
}

export class WebUsbTransport implements PrinterTransport {
  readonly kind = 'webusb' as const
  private device: UsbDeviceLike | null = null
  private ep: { interfaceNumber: number; endpointNumber: number } | null = null
  private connected = false
  constructor(private readonly o: WebUsbOptions = {}) {}

  get name(): string {
    return this.device?.productName ?? 'USB printer'
  }
  get isConnected(): boolean {
    return this.connected
  }
  private api(): UsbApiLike {
    const usb = this.o.usb ?? (globalThis.navigator as unknown as { usb?: UsbApiLike } | undefined)?.usb
    if (!usb) throw new NoPrinterError('WebUSB not available')
    return usb
  }

  async connect(): Promise<void> {
    if (this.connected) return
    const usb = this.api()
    if (!this.device) {
      const granted = (await usb.getDevices()).find((d) => findPrinterEndpoint(d) !== null || d.configuration === null)
      if (granted) this.device = granted
      else {
        try {
          this.device = await usb.requestDevice({ filters: [{ classCode: PRINTER_CLASS }] })
        } catch (e) {
          throw new NoPrinterError(e instanceof Error ? e.message : 'no printer selected')
        }
      }
    }
    const d = this.device
    if (!d.opened) await d.open()
    if (d.configuration === null) await d.selectConfiguration(1)
    const ep = findPrinterEndpoint(d)
    if (!ep) throw new Error('no bulk-out endpoint on a printer-class interface')
    await d.claimInterface(ep.interfaceNumber)
    if (ep.alternateSetting !== 0) await d.selectAlternateInterface(ep.interfaceNumber, ep.alternateSetting)
    this.ep = ep
    this.connected = true
  }

  async write(bytes: Uint8Array): Promise<void> {
    const d = this.device
    const ep = this.ep
    if (!this.connected || !d || !ep) throw new Error('printer not connected')
    await writeChunked(
      async (chunk) => {
        const r = await d.transferOut(ep.endpointNumber, chunk)
        if (r.status === 'stall' && d.clearHalt) await d.clearHalt('out', ep.endpointNumber)
        if (r.status !== 'ok') throw new Error(`USB transfer ${r.status}`)
      },
      bytes,
      { chunkSize: this.o.chunkSize ?? 16384, sleep: this.o.sleep },
    )
  }

  async disconnect(): Promise<void> {
    const d = this.device
    this.connected = false
    if (d && this.ep) {
      try {
        await d.releaseInterface(this.ep.interfaceNumber)
      } catch {
        /* already gone */
      }
    }
    if (d?.opened) {
      try {
        await d.close()
      } catch {
        /* already gone */
      }
    }
    this.ep = null
  }
}
