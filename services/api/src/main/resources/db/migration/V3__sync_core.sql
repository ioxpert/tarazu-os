-- Sync core: operation log keyed per tenant, per-operation results, entity registry, conflict flags.

-- operation_id was globally unique; a second tenant replaying the same id would be silently dropped.
-- Uniqueness is per tenant (RLS makes other tenants' rows invisible, so it must be part of the key).
ALTER TABLE operation_log DROP CONSTRAINT operation_log_pkey;
ALTER TABLE operation_log ADD PRIMARY KEY (tenant_id, operation_id);
-- Device-asserted actor. No FK: an unknown claim is stored as sent and flagged, never a reason to lose the op.
ALTER TABLE operation_log ADD COLUMN actor_user_id uuid;
-- Same append-only guard as every other evidence table (replaces the V1 one-off trigger).
DROP TRIGGER operation_log_no_update_delete ON operation_log;
DROP FUNCTION operation_log_immutable();
SELECT tarazu_make_append_only('operation_log');
CREATE INDEX operation_log_entity_idx ON operation_log (tenant_id, entity_type, entity_id);

-- Mutable bookkeeping about each op. The op itself (operation_log) never changes.
CREATE TABLE operation_result (
    tenant_id           uuid        NOT NULL REFERENCES tenant (id),
    operation_id        uuid        NOT NULL,
    status              text        NOT NULL CHECK (status IN ('applied', 'flagged', 'deferred', 'rejected')),
    code                text,
    detail              text,
    waiting_entity_type text,
    waiting_entity_id   uuid,
    updated_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, operation_id),
    FOREIGN KEY (tenant_id, operation_id) REFERENCES operation_log (tenant_id, operation_id)
);
CREATE INDEX operation_result_deferred_idx ON operation_result (tenant_id, waiting_entity_type, waiting_entity_id)
    WHERE status = 'deferred';
SELECT tarazu_enable_tenant_rls('operation_result');

-- Which entities exist. Handlers check parents here, so an op that arrives before its parent is
-- parked as 'deferred' instead of failing a foreign key.
CREATE TABLE entity_registry (
    tenant_id    uuid        NOT NULL REFERENCES tenant (id),
    entity_type  text        NOT NULL,
    entity_id    uuid        NOT NULL,
    operation_id uuid        NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, entity_type, entity_id)
);
SELECT tarazu_enable_tenant_rls('entity_registry');
SELECT tarazu_make_append_only('entity_registry');

-- Things a human must look at: oversold stock, party identity clashes, conflicting order
-- transitions, policy violations on finalised documents. Flagged, never silently resolved.
CREATE TABLE conflict_flag (
    id              uuid        NOT NULL DEFAULT gen_random_uuid(),
    tenant_id       uuid        NOT NULL REFERENCES tenant (id),
    kind            text        NOT NULL,
    -- dedupe key: one open flag per (kind, scope), so replays and re-evaluations never pile up
    scope_key       text        NOT NULL,
    entity_type     text,
    entity_id       uuid,
    operation_id    uuid,
    status          text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
    detail          jsonb       NOT NULL DEFAULT '{}',
    created_at      timestamptz NOT NULL DEFAULT now(),
    resolved_at     timestamptz,
    resolved_by     uuid,
    resolution_note text,
    FOREIGN KEY (tenant_id, resolved_by) REFERENCES app_user (tenant_id, id)
);
ALTER TABLE conflict_flag ADD PRIMARY KEY (tenant_id, id);
CREATE UNIQUE INDEX conflict_flag_open_scope ON conflict_flag (tenant_id, kind, scope_key) WHERE status = 'open';
CREATE INDEX conflict_flag_status_idx ON conflict_flag (tenant_id, status, created_at DESC);
SELECT tarazu_enable_tenant_rls('conflict_flag');

GRANT SELECT, INSERT, UPDATE ON operation_result, conflict_flag TO ${app_role};
GRANT SELECT, INSERT ON entity_registry TO ${app_role};
