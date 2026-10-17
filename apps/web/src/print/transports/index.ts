import { WebBluetoothTransport, type WebBluetoothOptions } from './webbluetooth'
import { WebSerialTransport, type WebSerialOptions } from './webserial'
import { WebUsbTransport, type WebUsbOptions } from './webusb'
import type { PrinterTransport, TransportKind } from './types'

export * from './types'
export { WebUsbTransport, findPrinterEndpoint } from './webusb'
export { WebSerialTransport } from './webserial'
export { WebBluetoothTransport, PRINTER_SERVICES } from './webbluetooth'

/** Which direct-print transports this browser supports (Chrome/Edge on Android and desktop; none on iOS Safari). */
export function availableTransports(nav: object | undefined = globalThis.navigator): TransportKind[] {
  const n = (nav ?? {}) as Record<string, unknown>
  const out: TransportKind[] = []
  if ('usb' in n && n.usb) out.push('webusb')
  if ('serial' in n && n.serial) out.push('webserial')
  if ('bluetooth' in n && n.bluetooth) out.push('webbluetooth')
  return out
}

export interface TransportOptions {
  usb?: WebUsbOptions
  serial?: WebSerialOptions
  bluetooth?: WebBluetoothOptions
}

export function createTransport(kind: TransportKind, o: TransportOptions = {}): PrinterTransport {
  switch (kind) {
    case 'webusb': return new WebUsbTransport(o.usb)
    case 'webserial': return new WebSerialTransport(o.serial)
    case 'webbluetooth': return new WebBluetoothTransport(o.bluetooth)
  }
}
