import { column, Schema, Table } from '@powersync/web'

/**
 * Local SQLite schema (PowerSync adds the text `id` primary key to every table).
 *
 * Three kinds of table:
 * - `op_log`: insert-only. The ONE upload channel. Each row is a client operation (see the contract's Operation);
 *   PowerSync queues it in ps_crud and `TarazuConnector.uploadData` sends it. It is not kept locally.
 * - read-model tables: filled by the server's sync rules (infra/powersync/sync-rules.yaml), mirroring the server
 *   tables. Billing code also writes optimistic local effects here in the same transaction as the op; those writes
 *   enter ps_crud too and the connector discards them (the server's projection replaces them after sync).
 *   Booleans are 0/1 integers. Composite-key tables get a synthetic id in the sync rules.
 * - local-only tables: never synced.
 */
const opLog = new Table(
  {
    store_id: column.text,
    device_id: column.text,
    actor_user_id: column.text,
    local_seq: column.integer,
    hlc: column.text,
    idempotency_key: column.text,
    entity_type: column.text,
    entity_id: column.text,
    op_type: column.text,
    schema_version: column.integer,
    payload: column.text, // JSON text
    created_at: column.text,
  },
  { insertOnly: true },
)

export const READ_MODEL_TABLES = {
  product: new Table({
    tenant_id: column.text,
    name: column.text,
    barcode: column.text,
    sku: column.text,
    hsn: column.text,
    unit: column.text,
    local_name: column.text,
    brand: column.text,
    category: column.text,
    pack_sku: column.text,
    uom: column.text, // JSON text, see UomSpec in the contract
    tax_inclusive: column.integer,
    tax_rate_bp: column.integer,
    loose: column.integer,
    pinned: column.integer,
    active: column.integer,
    updated_at: column.text,
  }),
  party: new Table({
    tenant_id: column.text,
    name: column.text,
    party_type: column.text,
    phone: column.text,
    gstin: column.text,
    credit_limit_paise: column.integer,
    active: column.integer,
    merged_into: column.text,
    updated_at: column.text,
  }),
  price_version: new Table({
    tenant_id: column.text,
    product_id: column.text,
    party_id: column.text,
    price_type: column.text,
    amount_paise: column.integer,
    effective_from: column.text,
    hlc: column.text,
  }),
  // id = store_id || ':' || product_id
  stock_balance: new Table({
    tenant_id: column.text,
    store_id: column.text,
    product_id: column.text,
    qty_milli: column.integer,
    oversold: column.integer,
    movement_count: column.integer,
  }),
  // id = party_id
  khata_balance: new Table({
    tenant_id: column.text,
    party_id: column.text,
    balance_paise: column.integer,
    entry_count: column.integer,
  }),
  invoice: new Table({
    tenant_id: column.text,
    store_id: column.text,
    device_id: column.text,
    series: column.text,
    number: column.integer,
    doc_type: column.text,
    invoice_date: column.text,
    party_id: column.text,
    subtotal_paise: column.integer,
    discount_paise: column.integer,
    tax_paise: column.integer,
    round_off_paise: column.integer,
    total_paise: column.integer,
    hlc: column.text,
    created_at: column.text,
  }),
  // id = invoice_id || ':' || line_no
  invoice_line: new Table({
    tenant_id: column.text,
    invoice_id: column.text,
    line_no: column.integer,
    product_id: column.text,
    qty_milli: column.integer,
    unit_price_paise: column.integer,
    discount_paise: column.integer,
    hsn: column.text,
    tax_rate_bp: column.integer,
    tax_paise: column.integer,
    line_total_paise: column.integer,
  }),
  credit_note: new Table({
    tenant_id: column.text,
    store_id: column.text,
    device_id: column.text,
    series: column.text,
    number: column.integer,
    invoice_id: column.text,
    party_id: column.text,
    reason: column.text,
    total_paise: column.integer,
    lines: column.text, // JSON text
    hlc: column.text,
    created_at: column.text,
  }),
  shift: new Table({
    tenant_id: column.text,
    store_id: column.text,
    device_id: column.text,
    opening_cash_paise: column.integer,
    opened_at: column.text,
  }),
  // id = the shift_close row's own id (one per shift)
  shift_close: new Table({
    tenant_id: column.text,
    store_id: column.text,
    device_id: column.text,
    shift_id: column.text,
    declared_cash_paise: column.integer,
    expected_cash_paise: column.integer,
    variance_paise: column.integer,
    closed_at: column.text,
  }),
  payment: new Table({
    tenant_id: column.text,
    store_id: column.text,
    party_id: column.text,
    invoice_id: column.text,
    direction: column.text,
    mode: column.text,
    amount_paise: column.integer,
    reference: column.text,
    occurred_at: column.text,
  }),
  sales_order: new Table({
    tenant_id: column.text,
    store_id: column.text,
    party_id: column.text,
    state: column.text,
    updated_at: column.text,
  }),
  // global reference data (server table tax_rule): same rows for every merchant
  tax_rule: new Table({
    hsn_prefix: column.text,
    description: column.text,
    rate_bp: column.integer,
    cess_bp: column.integer,
    effective_from: column.text,
    notification_ref: column.text,
  }),
}

/** id = key. Keys: next_local_seq, last_hlc. */
const deviceState = new Table({ value: column.text }, { localOnly: true })

/** Server verdicts that need a human: rejected ops and flagged ops. id = operation id. */
const opIssue = new Table(
  {
    severity: column.text, // 'rejected' | 'flagged'
    code: column.text,
    detail: column.text,
    entity_type: column.text,
    entity_id: column.text,
    created_at: column.text,
    acknowledged_at: column.text,
  },
  { localOnly: true },
)

/** Bills parked with "hold". Drafts never leave the device: only a finalised invoice is an operation. */
const heldBill = new Table(
  { label: column.text, cart: column.text, total_paise: column.integer, created_at: column.text },
  { localOnly: true },
)

/** Owner PIN verifiers cached from GET /v1/identity/approvers so an approval can be checked offline (ADR 0005). */
const approver = new Table(
  { display_name: column.text, pin_salt: column.text, pin_hash: column.text, iterations: column.integer, fetched_at: column.text },
  { localOnly: true },
)

/** Receipts waiting to be shared (WhatsApp) until the device is online and the user taps send. */
const shareQueue = new Table(
  { invoice_id: column.text, phone: column.text, body: column.text, created_at: column.text, sent_at: column.text },
  { localOnly: true },
)

export const schema = new Schema({
  op_log: opLog,
  ...READ_MODEL_TABLES,
  device_state: deviceState,
  op_issue: opIssue,
  held_bill: heldBill,
  approver,
  share_queue: shareQueue,
})
