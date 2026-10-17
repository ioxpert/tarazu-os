/** Stable codes the UI translates (i18n key `billing.error.<code>`). Libraries never carry user-facing text. */
export type BillingErrorCode =
  | 'invalid_quantity'
  | 'invalid_price'
  | 'invalid_discount'
  | 'invalid_tax_rate'
  | 'amount_overflow'
  | 'empty_cart'
  | 'bill_lines_mismatch'
  | 'bill_inconsistent'
  | 'invalid_tender'
  | 'tender_short'
  | 'tender_excess'
  | 'credit_needs_customer'
  | 'card_reference_looks_like_pan'
  | 'approval_reason_required'
  | 'invalid_vpa'
  | 'invalid_amount'
  | 'invalid_profile'
  | 'invoice_not_found'
  | 'reason_required'
  | 'nothing_to_return'
  | 'unknown_line'
  | 'return_exceeds_sold'
  | 'return_amount_zero'
  | 'refund_mismatch'
  | 'shift_already_open'
  | 'no_open_shift'
  | 'held_bill_not_found'
  | 'customer_not_found'
  | 'invalid_phone'
  | 'invalid_credit_limit'

export class BillingError extends Error {
  constructor(
    readonly code: BillingErrorCode,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'BillingError'
  }
}
