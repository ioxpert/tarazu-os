-- Canonical entities, one conflict policy each (see docs/adr/0002-sync-conflict-policies.md):
--   product, party      mutable, merged field-by-field by hybrid logical clock (field_clock)
--   price_version       effective-dated, append-only
--   invoice, credit_note, purchase_receipt   immutable once finalised (corrections = credit note)
--   payment, khata_entry, stock_movement     append-only events; balances are projections
--   sales_order         state machine, transitions append-only
-- Money is bigint paise; quantity is bigint milli-units (1000 = 1 unit). No floats on money paths.

-- ---------- catalogue ----------

CREATE TABLE product (
    id          uuid PRIMARY KEY,
    tenant_id   uuid        NOT NULL REFERENCES tenant (id),
    name        text        NOT NULL,
    barcode     text,
    sku         text,
    hsn         text,
    unit        text        NOT NULL DEFAULT 'pcs',
    active      boolean     NOT NULL DEFAULT true,
    -- {"name": "<hlc>", ...}: the clock of the write that last set each field
    field_clock jsonb       NOT NULL DEFAULT '{}',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id)
);
CREATE INDEX product_barcode_idx ON product (tenant_id, barcode) WHERE barcode IS NOT NULL;
SELECT tarazu_enable_tenant_rls('product');

CREATE TABLE price_version (
    id             uuid PRIMARY KEY,
    tenant_id      uuid        NOT NULL REFERENCES tenant (id),
    product_id     uuid        NOT NULL,
    price_type     text        NOT NULL CHECK (price_type IN ('mrp', 'retail', 'wholesale', 'purchase')),
    amount_paise   bigint      NOT NULL CHECK (amount_paise >= 0),
    effective_from timestamptz NOT NULL,
    hlc            text        NOT NULL,
    operation_id   uuid        NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (tenant_id, product_id) REFERENCES product (tenant_id, id)
);
CREATE INDEX price_version_lookup_idx ON price_version
    (tenant_id, product_id, price_type, effective_from DESC, hlc DESC);
SELECT tarazu_enable_tenant_rls('price_version');
SELECT tarazu_make_append_only('price_version');

-- Price in force for a product at an instant: latest effective_from <= at; the later HLC wins a tie.
CREATE FUNCTION price_as_of(p_product uuid, p_type text, p_at timestamptz) RETURNS bigint
    LANGUAGE sql STABLE
AS $$
    SELECT amount_paise FROM price_version
    WHERE product_id = p_product AND price_type = p_type AND effective_from <= p_at
    ORDER BY effective_from DESC, hlc DESC
    LIMIT 1
$$;

CREATE TABLE party (
    id              uuid PRIMARY KEY,
    tenant_id       uuid        NOT NULL REFERENCES tenant (id),
    name            text        NOT NULL,
    party_type      text        NOT NULL DEFAULT 'customer' CHECK (party_type IN ('customer', 'supplier', 'both')),
    phone           text,
    gstin           text,
    credit_limit_paise bigint   CHECK (credit_limit_paise >= 0),
    active          boolean     NOT NULL DEFAULT true,
    merged_into     uuid,
    field_clock     jsonb       NOT NULL DEFAULT '{}',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    FOREIGN KEY (tenant_id, merged_into) REFERENCES party (tenant_id, id)
);
CREATE INDEX party_phone_idx ON party (tenant_id, phone) WHERE phone IS NOT NULL;
CREATE INDEX party_gstin_idx ON party (tenant_id, gstin) WHERE gstin IS NOT NULL;
SELECT tarazu_enable_tenant_rls('party');

-- A merge is a recorded decision with provenance. applied=false means it lost a race with another
-- merge and was flagged for review instead of being applied.
CREATE TABLE party_merge (
    id               uuid PRIMARY KEY,
    tenant_id        uuid        NOT NULL REFERENCES tenant (id),
    source_party_id  uuid        NOT NULL,
    target_party_id  uuid        NOT NULL,
    applied          boolean     NOT NULL,
    reason           text,
    provenance       jsonb       NOT NULL,
    operation_id     uuid        NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    CHECK (source_party_id <> target_party_id),
    FOREIGN KEY (tenant_id, source_party_id) REFERENCES party (tenant_id, id),
    FOREIGN KEY (tenant_id, target_party_id) REFERENCES party (tenant_id, id)
);
SELECT tarazu_enable_tenant_rls('party_merge');
SELECT tarazu_make_append_only('party_merge');

-- ---------- inventory ----------

CREATE TABLE stock_movement (
    id           uuid PRIMARY KEY,
    tenant_id    uuid        NOT NULL REFERENCES tenant (id),
    store_id     uuid        NOT NULL,
    product_id   uuid        NOT NULL,
    qty_milli    bigint      NOT NULL CHECK (qty_milli <> 0),
    reason       text        NOT NULL CHECK (reason IN ('opening', 'sale', 'purchase', 'sale_return',
        'purchase_return', 'adjustment', 'transfer_in', 'transfer_out', 'damage')),
    ref_type     text,
    ref_id       uuid,
    device_id    uuid        NOT NULL,
    hlc          text        NOT NULL,
    operation_id uuid        NOT NULL,
    occurred_at  timestamptz NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (tenant_id, store_id)   REFERENCES store (tenant_id, id),
    FOREIGN KEY (tenant_id, product_id) REFERENCES product (tenant_id, id),
    FOREIGN KEY (tenant_id, device_id)  REFERENCES device (tenant_id, id)
);
CREATE INDEX stock_movement_product_idx ON stock_movement (tenant_id, store_id, product_id, occurred_at);
SELECT tarazu_enable_tenant_rls('stock_movement');
SELECT tarazu_make_append_only('stock_movement');

-- Projection of stock_movement. Never written by the app role: only the trigger below.
-- Negative stock is allowed (two offline counters can sell the last unit); oversold says so.
CREATE TABLE stock_balance (
    tenant_id      uuid        NOT NULL REFERENCES tenant (id),
    store_id       uuid        NOT NULL,
    product_id     uuid        NOT NULL,
    qty_milli      bigint      NOT NULL,
    oversold       boolean     GENERATED ALWAYS AS (qty_milli < 0) STORED,
    movement_count bigint      NOT NULL,
    updated_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, store_id, product_id),
    FOREIGN KEY (tenant_id, store_id)   REFERENCES store (tenant_id, id),
    FOREIGN KEY (tenant_id, product_id) REFERENCES product (tenant_id, id)
);
SELECT tarazu_enable_tenant_rls('stock_balance');

-- Addition is commutative and associative, so the projection is independent of arrival order.
CREATE FUNCTION project_stock_movement() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
    INSERT INTO stock_balance (tenant_id, store_id, product_id, qty_milli, movement_count)
    VALUES (NEW.tenant_id, NEW.store_id, NEW.product_id, NEW.qty_milli, 1)
    ON CONFLICT (tenant_id, store_id, product_id) DO UPDATE
        SET qty_milli = stock_balance.qty_milli + EXCLUDED.qty_milli,
            movement_count = stock_balance.movement_count + 1,
            updated_at = now();
    RETURN NEW;
END $$;
CREATE TRIGGER stock_movement_projection AFTER INSERT ON stock_movement
    FOR EACH ROW EXECUTE FUNCTION project_stock_movement();

-- ---------- billing ----------

CREATE TABLE invoice (
    id            uuid PRIMARY KEY,
    tenant_id     uuid        NOT NULL REFERENCES tenant (id),
    store_id      uuid        NOT NULL,
    device_id     uuid        NOT NULL,
    -- device-scoped number series, e.g. series 'C1-2026-27'. A number is never reused.
    series        text        NOT NULL,
    number        bigint      NOT NULL CHECK (number > 0),
    doc_type      text        NOT NULL CHECK (doc_type IN ('tax_invoice', 'bill_of_supply', 'retail_invoice')),
    invoice_date  date        NOT NULL,
    party_id      uuid,
    subtotal_paise  bigint    NOT NULL,
    discount_paise  bigint    NOT NULL CHECK (discount_paise >= 0),
    tax_paise       bigint    NOT NULL CHECK (tax_paise >= 0),
    round_off_paise bigint    NOT NULL,
    total_paise     bigint    NOT NULL CHECK (total_paise >= 0),
    approval      jsonb,
    hlc           text        NOT NULL,
    operation_id  uuid        NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, series, number),
    FOREIGN KEY (tenant_id, store_id)  REFERENCES store (tenant_id, id),
    FOREIGN KEY (tenant_id, device_id) REFERENCES device (tenant_id, id),
    FOREIGN KEY (tenant_id, party_id)  REFERENCES party (tenant_id, id)
);
CREATE INDEX invoice_date_idx ON invoice (tenant_id, store_id, invoice_date);
SELECT tarazu_enable_tenant_rls('invoice');
SELECT tarazu_make_append_only('invoice');

CREATE TABLE invoice_line (
    tenant_id        uuid   NOT NULL REFERENCES tenant (id),
    invoice_id       uuid   NOT NULL,
    line_no          int    NOT NULL CHECK (line_no > 0),
    product_id       uuid   NOT NULL,
    qty_milli        bigint NOT NULL CHECK (qty_milli > 0),
    unit_price_paise bigint NOT NULL CHECK (unit_price_paise >= 0),
    discount_paise   bigint NOT NULL CHECK (discount_paise >= 0),
    hsn              text,
    tax_rate_bp      int    NOT NULL CHECK (tax_rate_bp BETWEEN 0 AND 10000),
    tax_paise        bigint NOT NULL CHECK (tax_paise >= 0),
    line_total_paise bigint NOT NULL,
    PRIMARY KEY (tenant_id, invoice_id, line_no),
    FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoice (tenant_id, id),
    FOREIGN KEY (tenant_id, product_id) REFERENCES product (tenant_id, id)
);
SELECT tarazu_enable_tenant_rls('invoice_line');
SELECT tarazu_make_append_only('invoice_line');

-- Returns and corrections: a credit note references the invoice, it never edits it.
CREATE TABLE credit_note (
    id           uuid PRIMARY KEY,
    tenant_id    uuid        NOT NULL REFERENCES tenant (id),
    store_id     uuid        NOT NULL,
    device_id    uuid        NOT NULL,
    series       text        NOT NULL,
    number       bigint      NOT NULL CHECK (number > 0),
    invoice_id   uuid        NOT NULL,
    party_id     uuid,
    reason       text        NOT NULL CHECK (length(btrim(reason)) > 0),
    total_paise  bigint      NOT NULL CHECK (total_paise > 0),
    lines        jsonb       NOT NULL DEFAULT '[]',
    approval     jsonb,
    hlc          text        NOT NULL,
    operation_id uuid        NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, series, number),
    FOREIGN KEY (tenant_id, store_id)   REFERENCES store (tenant_id, id),
    FOREIGN KEY (tenant_id, device_id)  REFERENCES device (tenant_id, id),
    FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoice (tenant_id, id),
    FOREIGN KEY (tenant_id, party_id)   REFERENCES party (tenant_id, id)
);
SELECT tarazu_enable_tenant_rls('credit_note');
SELECT tarazu_make_append_only('credit_note');

CREATE TABLE purchase_receipt (
    id            uuid PRIMARY KEY,
    tenant_id     uuid        NOT NULL REFERENCES tenant (id),
    store_id      uuid        NOT NULL,
    device_id     uuid        NOT NULL,
    series        text        NOT NULL,
    number        bigint      NOT NULL CHECK (number > 0),
    supplier_id   uuid,
    supplier_ref  text,
    receipt_date  date        NOT NULL,
    total_paise   bigint      NOT NULL CHECK (total_paise >= 0),
    lines         jsonb       NOT NULL DEFAULT '[]',
    hlc           text        NOT NULL,
    operation_id  uuid        NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, series, number),
    FOREIGN KEY (tenant_id, store_id)    REFERENCES store (tenant_id, id),
    FOREIGN KEY (tenant_id, device_id)   REFERENCES device (tenant_id, id),
    FOREIGN KEY (tenant_id, supplier_id) REFERENCES party (tenant_id, id)
);
SELECT tarazu_enable_tenant_rls('purchase_receipt');
SELECT tarazu_make_append_only('purchase_receipt');

CREATE TABLE sales_order (
    id           uuid PRIMARY KEY,
    tenant_id    uuid        NOT NULL REFERENCES tenant (id),
    store_id     uuid        NOT NULL,
    party_id     uuid,
    state        text        NOT NULL CHECK (state IN
        ('draft', 'confirmed', 'packed', 'dispatched', 'delivered', 'cancelled', 'returned')),
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    FOREIGN KEY (tenant_id, store_id) REFERENCES store (tenant_id, id),
    FOREIGN KEY (tenant_id, party_id) REFERENCES party (tenant_id, id)
);
SELECT tarazu_enable_tenant_rls('sales_order');

-- Append-only history. applied=false is a transition that was not legal from the state the server
-- had when it arrived: recorded, flagged, not applied.
CREATE TABLE order_transition (
    id           uuid PRIMARY KEY,
    tenant_id    uuid        NOT NULL REFERENCES tenant (id),
    order_id     uuid        NOT NULL,
    from_state   text        NOT NULL,
    to_state     text        NOT NULL,
    applied      boolean     NOT NULL,
    reason       text,
    device_id    uuid        NOT NULL,
    hlc          text        NOT NULL,
    operation_id uuid        NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (tenant_id, order_id)  REFERENCES sales_order (tenant_id, id),
    FOREIGN KEY (tenant_id, device_id) REFERENCES device (tenant_id, id)
);
CREATE INDEX order_transition_order_idx ON order_transition (tenant_id, order_id, created_at);
SELECT tarazu_enable_tenant_rls('order_transition');
SELECT tarazu_make_append_only('order_transition');

-- ---------- ledger ----------

CREATE TABLE payment (
    id           uuid PRIMARY KEY,
    tenant_id    uuid        NOT NULL REFERENCES tenant (id),
    store_id     uuid        NOT NULL,
    party_id     uuid,
    invoice_id   uuid,
    direction    text        NOT NULL CHECK (direction IN ('in', 'out')),
    mode         text        NOT NULL CHECK (mode IN ('cash', 'upi', 'card', 'bank_transfer', 'cheque', 'other')),
    amount_paise bigint      NOT NULL CHECK (amount_paise > 0),
    reference    text,
    device_id    uuid        NOT NULL,
    hlc          text        NOT NULL,
    operation_id uuid        NOT NULL,
    occurred_at  timestamptz NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (tenant_id, store_id)   REFERENCES store (tenant_id, id),
    FOREIGN KEY (tenant_id, party_id)   REFERENCES party (tenant_id, id),
    FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoice (tenant_id, id),
    FOREIGN KEY (tenant_id, device_id)  REFERENCES device (tenant_id, id)
);
CREATE INDEX payment_party_idx ON payment (tenant_id, party_id) WHERE party_id IS NOT NULL;
SELECT tarazu_enable_tenant_rls('payment');
SELECT tarazu_make_append_only('payment');

-- Khata (credit book). debit = party owes the merchant more, credit = party paid or was credited.
CREATE TABLE khata_entry (
    id           uuid PRIMARY KEY,
    tenant_id    uuid        NOT NULL REFERENCES tenant (id),
    store_id     uuid        NOT NULL,
    party_id     uuid        NOT NULL,
    direction    text        NOT NULL CHECK (direction IN ('debit', 'credit')),
    amount_paise bigint      NOT NULL CHECK (amount_paise > 0),
    ref_type     text,
    ref_id       uuid,
    note         text,
    device_id    uuid        NOT NULL,
    hlc          text        NOT NULL,
    operation_id uuid        NOT NULL,
    occurred_at  timestamptz NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (tenant_id, store_id)  REFERENCES store (tenant_id, id),
    FOREIGN KEY (tenant_id, party_id)  REFERENCES party (tenant_id, id),
    FOREIGN KEY (tenant_id, device_id) REFERENCES device (tenant_id, id)
);
CREATE INDEX khata_entry_party_idx ON khata_entry (tenant_id, party_id, occurred_at);
SELECT tarazu_enable_tenant_rls('khata_entry');
SELECT tarazu_make_append_only('khata_entry');

-- balance_paise = sum(debit) - sum(credit): positive means the party owes the merchant.
CREATE TABLE khata_balance (
    tenant_id     uuid        NOT NULL REFERENCES tenant (id),
    party_id      uuid        NOT NULL,
    balance_paise bigint      NOT NULL,
    entry_count   bigint      NOT NULL,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, party_id),
    FOREIGN KEY (tenant_id, party_id) REFERENCES party (tenant_id, id)
);
SELECT tarazu_enable_tenant_rls('khata_balance');

CREATE FUNCTION project_khata_entry() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    delta bigint := CASE NEW.direction WHEN 'debit' THEN NEW.amount_paise ELSE -NEW.amount_paise END;
BEGIN
    INSERT INTO khata_balance (tenant_id, party_id, balance_paise, entry_count)
    VALUES (NEW.tenant_id, NEW.party_id, delta, 1)
    ON CONFLICT (tenant_id, party_id) DO UPDATE
        SET balance_paise = khata_balance.balance_paise + EXCLUDED.balance_paise,
            entry_count = khata_balance.entry_count + 1,
            updated_at = now();
    RETURN NEW;
END $$;
CREATE TRIGGER khata_entry_projection AFTER INSERT ON khata_entry
    FOR EACH ROW EXECUTE FUNCTION project_khata_entry();

-- Recomputes every projection from its events and returns the rows that disagree (should be empty).
-- SECURITY INVOKER: RLS limits it to the bound tenant. Used by tests and the nightly reconciliation job.
CREATE FUNCTION verify_projections()
    RETURNS TABLE (projection text, key text, expected bigint, actual bigint)
    LANGUAGE sql STABLE
AS $$
    SELECT 'stock_balance', coalesce(e.store_id, a.store_id)::text || '/' || coalesce(e.product_id, a.product_id)::text,
           coalesce(e.qty, 0), coalesce(a.qty_milli, 0)
    FROM (SELECT store_id, product_id, sum(qty_milli) AS qty FROM stock_movement GROUP BY 1, 2) e
    FULL JOIN stock_balance a ON a.store_id = e.store_id AND a.product_id = e.product_id
    WHERE coalesce(e.qty, 0) <> coalesce(a.qty_milli, 0)
    UNION ALL
    SELECT 'khata_balance', coalesce(e.party_id, a.party_id)::text,
           coalesce(e.bal, 0), coalesce(a.balance_paise, 0)
    FROM (SELECT party_id,
                 sum(CASE direction WHEN 'debit' THEN amount_paise ELSE -amount_paise END) AS bal
          FROM khata_entry GROUP BY 1) e
    FULL JOIN khata_balance a ON a.party_id = e.party_id
    WHERE coalesce(e.bal, 0) <> coalesce(a.balance_paise, 0)
$$;

-- ---------- grants: events insert-only, mutable rows update, projections read-only ----------
GRANT SELECT, INSERT, UPDATE ON product, party, sales_order TO ${app_role};
GRANT SELECT, INSERT ON price_version, party_merge, stock_movement, invoice, invoice_line, credit_note,
    purchase_receipt, order_transition, payment, khata_entry TO ${app_role};
GRANT SELECT ON stock_balance, khata_balance TO ${app_role};
