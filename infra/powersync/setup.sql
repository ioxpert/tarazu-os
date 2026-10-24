-- LOCAL DEV ONLY. One-time (and safe to repeat) database setup for the PowerSync service. Run as the Postgres superuser
-- AFTER the API has started once (Flyway creates the tables):
--   docker compose -f infra/docker-compose.yml exec -T postgres psql -U postgres -v ON_ERROR_STOP=1 -f - < infra/powersync/setup.sql
-- Production roles, secrets and the publication are provisioned by ops tooling, not here (ADR 0006).
--
-- Row-level security applies to every role and logical decoding does not use it, but the service's FIRST snapshot is a plain
-- SELECT, so the replication role gets SELECT-only policies on exactly the synced tables. NEVER BYPASSRLS (ADR 0006).
-- The table list must equal the tables in sync-rules.yaml (a web test checks it).

SELECT 'CREATE ROLE powersync_repl LOGIN REPLICATION PASSWORD ''powersync_repl_dev'''
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'powersync_repl')\gexec
SELECT 'CREATE ROLE powersync_storage LOGIN PASSWORD ''powersync_storage_dev'''
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'powersync_storage')\gexec
SELECT 'CREATE DATABASE powersync_storage OWNER powersync_storage'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'powersync_storage')\gexec

\connect tarazu

GRANT CONNECT ON DATABASE tarazu TO powersync_repl;
GRANT USAGE ON SCHEMA public TO powersync_repl;

DO $$
DECLARE
    t text;
    synced text[] := ARRAY['product', 'party', 'price_version', 'stock_balance', 'khata_balance', 'khata_entry', 'invoice',
                           'invoice_line', 'credit_note', 'shift', 'shift_close', 'purchase_receipt', 'payment', 'sales_order', 'tax_rule'];
BEGIN
    FOREACH t IN ARRAY synced LOOP
        EXECUTE format('GRANT SELECT ON %I TO powersync_repl', t);
        IF (SELECT relrowsecurity FROM pg_class WHERE oid = format('public.%I', t)::regclass) THEN
            EXECUTE format('DROP POLICY IF EXISTS powersync_read ON %I', t);
            EXECUTE format('CREATE POLICY powersync_read ON %I FOR SELECT TO powersync_repl USING (true)', t);
        END IF;
    END LOOP;
    IF EXISTS (SELECT FROM pg_publication WHERE pubname = 'powersync') THEN
        DROP PUBLICATION powersync;
    END IF;
    EXECUTE format('CREATE PUBLICATION powersync FOR TABLE %s', (SELECT string_agg(quote_ident(x), ', ') FROM unnest(synced) x));
END $$;
