# Tarazu OS: instructions for Claude and contributors

Offline-first billing, stock and khata platform for Indian retail and wholesale (kirana to wholesaler).
Product requirements: see `docs/PRD.md` (live PRD linked there is the source of truth).

## Layout
- `apps/web`: React 19 + TypeScript + Vite installable PWA (Phase 1 client; Android/iOS wrappers come later)
- `services/api`: Java 21 + Spring Boot 4 modular monolith (Spring Modulith), Flyway, Postgres 16
- `packages/contract`: `openapi.yaml`, the single API contract; web types are generated from it
- `infra`: docker-compose for local deps, Postgres role bootstrap SQL
- `docs`: PRD pointer and ADRs

## Locked rules (do not change without an ADR)
1. A completed sale never waits for the cloud or an AI service. No LLM call in the billing commit path.
2. Money paths are append-only: ledgers and invoices are immutable, corrections are new entries. `operation_log` blocks UPDATE/DELETE.
3. Every table has `tenant_id` + `FORCE ROW LEVEL SECURITY`. The API connects as `tarazu_app` (non-superuser, non-owner). Bind the tenant with `TenantSession` inside a transaction; never skip it.
4. Composite FKs `(tenant_id, id)` so a row can never reference another tenant's parent.
5. Every client write carries an idempotency key and UUIDv7 operation id. Retries must be safe.
6. `/v1/**` fails closed: no auth means 401. The dev tenant header exists only behind `tarazu.auth.dev-header-enabled=true`; never enable it in production.
7. One OpenAPI contract for all clients. Change `openapi.yaml`, run `npm run gen:api` in `apps/web`, commit the result (CI checks drift).
8. No microservices, Kubernetes or Kafka in the MVP. Add a module, not a service. Split only on a measured trigger.
9. JVM runs in UTC.
10. India data residency for personal and merchant data. No raw merchant data sold.

## Commands
- API tests (needs Postgres 16 with roles from `infra/postgres/init`): `cd services/api && TARAZU_TEST_DB_URL=jdbc:postgresql://localhost:5432/tarazu mvn verify`
  - Without `TARAZU_TEST_DB_URL`, integration tests use Testcontainers if Docker is available, else skip.
- Web: `cd apps/web && npm ci && npm run lint && npm run typecheck && npm test && npm run build`
- Local DB: `docker compose -f infra/docker-compose.yml up -d`

## Conventions
- Spring Modulith: one package per domain under `com.ioxpert.tarazu`; cross-module calls only through a module's public types. `ModularityTests` enforces this.
- Test RLS and idempotency against real Postgres, never mocks.
- Small PRs: one vertical slice each, tests included, CI green.
- Cloud sessions are ephemeral: commit and push often.
