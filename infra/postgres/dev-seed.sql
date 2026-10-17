-- LOCAL DEV ONLY. One merchant so you can register a device and try sync before OTP onboarding exists.
-- Run as the app or admin role (RLS applies to both, hence the tenant binding):
--   psql postgresql://tarazu_app:tarazu_app_dev@localhost:5432/tarazu -f infra/postgres/dev-seed.sql
-- Then, with the API started with TARAZU_AUTH_DEV_HEADER_ENABLED=true (see README), register a device and copy its token.
BEGIN;
SELECT set_config('app.tenant_id', '00000000-0000-7000-8000-000000000001', true);
INSERT INTO tenant (id, name) VALUES ('00000000-0000-7000-8000-000000000001', 'Dev Kirana') ON CONFLICT DO NOTHING;
INSERT INTO business (id, tenant_id, name, gst_mode)
VALUES ('00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000001', 'Dev Kirana', 'non_gst') ON CONFLICT DO NOTHING;
INSERT INTO store (id, tenant_id, business_id, name)
VALUES ('00000000-0000-7000-8000-000000000003', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', 'Main counter')
ON CONFLICT DO NOTHING;
INSERT INTO app_user (id, tenant_id, display_name)
VALUES ('00000000-0000-7000-8000-000000000004', '00000000-0000-7000-8000-000000000001', 'Dev Owner') ON CONFLICT DO NOTHING;
INSERT INTO user_role (tenant_id, user_id, role)
VALUES ('00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000004', 'owner') ON CONFLICT DO NOTHING;
COMMIT;
