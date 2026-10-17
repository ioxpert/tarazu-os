-- Tarazu OS baseline: tenancy, devices, and the append-only operation log.
-- Rules enforced here (see CLAUDE.md): tenant_id + FORCE RLS on every table,
-- composite FKs so a row can never reference another tenant's parent, append-only op log.

CREATE FUNCTION app_tenant_id() RETURNS uuid
    LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE TABLE tenant (
    id         uuid PRIMARY KEY,
    name       text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE store (
    id         uuid PRIMARY KEY,
    tenant_id  uuid        NOT NULL REFERENCES tenant (id),
    name       text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id)
);

CREATE TABLE device (
    id           uuid PRIMARY KEY,
    tenant_id    uuid        NOT NULL REFERENCES tenant (id),
    store_id     uuid        NOT NULL,
    label        text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz,
    UNIQUE (tenant_id, id),
    FOREIGN KEY (tenant_id, store_id) REFERENCES store (tenant_id, id)
);

-- One row per client-side operation. UUIDv7 operation_id, hybrid logical clock,
-- per-tenant idempotency key (PowerSync uploadData retries are safe).
CREATE TABLE operation_log (
    operation_id    uuid PRIMARY KEY,
    tenant_id       uuid        NOT NULL REFERENCES tenant (id),
    store_id        uuid        NOT NULL,
    device_id       uuid        NOT NULL,
    local_seq       bigint      NOT NULL,
    hlc             text        NOT NULL,
    idempotency_key text        NOT NULL,
    entity_type     text        NOT NULL,
    entity_id       uuid        NOT NULL,
    op_type         text        NOT NULL CHECK (op_type IN ('create', 'update', 'void')),
    schema_version  integer     NOT NULL,
    payload         jsonb       NOT NULL,
    received_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, idempotency_key),
    FOREIGN KEY (tenant_id, store_id) REFERENCES store (tenant_id, id),
    FOREIGN KEY (tenant_id, device_id) REFERENCES device (tenant_id, id)
);

CREATE INDEX operation_log_tenant_seq_idx ON operation_log (tenant_id, device_id, local_seq);

-- Defence in depth: nobody (even the owner) updates or deletes the op log.
CREATE FUNCTION operation_log_immutable() RETURNS trigger
    LANGUAGE plpgsql
AS $$ BEGIN RAISE EXCEPTION 'operation_log is append-only'; END $$;

CREATE TRIGGER operation_log_no_update_delete
    BEFORE UPDATE OR DELETE ON operation_log
    FOR EACH ROW EXECUTE FUNCTION operation_log_immutable();

-- Row-level security: tenant_id must match the per-transaction setting app.tenant_id.
ALTER TABLE tenant        ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant        FORCE ROW LEVEL SECURITY;
ALTER TABLE store         ENABLE ROW LEVEL SECURITY;
ALTER TABLE store         FORCE ROW LEVEL SECURITY;
ALTER TABLE device        ENABLE ROW LEVEL SECURITY;
ALTER TABLE device        FORCE ROW LEVEL SECURITY;
ALTER TABLE operation_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE operation_log FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenant
    USING (id = app_tenant_id()) WITH CHECK (id = app_tenant_id());
CREATE POLICY tenant_isolation ON store
    USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON device
    USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON operation_log
    USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

-- App role: least privilege. No UPDATE/DELETE on the op log.
GRANT SELECT, INSERT, UPDATE ON tenant, store, device TO ${app_role};
GRANT SELECT, INSERT ON operation_log TO ${app_role};
