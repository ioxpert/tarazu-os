import fc from 'fast-check'
import { availableTransports, createTransport, NoPrinterError, writeChunked } from './index'
import { WebBluetoothTransport, PRINTER_SERVICES, type BleCharacteristicLike, type BleDeviceLike } from './webbluetooth'
import { WebSerialTransport, type SerialPortLike } from './webserial'
import { WebUsbTransport, findPrinterEndpoint, type UsbDeviceLike } from './webusb'

const noSleep = async () => {}
const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 251)
const joined = (chunks: Uint8Array[]) => Uint8Array.from(chunks.flatMap((c) => [...c]))

describe('writeChunked', () => {
  it('keeps order, respects chunk size, sleeps between chunks only', async () => {
    const got: Uint8Array[] = []
    const sleeps: number[] = []
    await writeChunked(async (c) => void got.push(c.slice()), bytes(250), { chunkSize: 100, delayMs: 7, sleep: async (ms) => void sleeps.push(ms) })
    expect(got.map((c) => c.length)).toEqual([100, 100, 50])
    expect(joined(got)).toEqual(bytes(250))
    expect(sleeps).toEqual([7, 7])
  })
  it('retries a failed chunk once without reordering, then gives up', async () => {
    let calls = 0
    const got: number[] = []
    await writeChunked(
      async (c) => {
        calls++
        if (calls === 2) throw new Error('flaky')
        got.push(c.length)
      },
      bytes(30),
      { chunkSize: 10, sleep: noSleep },
    )
    expect(got).toEqual([10, 10, 10])
    expect(calls).toBe(4)
    await expect(writeChunked(async () => { throw new Error('dead') }, bytes(5), { chunkSize: 10, sleep: noSleep })).rejects.toThrow('dead')
  })
  it('beforeRetry failure aborts', async () => {
    await expect(
      writeChunked(async () => { throw new Error('x') }, bytes(5), { chunkSize: 5, beforeRetry: async () => { throw new Error('no reconnect') } }),
    ).rejects.toThrow('no reconnect')
  })
  it('property: concatenated chunks equal the input for any size', () =>
    fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 600 }), fc.integer({ min: 1, max: 130 }), async (n, size) => {
        const got: Uint8Array[] = []
        await writeChunked(async (c) => void got.push(c.slice()), bytes(n), { chunkSize: size, sleep: noSleep })
        return got.every((c) => c.length <= size && c.length > 0) && joined(got).length === n
      }),
    ))
})

describe('availableTransports', () => {
  it('detects by feature', () => {
    expect(availableTransports({})).toEqual([])
    expect(availableTransports({ usb: {}, bluetooth: {} })).toEqual(['webusb', 'webbluetooth'])
    expect(availableTransports({ usb: {}, serial: {}, bluetooth: {} })).toEqual(['webusb', 'webserial', 'webbluetooth'])
    expect(availableTransports(undefined)).toBeInstanceOf(Array)
  })
  it('creates the right class', () => {
    expect(createTransport('webusb').kind).toBe('webusb')
    expect(createTransport('webserial').kind).toBe('webserial')
    expect(createTransport('webbluetooth').kind).toBe('webbluetooth')
  })
})

function fakeUsbDevice(log: string[], opts: { fail?: number } = {}): UsbDeviceLike {
  let failures = opts.fail ?? 0
  const d: UsbDeviceLike = {
    productName: 'POS-80',
    opened: false,
    configuration: null,
    open: async () => { d.opened = true; log.push('open') },
    close: async () => { d.opened = false; log.push('close') },
    selectConfiguration: async (n) => {
      log.push(`config ${n}`)
      d.configuration = {
        interfaces: [
          { interfaceNumber: 0, alternates: [{ alternateSetting: 0, interfaceClass: 3, endpoints: [{ endpointNumber: 1, direction: 'in', type: 'interrupt' }] }] },
          { interfaceNumber: 1, alternates: [{ alternateSetting: 0, interfaceClass: 7, endpoints: [{ endpointNumber: 2, direction: 'in', type: 'bulk' }, { endpointNumber: 3, direction: 'out', type: 'bulk' }] }] },
        ],
      }
    },
    claimInterface: async (n) => void log.push(`claim ${n}`),
    releaseInterface: async (n) => void log.push(`release ${n}`),
    selectAlternateInterface: async () => {},
    transferOut: async (ep, data) => {
      if (failures > 0) { failures--; return { status: 'stall' } }
      log.push(`out ${ep} ${data.length}`)
      return { status: 'ok', bytesWritten: data.length }
    },
    clearHalt: async () => void log.push('clearHalt'),
  }
  return d
}

describe('WebUsbTransport', () => {
  it('picks the printer-class bulk-out endpoint and writes in chunks', async () => {
    const log: string[] = []
    const dev = fakeUsbDevice(log)
    const usb = { getDevices: async () => [], requestDevice: async () => dev }
    const t = new WebUsbTransport({ usb, chunkSize: 4096 })
    await t.connect()
    expect(t.isConnected).toBe(true)
    expect(t.name).toBe('POS-80')
    await t.write(bytes(10000))
    expect(log).toEqual(['open', 'config 1', 'claim 1', 'out 3 4096', 'out 3 4096', 'out 3 1808'])
    await t.disconnect()
    expect(t.isConnected).toBe(false)
    expect(log.slice(-2)).toEqual(['release 1', 'close'])
  })
  it('re-opens a previously granted device without prompting', async () => {
    const dev = fakeUsbDevice([])
    let asked = 0
    const usb = { getDevices: async () => [dev], requestDevice: async () => { asked++; return dev } }
    const t = new WebUsbTransport({ usb })
    await t.connect()
    expect(asked).toBe(0)
  })
  it('retries a stalled transfer once (clearing the halt) and reports a hard failure', async () => {
    const log: string[] = []
    const dev = fakeUsbDevice(log, { fail: 1 })
    const t = new WebUsbTransport({ usb: { getDevices: async () => [dev], requestDevice: async () => dev }, sleep: noSleep })
    await t.connect()
    await t.write(bytes(10))
    expect(log).toContain('clearHalt')
    expect(log.filter((l) => l.startsWith('out'))).toHaveLength(1)
    const bad = fakeUsbDevice([], { fail: 5 })
    const t2 = new WebUsbTransport({ usb: { getDevices: async () => [bad], requestDevice: async () => bad } })
    await t2.connect()
    await expect(t2.write(bytes(10))).rejects.toThrow(/stall/)
  })
  it('maps a dismissed chooser or missing API to NoPrinterError', async () => {
    const usb = { getDevices: async () => [], requestDevice: async () => { throw new Error('cancelled') } }
    await expect(new WebUsbTransport({ usb }).connect()).rejects.toBeInstanceOf(NoPrinterError)
    await expect(new WebUsbTransport({}).connect()).rejects.toBeInstanceOf(NoPrinterError)
  })
  it('endpoint selection prefers class 7 and falls back to vendor class 255', () => {
    const mk = (cls: number) => ({ configuration: { interfaces: [{ interfaceNumber: 4, alternates: [{ alternateSetting: 1, interfaceClass: cls, endpoints: [{ endpointNumber: 9, direction: 'out' as const, type: 'bulk' as const }] }] }] } })
    expect(findPrinterEndpoint(mk(7))).toEqual({ interfaceNumber: 4, alternateSetting: 1, endpointNumber: 9 })
    expect(findPrinterEndpoint(mk(255))?.endpointNumber).toBe(9)
    expect(findPrinterEndpoint(mk(3))).toBeNull()
    expect(findPrinterEndpoint({ configuration: null })).toBeNull()
  })
})

describe('WebSerialTransport', () => {
  function fakePort(): { port: SerialPortLike; written: Uint8Array[]; opened: number[]; closed: () => boolean } {
    const written: Uint8Array[] = []
    const opened: number[] = []
    let closed = false
    const port: SerialPortLike = {
      readable: {},
      writable: { getWriter: () => ({ ready: Promise.resolve(), write: async (c: Uint8Array) => void written.push(c.slice()), releaseLock: () => {} }) },
      open: async (o) => void opened.push(o.baudRate),
      close: async () => { closed = true },
    }
    return { port, written, opened, closed: () => closed }
  }
  it('opens at the configured baud rate and chunks writes', async () => {
    const f = fakePort()
    const t = new WebSerialTransport({ serial: { getPorts: async () => [], requestPort: async () => f.port }, baudRate: 115200, chunkSize: 512 })
    await t.connect()
    await t.write(bytes(1300))
    expect(f.opened).toEqual([115200])
    expect(f.written.map((c) => c.length)).toEqual([512, 512, 276])
    await t.disconnect()
    expect(f.closed()).toBe(true)
  })
  it('defaults to 9600 and re-uses granted ports', async () => {
    const f = fakePort()
    let asked = 0
    const t = new WebSerialTransport({ serial: { getPorts: async () => [f.port], requestPort: async () => { asked++; return f.port } } })
    await t.connect()
    expect(f.opened).toEqual([9600])
    expect(asked).toBe(0)
  })
  it('write before connect fails', async () => {
    await expect(new WebSerialTransport({}).write(bytes(1))).rejects.toThrow()
    await expect(new WebSerialTransport({}).connect()).rejects.toBeInstanceOf(NoPrinterError)
  })
})

describe('WebBluetoothTransport', () => {
  function fakeBle(opts: { dropOnWrite?: number } = {}) {
    const written: number[] = []
    const listeners: Array<() => void> = []
    let connects = 0
    let drop = opts.dropOnWrite ?? -1
    let writes = 0
    const ch: BleCharacteristicLike = {
      properties: { write: true, writeWithoutResponse: true },
      writeValueWithoutResponse: async (v: Uint8Array) => {
        if (writes++ === drop) { drop = -1; listeners.forEach((l) => l()); throw new Error('GATT Server is disconnected') }
        written.push(v.length)
      },
    }
    const noWrite: BleCharacteristicLike = { properties: { write: false, writeWithoutResponse: false } }
    const server = {
      connected: true,
      getPrimaryServices: async () => [{ getCharacteristics: async () => [noWrite] }, { getCharacteristics: async () => [noWrite, ch] }],
      disconnect: () => {},
    }
    const device: BleDeviceLike = {
      name: 'MPT-II',
      gatt: { connected: false, connect: async () => { connects++; return server } },
      addEventListener: (_t, l) => void listeners.push(l),
      removeEventListener: () => {},
    }
    return { device, written, connects: () => connects }
  }
  it('requests with the printer services, finds the writable characteristic, chunks to <= 100 with delays', async () => {
    const f = fakeBle()
    let req: unknown
    const sleeps: number[] = []
    const t = new WebBluetoothTransport({ bluetooth: { requestDevice: async (o) => { req = o; return f.device } }, sleep: async (ms) => void sleeps.push(ms) })
    await t.connect()
    expect(req).toEqual({ acceptAllDevices: true, optionalServices: [...PRINTER_SERVICES] })
    expect(PRINTER_SERVICES).toContain('49535343-fe7d-4ae5-8fa9-9fafd205e455')
    await t.write(bytes(250))
    expect(f.written).toEqual([100, 100, 50])
    expect(sleeps).toHaveLength(2)
    expect(t.name).toBe('MPT-II')
  })
  it('reconnects once on a GATT drop and resends the undelivered chunk', async () => {
    const f = fakeBle({ dropOnWrite: 1 })
    const t = new WebBluetoothTransport({ bluetooth: { requestDevice: async () => f.device }, sleep: noSleep })
    await t.connect()
    await t.write(bytes(250))
    expect(f.connects()).toBe(2)
    expect(f.written).toEqual([100, 100, 50]) // no chunk lost, none duplicated
  })
  it('re-uses getDevices() and gives up after a second drop', async () => {
    const f = fakeBle()
    let asked = 0
    const t = new WebBluetoothTransport({ bluetooth: { getDevices: async () => [f.device], requestDevice: async () => { asked++; return f.device } }, sleep: noSleep })
    await t.connect()
    expect(asked).toBe(0)
    const g = fakeBle()
    ;(g.device.gatt as { connect: () => Promise<unknown> }).connect = async () => { throw new Error('gone') }
    const t2 = new WebBluetoothTransport({ bluetooth: { requestDevice: async () => g.device } })
    await expect(t2.connect()).rejects.toThrow('gone')
  })
})
