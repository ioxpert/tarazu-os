-- Device pairing: the owner makes a short one-time code, the counter redeems it for a device credential (docs/adr/0015).

-- ---------- tenant table ----------
CREATE TABLE device_pairing (
    tenant_id   uuid        NOT NULL REFERENCES tenant (id),
    id          uuid        NOT NULL,
    store_id    uuid        NOT NULL,
    label       text,
    created_by  uuid,
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    consumed_at timestamptz,
    device_id   uuid,
    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, store_id)   REFERENCES store (tenant_id, id),
    FOREIGN KEY (tenant_id, created_by) REFERENCES app_user (tenant_id, id),
    CHECK ((consumed_at IS NULL) = (device_id IS NULL))
);
SELECT tarazu_enable_tenant_rls('device_pairing');
GRANT SELECT, INSERT, UPDATE ON device_pairing TO ${app_role};

-- ---------- global code directory (docs/adr/0015) ----------
-- A short code has to lead to a tenant BEFORE any tenant is bound, so this lookup is the second cross-tenant read in the
-- system (after contact_directory). Codes are stored only as HMAC-SHA256 hashes (server-side pepper). The API role has
-- no privileges on the table; the only way in is the SECURITY DEFINER functions below. Everything else about a pairing
-- (store, label, creator, state) lives in device_pairing, under RLS.
CREATE TABLE pairing_directory (
    code_hash  bytea       PRIMARY KEY,
    tenant_id  uuid        NOT NULL,
    pairing_id uuid        NOT NULL,
    expires_at timestamptz NOT NULL
);
REVOKE ALL ON pairing_directory FROM PUBLIC;

-- Claims a code for a pairing of the BOUND tenant. False when the hash is already taken (the caller draws a new code).
CREATE FUNCTION pairing_register(p_hash bytea, p_tenant uuid, p_pairing uuid, p_expires timestamptz) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE n integer;
BEGIN
    IF p_tenant IS DISTINCT FROM app_tenant_id() THEN
        RAISE EXCEPTION 'pairing_register: tenant is not the bound tenant';
    END IF;
    DELETE FROM pairing_directory WHERE expires_at < now() - interval '1 day';
    INSERT INTO pairing_directory (code_hash, tenant_id, pairing_id, expires_at) VALUES (p_hash, p_tenant, p_pairing, p_expires)
    ON CONFLICT (code_hash) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, pairing_id = EXCLUDED.pairing_id, expires_at = EXCLUDED.expires_at
        WHERE pairing_directory.expires_at < now();
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n = 1;
END $$;

-- The deliberate cross-tenant read: which tenant and pairing does this code belong to? Never returns an expired code.
CREATE FUNCTION pairing_lookup(p_hash bytea) RETURNS TABLE (tenant_id uuid, pairing_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT d.tenant_id, d.pairing_id FROM pairing_directory d WHERE d.code_hash = p_hash AND d.expires_at > now() $$;

-- Reads, without counting, whether a throttle bucket still has room (otp_throttle_hit is the counting side).
CREATE FUNCTION otp_throttle_peek(p_hash bytea, p_max integer, p_window interval) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
    SELECT coalesce((SELECT sum(hits) FROM otp_throttle
                     WHERE contact_hash = p_hash AND window_start > now() - 2 * p_window), 0) < p_max
$$;

REVOKE ALL ON FUNCTION pairing_register(bytea, uuid, uuid, timestamptz), pairing_lookup(bytea),
    otp_throttle_peek(bytea, integer, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pairing_register(bytea, uuid, uuid, timestamptz), pairing_lookup(bytea),
    otp_throttle_peek(bytea, integer, interval) TO ${app_role};
