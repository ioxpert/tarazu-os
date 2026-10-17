-- Dev/CI bootstrap. Production roles are provisioned by infra with real secrets.
-- tarazu_admin owns the schema and runs Flyway; tarazu_app is what the API connects as.
-- tarazu_app must stay NON-superuser and NON-BYPASSRLS so row-level security always applies.
CREATE ROLE tarazu_admin LOGIN PASSWORD 'tarazu_admin_dev';
CREATE ROLE tarazu_app   LOGIN PASSWORD 'tarazu_app_dev';
CREATE DATABASE tarazu OWNER tarazu_admin;
