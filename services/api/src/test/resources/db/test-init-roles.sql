-- Testcontainers only: non-superuser app role so RLS applies in tests.
CREATE ROLE tarazu_app LOGIN PASSWORD 'tarazu_app_dev';
