import { NoPrinterError, writeChunked, type PrinterTransport } from './types'

/** GATT services common thermal printers expose their write characteristic on. */
export const PRINTER_SERVICES = [
  '0000ff00-0000-1000-8000-00805f9b34fb',
  '0000fee7-0000-1000-8000-00805f9b34fb',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',
  '000018f0-0000-1000-8000-00805f9b34fb',
] as const

export interface BleCharacteristicLike {
  properties: { write: boolean; writeWithoutResponse: boolean }
  writeValueWithoutResponse?(v: Uint8Array): Promise<void>
  writeValue?(v: Uint8Array): Promise<void>
}
export interface BleServiceLike {
  getCharacteristics(): Promise<BleCharacteristicLike[]>
}
export interface BleServerLike {
  connected: boolean
  getPrimaryServices(): Promise<BleServiceLike[]>
  disconnect(): void
}
export interface BleDeviceLike {
  name?: string
  gatt: { connected: boolean; connect(): Promise<BleServerLike> } | null
  addEventListener(type: 'gattserverdisconnected', l: () => void): void
  removeEventListener(type: 'gattserverdisconnected', l: () => void): void
}
export interface BluetoothApiLike {
  getDevices?(): Promise<BleDeviceLike[]>
  requestDevice(o: { acceptAllDevices: true; optionalServices: string[] }): Promise<BleDeviceLike>
}

export interface WebBluetoothOptions {
  bluetooth?: BluetoothApiLike
  /** Max bytes per GATT write (default 100; the default MTU allows 20, modern phones negotiate more). */
  chunkSize?: number
  delayMs?: number
  sleep?: (ms: number) => Promise<void>
}

export class WebBluetoothTransport implements PrinterTransport {
  readonly kind = 'webbluetooth' as const
  private device: BleDeviceLike | null = null
  private server: BleServerLike | null = null
  private char: BleCharacteristicLike | null = null
  private connected = false
  private readonly onDrop = () => {
    this.connected = false
    this.char = null
  }
  constructor(private readonly o: WebBluetoothOptions = {}) {}

  get name(): string {
    return this.device?.name ?? 'Bluetooth printer'
  }
  get isConnected(): boolean {
    return this.connected
  }

  private async open(): Promise<void> {
    const gatt = this.device?.gatt
    if (!gatt) throw new Error('device has no GATT server')
    const server = await gatt.connect()
    let found: BleCharacteristicLike | null = null
    for (const svc of await server.getPrimaryServices()) {
      for (const c of await svc.getCharacteristics()) {
        if (c.properties.writeWithoutResponse || c.properties.write) {
          found = c
          break
        }
      }
      if (found) break
    }
    if (!found) throw new Error('no writable characteristic found')
    this.server = server
    this.char = found
    this.connected = true
  }

  async connect(): Promise<void> {
    if (this.connected) return
    const ble = this.o.bluetooth ?? (globalThis.navigator as unknown as { bluetooth?: BluetoothApiLike } | undefined)?.bluetooth
    if (!ble) throw new NoPrinterError('Web Bluetooth not available')
    if (!this.device) {
      const granted = ble.getDevices ? (await ble.getDevices())[0] : undefined
      if (granted) this.device = granted
      else {
        try {
          this.device = await ble.requestDevice({ acceptAllDevices: true, optionalServices: [...PRINTER_SERVICES] })
        } catch (e) {
          throw new NoPrinterError(e instanceof Error ? e.message : 'no printer selected')
        }
      }
      this.device.addEventListener('gattserverdisconnected', this.onDrop)
    }
    await this.open()
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (!this.device) throw new Error('printer not connected')
    let reconnected = false
    await writeChunked(
      async (chunk) => {
        if (!this.connected || !this.char) throw new Error('GATT disconnected')
        const c = this.char
        if (c.properties.writeWithoutResponse && c.writeValueWithoutResponse) await c.writeValueWithoutResponse(chunk)
        else if (c.writeValue) await c.writeValue(chunk)
        else throw new Error('characteristic is not writable')
      },
      bytes,
      {
        chunkSize: this.o.chunkSize ?? 100,
        delayMs: this.o.delayMs ?? 20,
        sleep: this.o.sleep,
        retries: 1,
        // reconnect once per print job on a GATT drop, then retry the chunk that was not delivered
        beforeRetry: async (e) => {
          if (reconnected) throw e
          reconnected = true
          this.connected = false
          await this.open()
        },
      },
    )
  }

  async disconnect(): Promise<void> {
    this.connected = false
    try {
      this.server?.disconnect()
    } catch {
      /* ignore */
    }
    this.char = null // the granted device is kept so a later connect() reuses it
  }
}
