/**
 * Receipt label table. Lives here (not in i18next) because receipts render to bitmaps/ESC-POS outside React.
 * pa (Punjabi) and gu (Gujarati) columns are present but empty: they fall back to English until translated.
 */
export type LabelLang = 'en' | 'hi' | 'pa' | 'gu'
/** What the merchant picks: one language, or English with the Hindi line stacked/joined beneath. */
export type ReceiptLang = 'en' | 'hi' | 'en+hi'

export const LABEL_KEYS = [
  'taxInvoice', 'billOfSupply', 'retailInvoice', 'creditNote', 'item', 'qty', 'rate', 'amount', 'discount', 'subtotal',
  'total', 'roundOff', 'cgst', 'sgst', 'tax', 'taxable', 'gst', 'paid', 'change', 'customerOwes', 'upi', 'cash', 'card',
  'credit', 'thankYou', 'visitAgain', 'gstin', 'scanToPay', 'billNo', 'date', 'customer', 'cashier', 'against', 'refund',
  'khataAdjusted', 'compositionNote', 'phone', 'ref', 'youSaved',
] as const
export type LabelKey = (typeof LABEL_KEYS)[number]

type Row = Record<LabelLang, string>
const r = (en: string, hi: string): Row => ({ en, hi, pa: '', gu: '' })

export const LABELS: Record<LabelKey, Row> = {
  taxInvoice: r('Tax Invoice', 'कर चालान'),
  billOfSupply: r('Bill of Supply', 'आपूर्ति बिल'),
  retailInvoice: r('Retail Invoice', 'खुदरा चालान'),
  creditNote: r('Credit Note', 'क्रेडिट नोट'),
  item: r('Item', 'वस्तु'),
  qty: r('Qty', 'मात्रा'),
  rate: r('Rate', 'दर'),
  amount: r('Amount', 'राशि'),
  discount: r('Discount', 'छूट'),
  subtotal: r('Taxable value', 'कर योग्य मूल्य'),
  total: r('TOTAL', 'कुल'),
  roundOff: r('Round off', 'पूर्णांक'),
  cgst: r('CGST', 'सीजीएसटी'),
  sgst: r('SGST', 'एसजीएसटी'),
  tax: r('Tax', 'कर'),
  taxable: r('Taxable', 'कर योग्य'),
  gst: r('GST', 'जीएसटी'),
  paid: r('Paid', 'भुगतान'),
  change: r('Change', 'वापसी'),
  customerOwes: r('Customer owes', 'ग्राहक पर बकाया'),
  upi: r('UPI', 'यूपीआई'),
  cash: r('Cash', 'नकद'),
  card: r('Card', 'कार्ड'),
  credit: r('Credit', 'उधार'),
  thankYou: r('Thank you', 'धन्यवाद'),
  visitAgain: r('Visit again', 'फिर पधारें'),
  gstin: r('GSTIN', 'जीएसटीआईएन'),
  scanToPay: r('Scan to pay', 'भुगतान के लिए स्कैन करें'),
  billNo: r('Bill no', 'बिल नं'),
  date: r('Date', 'दिनांक'),
  customer: r('Customer', 'ग्राहक'),
  cashier: r('Cashier', 'कैशियर'),
  against: r('Against bill', 'बिल के विरुद्ध'),
  refund: r('Refund', 'वापसी राशि'),
  khataAdjusted: r('Adjusted in khata', 'खाते में समायोजित'),
  compositionNote: r(
    'Composition taxable person, not eligible to collect tax on supplies',
    'कंपोज़िशन करदाता, आपूर्ति पर कर संग्रह के पात्र नहीं',
  ),
  phone: r('Ph', 'फ़ोन'),
  ref: r('Ref', 'संदर्भ'),
  youSaved: r('You saved', 'आपकी बचत'),
}

/** Text in one concrete language, falling back to English when that language's cell is empty. */
export function labelIn(key: LabelKey, lang: LabelLang): string {
  return LABELS[key][lang] || LABELS[key].en
}

/** Stacked lines: ['Tax Invoice', 'कर चालान'] for en+hi, one line otherwise. */
export function labelLines(key: LabelKey, lang: ReceiptLang): string[] {
  if (lang === 'en') return [labelIn(key, 'en')]
  if (lang === 'hi') return [labelIn(key, 'hi')]
  const en = labelIn(key, 'en')
  const hi = labelIn(key, 'hi')
  return hi === en ? [en] : [en, hi]
}

/** Single-line form: 'Qty / मात्रा' for en+hi. Use for table cells; headings use labelLines. */
export function label(key: LabelKey, lang: ReceiptLang): string {
  return labelLines(key, lang).join(' / ')
}

/** True when the language needs glyphs the printer's built-in Latin pages lack (so the raster path is mandatory). */
export function langNeedsRaster(lang: ReceiptLang): boolean {
  return lang !== 'en'
}
