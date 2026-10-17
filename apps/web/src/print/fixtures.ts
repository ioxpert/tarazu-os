import type { ReceiptData, ReceiptLine } from '../billing/types'

/** Test-only sample receipts (not imported by the app). Amounts in paise, consistent with ADR 0009 maths. */
const biz = {
  businessName: 'Sharma General Store',
  gstin: '27ABCDE1234F1Z5',
  address: 'Shop 4, Gandhi Road, Pune 411001',
  phone: '9822012345',
  upiVpa: 'sharma@upi',
  gstMode: 'regular' as const,
}
const line = (o: Partial<ReceiptLine> & Pick<ReceiptLine, 'name' | 'qtyMilli' | 'unitPricePaise' | 'lineTotalPaise'>): ReceiptLine => ({
  localName: null, unit: 'piece', discountPaise: 0, taxRateBp: 0, ...o,
})

export const plainSale: ReceiptData = {
  kind: 'sale',
  business: biz,
  docType: 'tax_invoice',
  label: 'A1B2C3D4/2026-27/17',
  issuedAtIso: '2026-10-17T09:05:00Z',
  customerName: null,
  cashierName: 'Asha',
  lines: [
    line({ name: 'Atta 5kg', qtyMilli: 5000, unit: 'kg', unitPricePaise: 4500, taxRateBp: 500, lineTotalPaise: 22500 }),
    line({ name: 'Parle-G', qtyMilli: 3000, unitPricePaise: 1000, taxRateBp: 1800, lineTotalPaise: 3000 }),
    line({ name: 'Lux Soap', qtyMilli: 1000, unitPricePaise: 4950, taxRateBp: 1800, lineTotalPaise: 4950 }),
  ],
  subtotalPaise: 28166,
  taxPaise: 2284,
  discountPaise: 0,
  roundOffPaise: 50,
  totalPaise: 30500,
  taxBreakup: [
    { rateBp: 500, taxablePaise: 21429, taxPaise: 1071, cgstPaise: 535, sgstPaise: 536 },
    { rateBp: 1800, taxablePaise: 6737, taxPaise: 1213, cgstPaise: 606, sgstPaise: 607 },
  ],
  tenders: [{ mode: 'cash', amountPaise: 50000 }],
  changeDuePaise: 19500,
  creditPaise: 0,
}

export const splitCreditSale: ReceiptData = {
  ...plainSale,
  label: 'A1B2C3D4/2026-27/18',
  customerName: 'Ramesh Kumar',
  lines: [
    line({ name: 'Sugar', qtyMilli: 2000, unit: 'kg', unitPricePaise: 4400, taxRateBp: 500, lineTotalPaise: 8800 }),
    line({ name: 'Sunflower Oil 1L', qtyMilli: 1000, unit: 'litre', unitPricePaise: 15000, taxRateBp: 500, discountPaise: 1000, lineTotalPaise: 14000 }),
  ],
  subtotalPaise: 21714,
  taxPaise: 1086,
  discountPaise: 1000,
  roundOffPaise: 0,
  totalPaise: 22800,
  taxBreakup: [{ rateBp: 500, taxablePaise: 21714, taxPaise: 1086, cgstPaise: 543, sgstPaise: 543 }],
  tenders: [
    { mode: 'upi', amountPaise: 10000, reference: 'UTR123' },
    { mode: 'cash', amountPaise: 5000 },
    { mode: 'credit', amountPaise: 7800 },
  ],
  changeDuePaise: 0,
  creditPaise: 7800,
}

export const compositionBill: ReceiptData = {
  kind: 'sale',
  business: { ...biz, gstMode: 'composition' },
  docType: 'bill_of_supply',
  label: 'A1B2C3D4/2026-27/19',
  issuedAtIso: '2026-10-17T10:30:00Z',
  customerName: null,
  cashierName: null,
  lines: [
    line({ name: 'Rice 1kg', qtyMilli: 2500, unit: 'kg', unitPricePaise: 6000, lineTotalPaise: 15000 }),
    line({ name: 'Dal 500g', qtyMilli: 1000, unit: 'packet', unitPricePaise: 9000, lineTotalPaise: 9000 }),
  ],
  subtotalPaise: 24000,
  taxPaise: 0,
  discountPaise: 0,
  roundOffPaise: 0,
  totalPaise: 24000,
  taxBreakup: [],
  tenders: [{ mode: 'cash', amountPaise: 25000 }],
  changeDuePaise: 1000,
  creditPaise: 0,
}

export const creditNote: ReceiptData = {
  kind: 'credit_note',
  business: biz,
  docType: 'credit_note',
  label: 'A1B2C3D4/2026-27/CN-3',
  againstLabel: 'A1B2C3D4/2026-27/17',
  issuedAtIso: '2026-10-18T12:00:00Z',
  customerName: null,
  cashierName: 'Asha',
  lines: [line({ name: 'Parle-G', qtyMilli: 1000, unitPricePaise: 1000, taxRateBp: 1800, lineTotalPaise: 1000 })],
  subtotalPaise: 847,
  taxPaise: 153,
  discountPaise: 0,
  roundOffPaise: 0,
  totalPaise: 1000,
  taxBreakup: [{ rateBp: 1800, taxablePaise: 847, taxPaise: 153, cgstPaise: 76, sgstPaise: 77 }],
  tenders: [{ mode: 'cash', amountPaise: 1000 }],
  changeDuePaise: 0,
  creditPaise: 0,
}

export const longNames: ReceiptData = {
  ...plainSale,
  lines: [
    line({ name: 'Britannia Good Day Cashew Almond Butter Cookies Family Pack 600g Jumbo', qtyMilli: 2000, unitPricePaise: 12050, taxRateBp: 1800, lineTotalPaise: 24100 }),
    line({ name: 'Supercalifragilisticexpialidocious-Supercalifragilisticexpialidocious', qtyMilli: 1500, unit: 'kg', unitPricePaise: 100000, taxRateBp: 500, lineTotalPaise: 150000 }),
  ],
  subtotalPaise: 165000,
  taxPaise: 9100,
  roundOffPaise: 0,
  totalPaise: 174100,
  tenders: [{ mode: 'card', amountPaise: 174100 }],
  changeDuePaise: 0,
}

export const hindiSale: ReceiptData = {
  ...plainSale,
  business: { ...biz, businessName: 'श्री गणेश किराना', address: 'गांधी रोड, पुणे' },
  customerName: 'रमेश कुमार',
  lines: [
    { ...plainSale.lines[0], name: 'Atta 5kg', localName: 'आशीर्वाद आटा 5 किलो' },
    { ...plainSale.lines[1], name: 'Parle-G', localName: 'पारले-जी बिस्कुट' },
    { ...plainSale.lines[2] },
  ],
}

/** 40 distinct item lines, for the print-start budget test. */
export const bigSale: ReceiptData = {
  ...plainSale,
  lines: Array.from({ length: 40 }, (_, i) =>
    line({ name: `Item number ${i + 1}`, localName: i % 2 ? 'वस्तु' : null, qtyMilli: 1000 + i, unitPricePaise: 1000 + i, taxRateBp: 1800, lineTotalPaise: 1000 + i }),
  ),
}

/** 25x25 dummy QR matrix (checkerboard-ish; only geometry matters here). */
export const dummyQr: boolean[][] = Array.from({ length: 25 }, (_, y) => Array.from({ length: 25 }, (_, x) => (x * 7 + y * 3 + x * y) % 3 === 0))
