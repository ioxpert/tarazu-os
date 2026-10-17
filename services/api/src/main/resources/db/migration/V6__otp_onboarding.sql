-- OTP onboarding and login: contact directory (global), signup requests, OTP challenges, sessions.

ALTER TABLE app_user ADD COLUMN email text;

-- ---------- global contact directory (docs/adr/0007) ----------
-- Login must find a person's tenant from an email or phone BEFORE any tenant is known, so this lookup is the one
-- cross-tenant read in the system. Contacts are stored only as HMAC-SHA256 hashes (server-side pepper), the API role has
-- no privileges on the tables, and the only way in is the SECURITY DEFINER functions below.
CREATE TABLE contact_directory (
    contact_hash bytea PRIMARY KEY,
    tenant_id    uuid        NOT NULL,
    user_id      uuid        NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contact_directory_user_idx ON contact_directory (tenant_id, user_id);

CREATE TABLE otp_throttle (
    contact_hash bytea       NOT NULL,
    window_start timestamptz NOT NULL,
    hits         integer     NOT NULL,
    PRIMARY KEY (contact_hash, window_start)
);

REVOKE ALL ON contact_directory, otp_throttle FROM PUBLIC;

-- Claims a contact for a user of the BOUND tenant. True when it is now (or already was) theirs, false when another
-- account holds it.
CREATE FUNCTION contact_register(p_hash bytea, p_tenant uuid, p_user uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE owner_tenant uuid; owner_user uuid;
BEGIN
    IF p_tenant IS DISTINCT FROM app_tenant_id() THEN
        RAISE EXCEPTION 'contact_register: tenant is not the bound tenant';
    END IF;
    INSERT INTO contact_directory (contact_hash, tenant_id, user_id) VALUES (p_hash, p_tenant, p_user)
    ON CONFLICT DO NOTHING;
    SELECT tenant_id, user_id INTO owner_tenant, owner_user FROM contact_directory WHERE contact_hash = p_hash;
    RETURN owner_tenant = p_tenant AND owner_user = p_user;
END $$;

CREATE FUNCTION contact_release(p_hash bytea) RETURNS void
    LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ DELETE FROM contact_directory WHERE contact_hash = p_hash AND tenant_id = app_tenant_id() $$;

-- The deliberate cross-tenant read: which account owns this contact?
CREATE FUNCTION contact_lookup(p_hash bytea) RETURNS TABLE (tenant_id uuid, user_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT d.tenant_id, d.user_id FROM contact_directory d WHERE d.contact_hash = p_hash $$;

-- Counts an OTP request against a contact; false once the contact exceeded p_max in the window.
CREATE FUNCTION otp_throttle_hit(p_hash bytea, p_max integer, p_window interval) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE bucket timestamptz := to_timestamp(floor(extract(epoch FROM now()) / extract(epoch FROM p_window)) * extract(epoch FROM p_window));
        n integer;
BEGIN
    DELETE FROM otp_throttle WHERE window_start < now() - 2 * p_window;
    INSERT INTO otp_throttle (contact_hash, window_start, hits) VALUES (p_hash, bucket, 1)
    ON CONFLICT (contact_hash, window_start) DO UPDATE SET hits = otp_throttle.hits + 1
    RETURNING hits INTO n;
    RETURN n <= p_max;
END $$;

REVOKE ALL ON FUNCTION contact_register(bytea, uuid, uuid), contact_release(bytea), contact_lookup(bytea),
    otp_throttle_hit(bytea, integer, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION contact_register(bytea, uuid, uuid), contact_release(bytea), contact_lookup(bytea),
    otp_throttle_hit(bytea, integer, interval) TO ${app_role};

-- ---------- tenant tables ----------
-- tenant_id of a signup is minted before the tenant exists (so no FK to tenant): it becomes the tenant's id on completion.
CREATE TABLE signup_request (
    tenant_id         uuid        NOT NULL,
    id                uuid        NOT NULL,
    owner_name        text        NOT NULL,
    business_name     text        NOT NULL,
    email             text,
    phone             text,
    required_channels text[]      NOT NULL,
    verified_channels text[]      NOT NULL DEFAULT '{}',
    status            text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'expired')),
    created_at        timestamptz NOT NULL DEFAULT now(),
    expires_at        timestamptz NOT NULL,
    PRIMARY KEY (tenant_id, id)
);
SELECT tarazu_enable_tenant_rls('signup_request');

CREATE TABLE otp_challenge (
    tenant_id     uuid        NOT NULL,
    id            uuid        NOT NULL,
    purpose       text        NOT NULL CHECK (purpose IN ('signup', 'login')),
    channel       text        NOT NULL CHECK (channel IN ('email', 'phone')),
    signup_id     uuid,
    user_id       uuid,
    code_hash     bytea       NOT NULL,
    attempts      integer     NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL,
    consumed_at   timestamptz,
    PRIMARY KEY (tenant_id, id)
);
CREATE INDEX otp_challenge_signup_idx ON otp_challenge (tenant_id, signup_id, channel, created_at DESC);
SELECT tarazu_enable_tenant_rls('otp_challenge');

CREATE TABLE auth_session (
    tenant_id    uuid        NOT NULL REFERENCES tenant (id),
    id           uuid        NOT NULL,
    user_id      uuid        NOT NULL,
    token_hash   bytea       NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    revoked_at   timestamptz,
    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, user_id) REFERENCES app_user (tenant_id, id)
);
SELECT tarazu_enable_tenant_rls('auth_session');

GRANT SELECT, INSERT, UPDATE ON signup_request, otp_challenge, auth_session TO ${app_role};
