import qrcode from 'qrcode-generator'

/**
 * QR code as a boolean matrix (true = dark module), module-count x module-count, WITHOUT the quiet zone.
 * DOM-free so the print pipeline and the screen can both draw it. Error correction 'M' fits a UPI link comfortably;
 * the version is picked automatically.
 */
export function qrMatrix(text: string, level: 'L' | 'M' | 'Q' | 'H' = 'M'): boolean[][] {
  const qr = qrcode(0, level)
  qr.addData(text)
  qr.make()
  const n = qr.getModuleCount()
  const rows: boolean[][] = []
  for (let r = 0; r < n; r++) {
    const row: boolean[] = []
    for (let c = 0; c < n; c++) row.push(qr.isDark(r, c))
    rows.push(row)
  }
  return rows
}
