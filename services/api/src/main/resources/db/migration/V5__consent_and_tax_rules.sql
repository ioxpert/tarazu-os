-- Consent ledger, tenant data mode, and server-controlled tax rule tables.

CREATE TABLE tenant_setting (
    tenant_id  uuid PRIMARY KEY REFERENCES tenant (id),
    -- local-only: this merchant's data never leaves the device; the server refuses uploads.
    local_only boolean     NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid,
    FOREIGN KEY (tenant_id, updated_by) REFERENCES app_user (tenant_id, id)
);
SELECT tarazu_enable_tenant_rls('tenant_setting');

-- Purpose-specific consent. Nothing is pre-selected: absence of a grant event means no consent.
-- Withdrawal is a new event, never an edit.
CREATE TABLE consent_event (
    id               uuid        NOT NULL,
    tenant_id        uuid        NOT NULL REFERENCES tenant (id),
    subject_type     text        NOT NULL CHECK (subject_type IN ('party', 'user')),
    subject_id       uuid        NOT NULL,
    purpose          text        NOT NULL,
    action           text        NOT NULL CHECK (action IN ('grant', 'withdraw')),
    policy_version   text        NOT NULL,
    channel          text        NOT NULL CHECK (channel IN ('in_app', 'paper', 'verbal', 'whatsapp', 'sms')),
    recorded_by      uuid,
    idempotency_key  text        NOT NULL,
    occurred_at      timestamptz NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, idempotency_key),
    FOREIGN KEY (tenant_id, recorded_by) REFERENCES app_user (tenant_id, id)
);
ALTER TABLE consent_event ADD PRIMARY KEY (tenant_id, id);
CREATE INDEX consent_event_subject_idx ON consent_event (tenant_id, subject_type, subject_id, purpose, occurred_at DESC);
SELECT tarazu_enable_tenant_rls('consent_event');
SELECT tarazu_make_append_only('consent_event');

-- Latest event per (subject, purpose). security_invoker: RLS of the caller applies.
CREATE VIEW consent_current WITH (security_invoker = true) AS
SELECT DISTINCT ON (tenant_id, subject_type, subject_id, purpose)
       tenant_id, subject_type, subject_id, purpose, action, policy_version, channel, occurred_at, id AS event_id
FROM consent_event
ORDER BY tenant_id, subject_type, subject_id, purpose,
         -- a device clock running ahead must not let an old grant outrank a later withdrawal: never later than arrival
         LEAST(occurred_at, created_at) DESC, created_at DESC, id DESC;

-- Every disclosure to a third party, tied to the consent event that allowed it.
CREATE TABLE third_party_sharing_log (
    id               uuid        NOT NULL,
    tenant_id        uuid        NOT NULL REFERENCES tenant (id),
    subject_type     text        NOT NULL CHECK (subject_type IN ('party', 'user')),
    subject_id       uuid        NOT NULL,
    purpose          text        NOT NULL,
    recipient        text        NOT NULL,
    data_categories  text[]      NOT NULL CHECK (cardinality(data_categories) > 0),
    consent_event_id uuid        NOT NULL,
    idempotency_key  text        NOT NULL,
    shared_at        timestamptz NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, idempotency_key),
    FOREIGN KEY (tenant_id, consent_event_id) REFERENCES consent_event (tenant_id, id)
);
ALTER TABLE third_party_sharing_log ADD PRIMARY KEY (tenant_id, id);
CREATE INDEX sharing_log_subject_idx ON third_party_sharing_log (tenant_id, subject_type, subject_id, shared_at DESC);
SELECT tarazu_enable_tenant_rls('third_party_sharing_log');
SELECT tarazu_make_append_only('third_party_sharing_log');

GRANT SELECT, INSERT, UPDATE ON tenant_setting TO ${app_role};
GRANT SELECT, INSERT ON consent_event, third_party_sharing_log TO ${app_role};
GRANT SELECT ON consent_current TO ${app_role};

-- ---------- tax rule tables: GLOBAL reference data (docs/adr/0003) ----------
-- These are the only tables without tenant_id: platform-owned, identical for every merchant,
-- changed by ops with a migration or admin role, never by the API (app role is SELECT only).
-- Effective-dated so a rate change is a new row, not an app release. For a date D the rule is
-- the longest matching hsn_prefix with the latest effective_from <= D.
CREATE TABLE tax_rule (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    hsn_prefix       text    NOT NULL CHECK (hsn_prefix ~ '^[0-9]{2,8}$'),
    description      text    NOT NULL,
    rate_bp          integer NOT NULL CHECK (rate_bp BETWEEN 0 AND 10000),
    cess_bp          integer NOT NULL DEFAULT 0 CHECK (cess_bp >= 0),
    effective_from   date    NOT NULL,
    notification_ref text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (hsn_prefix, effective_from)
);
CREATE INDEX tax_rule_lookup_idx ON tax_rule (hsn_prefix, effective_from DESC);

CREATE TABLE tax_threshold (
    key              text    NOT NULL,
    value_paise      bigint  NOT NULL CHECK (value_paise >= 0),
    effective_from   date    NOT NULL,
    notification_ref text,
    PRIMARY KEY (key, effective_from)
);

ALTER TABLE tax_rule      ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_rule      FORCE ROW LEVEL SECURITY;
ALTER TABLE tax_threshold ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_threshold FORCE ROW LEVEL SECURITY;
CREATE POLICY read_all ON tax_rule      FOR SELECT USING (true);
CREATE POLICY read_all ON tax_threshold FOR SELECT USING (true);
-- Admin (migration role) maintains the rows; with FORCE RLS it needs its own explicit policy.
CREATE POLICY admin_write ON tax_rule      FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);
CREATE POLICY admin_write ON tax_threshold FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);
SELECT tarazu_make_append_only('tax_rule');
GRANT SELECT ON tax_rule, tax_threshold TO ${app_role};
