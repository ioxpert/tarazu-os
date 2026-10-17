import type { Unit } from '../catalogue/types'

export type GstMode = 'regular' | 'composition' | 'non_gst'
export type DocType = 'tax_invoice' | 'bill_of_supply' | 'retail_invoice'
export type TenderMode = 'cash' | 'upi' | 'card' | 'credit'

/** A discount typed by the cashier: a percentage (basis points, 500 = 5%) or a rupee amount. */
export type Discount = { kind: 'percent'; bp: number } | { kind: 'amount'; paise: number }

export interface CartLine {
  /** Local key for the UI (not an invoice line number). */
  lineId: string
  productId: string
  name: string
  localName: string | null
  hsn: string | null
  /** Quantity in milli-units of the product's base unit. */
  qtyMilli: number
  /** Unit the cashier entered it in (display only). */
  unit: Unit
  /** Price per BASE unit, paise. */
  unitPricePaise: number
  priceSource: 'retail' | 'mrp' | 'customer' | 'manual'
  taxInclusive: boolean
  /** Effective GST rate in basis points (1800 = 18%). 0 for bill of supply / non-GST. */
  taxRateBp: number
  /** 'rule' = server tax rule table, 'item' = merchant fallback rate on the item, 'none' = no rate known. */
  taxRateSource: 'rule' | 'item' | 'none'
  discount: Discount | null
}

export interface Cart {
  lines: CartLine[]
  billDiscount: Discount | null
  partyId: string | null
}

export interface PricedLine {
  lineNo: number
  productId: string
  hsn: string | null
  qtyMilli: number
  unitPricePaise: number
  /** round(qty x price) before any discount. Tax-inclusive when the line is inclusive. */
  grossPaise: number
  /** Line discount plus this line's share of the bill discount. Tax is computed AFTER it. */
  discountPaise: number
  taxRateBp: number
  taxPaise: number
  /** Amount before tax (grossPaise - discountPaise - taxPaise when inclusive). */
  taxablePaise: number
  /** After discount, including tax. This is InvoiceLine.lineTotalPaise. */
  lineTotalPaise: number
}

export interface TaxBreakupRow {
  rateBp: number
  taxablePaise: number
  taxPaise: number
  /** Intra-state split for display: cgst = floor(tax / 2), sgst = tax - cgst. */
  cgstPaise: number
  sgstPaise: number
}

export interface PricedBill {
  docType: DocType
  lines: PricedLine[]
  /** Sum of taxablePaise = InvoicePayload.subtotalPaise. */
  subtotalPaise: number
  taxPaise: number
  /** Total discount given (info for the receipt). The invoice header discountPaise is always 0 (ADR 0006). */
  discountPaise: number
  /** Cash rounding to the nearest rupee, -50..+50 paise. */
  roundOffPaise: number
  /** subtotal + tax + roundOff = amount payable. */
  totalPaise: number
  taxBreakup: TaxBreakupRow[]
}

export interface Tender {
  mode: TenderMode
  amountPaise: number
  reference?: string | null
}

export interface MerchantProfile {
  businessName: string
  gstMode: GstMode
  gstin: string | null
  stateCode: string | null
  upiVpa: string | null
  address: string | null
  phone: string | null
  storeName: string | null
  /** 'nearest_rupee' (default) or 'none'. */
  rounding: 'nearest_rupee' | 'none'
}

export interface ReceiptLine {
  name: string
  localName: string | null
  qtyMilli: number
  unit: Unit
  unitPricePaise: number
  discountPaise: number
  taxRateBp: number
  lineTotalPaise: number
}

/** Everything a receipt needs, independent of printer width or output (ESC/POS, HTML, PDF, WhatsApp text). */
export interface ReceiptData {
  kind: 'sale' | 'credit_note'
  business: Pick<MerchantProfile, 'businessName' | 'gstin' | 'address' | 'phone' | 'upiVpa' | 'gstMode'>
  docType: DocType | 'credit_note'
  /** Human label, e.g. "A1B2C3D4/2026-27/17". */
  label: string
  issuedAtIso: string
  /** For a credit note: label of the invoice it corrects. */
  againstLabel?: string | null
  customerName: string | null
  cashierName: string | null
  lines: ReceiptLine[]
  subtotalPaise: number
  taxPaise: number
  discountPaise: number
  roundOffPaise: number
  totalPaise: number
  taxBreakup: TaxBreakupRow[]
  tenders: Tender[]
  changeDuePaise: number
  /** Part of the bill left as "customer owes" (khata receivable). */
  creditPaise: number
}
