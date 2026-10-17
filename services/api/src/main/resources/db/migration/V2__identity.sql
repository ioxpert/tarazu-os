-- Identity: tenant > business > store > device > user, roles, staff PIN, audit log.
-- Conventions (CLAUDE.md): tenant_id + FORCE RLS on every tenant table, composite FKs,
-- append-only where the data is evidence (audit_log).

-- Helpers used by every migration from here on. Not callable by the app role.
CREATE FUNCTION tarazu_enable_tenant_rls(tbl regclass) RETURNS void
    LANGUAGE plpgsql
AS $$
BEGIN
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('CREATE POLICY tenant_isolation ON %s USING (tenant_id = app_tenant_id()) '
                   'WITH CHECK (tenant_id = app_tenant_id())', tbl);
END $$;
REVOKE ALL ON FUNCTION tarazu_enable_tenant_rls(regclass) FROM PUBLIC;

-- Evidence tables: nobody updates or deletes a row, ever (even the table owner).
CREATE FUNCTION append_only_guard() RETURNS trigger
    LANGUAGE plpgsql
AS $$ BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation'; END $$;

CREATE FUNCTION tarazu_make_append_only(tbl regclass) RETURNS void
    LANGUAGE plpgsql
AS $$
BEGIN
    EXECUTE format('CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON %s '
                   'FOR EACH ROW EXECUTE FUNCTION append_only_guard()', tbl);
END $$;
REVOKE ALL ON FUNCTION tarazu_make_append_only(regclass) FROM PUBLIC;

CREATE TABLE business (
    id         uuid        NOT NULL,
    tenant_id  uuid        NOT NULL REFERENCES tenant (id),
    name       text        NOT NULL,
    -- 'regular' issues tax invoices, 'composition' issues bills of supply, 'non_gst' is unregistered.
    gst_mode   text        NOT NULL DEFAULT 'non_gst' CHECK (gst_mode IN ('regular', 'composition', 'non_gst')),
    gstin      text,
    state_code text CHECK (state_code ~ '^[0-9]{2}$'),
    created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE business ADD PRIMARY KEY (tenant_id, id);

-- store gets a business parent. The migration role owns the tables, so lift FORCE for the backfill only
-- (RLS would hide every existing row from a session with no tenant bound). business gets RLS afterwards.
ALTER TABLE tenant NO FORCE ROW LEVEL SECURITY;
ALTER TABLE store NO FORCE ROW LEVEL SECURITY;
ALTER TABLE store ADD COLUMN business_id uuid;
INSERT INTO business (id, tenant_id, name)
SELECT gen_random_uuid(), t.id, t.name FROM tenant t
WHERE EXISTS (SELECT 1 FROM store s WHERE s.tenant_id = t.id);
UPDATE store s SET business_id = (SELECT b.id FROM business b WHERE b.tenant_id = s.tenant_id LIMIT 1);
ALTER TABLE store ALTER COLUMN business_id SET NOT NULL;
-- Entity ids are only unique within a tenant, so another tenant reusing an id can never collide with
-- (or probe for) this tenant's rows. Composite keys everywhere; the V1 tables are converted here.
ALTER TABLE store  DROP CONSTRAINT store_pkey,  ADD PRIMARY KEY (tenant_id, id);
ALTER TABLE device DROP CONSTRAINT device_pkey, ADD PRIMARY KEY (tenant_id, id);
ALTER TABLE store ADD FOREIGN KEY (tenant_id, business_id) REFERENCES business (tenant_id, id);
ALTER TABLE store FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant FORCE ROW LEVEL SECURITY;
SELECT tarazu_enable_tenant_rls('business');

-- Device lifecycle. Revocation is checked on every authenticated request, so it bites at the next sync.
ALTER TABLE device
    ADD COLUMN status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    ADD COLUMN token_hash    bytea,
    ADD COLUMN registered_by uuid,
    ADD COLUMN revoked_at    timestamptz,
    ADD COLUMN revoked_by    uuid,
    ADD COLUMN revoke_reason text;

CREATE TABLE app_user (
    id                 uuid        NOT NULL,
    tenant_id          uuid        NOT NULL REFERENCES tenant (id),
    display_name       text        NOT NULL,
    phone              text,
    status             text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    pin_salt           bytea,
    pin_hash           bytea,
    pin_iterations     integer,
    pin_set_at         timestamptz,
    pin_failed_count   integer     NOT NULL DEFAULT 0,
    pin_locked_until   timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app_user ADD PRIMARY KEY (tenant_id, id);
SELECT tarazu_enable_tenant_rls('app_user');

-- A user holds roles tenant-wide (business_id/store_id null) or scoped to a business/store.
CREATE TABLE user_role (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   uuid NOT NULL REFERENCES tenant (id),
    user_id     uuid NOT NULL,
    role        text NOT NULL CHECK (role IN
        ('owner', 'manager', 'cashier', 'purchaser', 'accountant', 'sales_rep', 'delivery_agent')),
    business_id uuid,
    store_id    uuid,
    FOREIGN KEY (tenant_id, user_id)     REFERENCES app_user (tenant_id, id),
    FOREIGN KEY (tenant_id, business_id) REFERENCES business (tenant_id, id),
    FOREIGN KEY (tenant_id, store_id)    REFERENCES store (tenant_id, id)
);
CREATE UNIQUE INDEX user_role_unique ON user_role
    (tenant_id, user_id, role, coalesce(business_id, '00000000-0000-0000-0000-000000000000'),
     coalesce(store_id, '00000000-0000-0000-0000-000000000000'));
SELECT tarazu_enable_tenant_rls('user_role');

ALTER TABLE device ADD FOREIGN KEY (tenant_id, registered_by) REFERENCES app_user (tenant_id, id);
ALTER TABLE device ADD FOREIGN KEY (tenant_id, revoked_by)    REFERENCES app_user (tenant_id, id);

-- Who did what, when, why. No hard delete of anything finalised: the evidence lives here.
CREATE TABLE audit_log (
    id              uuid        NOT NULL,
    tenant_id       uuid        NOT NULL REFERENCES tenant (id),
    occurred_at     timestamptz NOT NULL DEFAULT now(),
    actor_user_id   uuid,
    actor_device_id uuid,
    action          text        NOT NULL,
    entity_type     text,
    entity_id       uuid,
    reason          text,
    details         jsonb       NOT NULL DEFAULT '{}',
    operation_id    uuid,
    -- actor_user_id has no FK on purpose: for synced operations it is what the device claimed, and an unknown
    -- claim must be recorded (and flagged) rather than fail the write. actor_device_id is authenticated.
    FOREIGN KEY (tenant_id, actor_device_id) REFERENCES device (tenant_id, id)
);
ALTER TABLE audit_log ADD PRIMARY KEY (tenant_id, id);
CREATE INDEX audit_log_entity_idx ON audit_log (tenant_id, entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_log_time_idx ON audit_log (tenant_id, occurred_at DESC);
-- One audit row per (operation, action): replaying an operation never double-logs.
CREATE UNIQUE INDEX audit_log_operation_action ON audit_log (tenant_id, operation_id, action) WHERE operation_id IS NOT NULL;
SELECT tarazu_enable_tenant_rls('audit_log');
SELECT tarazu_make_append_only('audit_log');

GRANT SELECT, INSERT, UPDATE ON business, app_user TO ${app_role};
GRANT SELECT, INSERT, DELETE ON user_role TO ${app_role};
GRANT SELECT, INSERT ON audit_log TO ${app_role};
