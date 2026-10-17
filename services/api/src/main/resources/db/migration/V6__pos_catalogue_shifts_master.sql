-- Billing/POS + catalogue slice: richer products (units, tax, loose, pinned), customer-specific prices,
-- cash shifts with an append-only close, the merchant UPI address, and the global platform product master.
-- See docs/adr/0005-offline-owner-approval.md and docs/adr/0006-billing-totals-and-tax.md.

-- ---------- product ----------
-- unit is validated against the UomUnit enum by the sync handler, not by a CHECK: rows written before this
-- migration keep their text (e.g. 'pcs'). Barcode uniqueness is deliberately NOT enforced: two shelves can
-- carry the same barcode, so duplicates are flagged for review (duplicate_barcode) and never rejected.
ALTER TABLE product
    ADD COLUMN local_name    text,
    ADD COLUMN brand         text,
    ADD COLUMN category      text,
    ADD COLUMN pack_sku      text,
    -- {"base": "piece", "units": [{"unit": "packet", "qtyMilli": 12000}]} (UomSpec in the contract)
    ADD COLUMN uom           jsonb,
    ADD COLUMN tax_inclusive boolean NOT NULL DEFAULT true,
    ADD COLUMN tax_rate_bp   integer CHECK (tax_rate_bp BETWEEN 0 AND 10000),
    ADD COLUMN loose         boolean NOT NULL DEFAULT false,
    ADD COLUMN pinned        boolean NOT NULL DEFAULT false;
ALTER TABLE product ALTER COLUMN unit SET DEFAULT 'piece';

-- ---------- customer-specific prices ----------
ALTER TABLE price_version ADD COLUMN party_id uuid;
ALTER TABLE price_version ADD FOREIGN KEY (tenant_id, party_id) REFERENCES party (tenant_id, id);
ALTER TABLE price_version DROP CONSTRAINT price_version_price_type_check;
ALTER TABLE price_version ADD CONSTRAINT price_version_price_type_check
    CHECK (price_type IN ('mrp', 'retail', 'wholesale', 'purchase', 'customer'));
-- A customer price belongs to exactly one party; every other price type is store-wide.
ALTER TABLE price_version ADD CONSTRAINT price_version_customer_party_check
    CHECK ((price_type = 'customer') = (party_id IS NOT NULL));
CREATE INDEX price_version_party_lookup_idx ON price_version
    (tenant_id, party_id, product_id, effective_from DESC, hlc DESC) WHERE party_id IS NOT NULL;

-- Store-wide types only: a 'customer' price needs the party, see price_as_of_party.
CREATE OR REPLACE FUNCTION price_as_of(p_product uuid, p_type text, p_at timestamptz) RETURNS bigint
    LANGUAGE sql STABLE
AS $$
    SELECT amount_paise FROM price_version
    WHERE product_id = p_product AND price_type = p_type AND party_id IS NULL AND effective_from <= p_at
    ORDER BY effective_from DESC, hlc DESC
    LIMIT 1
$$;

-- The negotiated rate of one party for a product at an instant (same tie-break as price_as_of).
CREATE FUNCTION price_as_of_party(p_product uuid, p_party uuid, p_at timestamptz) RETURNS bigint
    LANGUAGE sql STABLE
AS $$
    SELECT amount_paise FROM price_version
    WHERE product_id = p_product AND party_id = p_party AND price_type = 'customer' AND effective_from <= p_at
    ORDER BY effective_from DESC, hlc DESC
    LIMIT 1
$$;

-- ---------- business ----------
-- Same pattern as the contract. Postgres regex repetition tops out at 255, so the 256 limit is a length check.
ALTER TABLE business ADD COLUMN upi_vpa text
    CHECK (upi_vpa ~ '^[A-Za-z0-9._-]{2,}@[A-Za-z]{2,64}$' AND strpos(upi_vpa, '@') <= 257);

-- ---------- cash shifts ----------
CREATE TABLE shift (
    id                 uuid        NOT NULL,
    tenant_id          uuid        NOT NULL REFERENCES tenant (id),
    store_id           uuid        NOT NULL,
    device_id          uuid        NOT NULL,
    opening_cash_paise bigint      NOT NULL CHECK (opening_cash_paise >= 0),
    opened_at          timestamptz NOT NULL,
    note               text,
    hlc                text        NOT NULL,
    operation_id       uuid        NOT NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (tenant_id, store_id)  REFERENCES store (tenant_id, id),
    FOREIGN KEY (tenant_id, device_id) REFERENCES device (tenant_id, id)
);
ALTER TABLE shift ADD PRIMARY KEY (tenant_id, id);
CREATE INDEX shift_device_idx ON shift (tenant_id, device_id, opened_at);
SELECT tarazu_enable_tenant_rls('shift');
SELECT tarazu_make_append_only('shift');

-- One close per shift. variance_paise = declared - expected is stored (the row is evidence and never
-- recomputed). expected_cash_paise is the SERVER's figure (opening + cash in - cash out of that device in
-- [opened_at, closed_at]); client_expected_cash_paise keeps what the device computed, for the mismatch flag.
CREATE TABLE shift_close (
    id                         uuid        NOT NULL,
    tenant_id                  uuid        NOT NULL REFERENCES tenant (id),
    store_id                   uuid        NOT NULL,
    device_id                  uuid        NOT NULL,
    shift_id                   uuid        NOT NULL,
    declared_cash_paise        bigint      NOT NULL CHECK (declared_cash_paise >= 0),
    expected_cash_paise        bigint      NOT NULL,
    client_expected_cash_paise bigint      NOT NULL,
    variance_paise             bigint      NOT NULL,
    closed_at                  timestamptz NOT NULL,
    note                       text,
    hlc                        text        NOT NULL,
    operation_id               uuid        NOT NULL,
    created_at                 timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, shift_id),
    FOREIGN KEY (tenant_id, store_id)  REFERENCES store (tenant_id, id),
    FOREIGN KEY (tenant_id, device_id) REFERENCES device (tenant_id, id),
    FOREIGN KEY (tenant_id, shift_id)  REFERENCES shift (tenant_id, id)
);
ALTER TABLE shift_close ADD PRIMARY KEY (tenant_id, id);
SELECT tarazu_enable_tenant_rls('shift_close');
SELECT tarazu_make_append_only('shift_close');

GRANT SELECT, INSERT ON shift, shift_close TO ${app_role};

-- ---------- platform product master: GLOBAL reference data (second exception to rule 3, docs/adr/0006) ----------
-- Same rows for every merchant, maintained by ops (migration/admin role), read-only for the API role.
-- Not append-only: a master row may be corrected. No tenant data ever flows into it.
CREATE TABLE master_product (
    barcode    text PRIMARY KEY CHECK (barcode ~ '^[0-9]{6,14}$'),
    name       text        NOT NULL,
    local_name text,
    brand      text,
    category   text,
    hsn        text,
    mrp_paise  bigint CHECK (mrp_paise >= 0),
    unit       text        NOT NULL DEFAULT 'piece',
    uom        jsonb,
    updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE master_product ENABLE ROW LEVEL SECURITY;
ALTER TABLE master_product FORCE ROW LEVEL SECURITY;
CREATE POLICY read_all ON master_product FOR SELECT USING (true);
CREATE POLICY admin_write ON master_product FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);
GRANT SELECT ON master_product TO ${app_role};
