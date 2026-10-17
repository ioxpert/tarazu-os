# Tarazu OS

Offline-first billing, stock and khata for Indian retail and wholesale. Monorepo: React PWA, Spring Boot API, OpenAPI contract.

| Path | What |
|---|---|
| `apps/web` | React 19 + Vite PWA |
| `services/api` | Spring Boot 4 modular monolith, Postgres 16 with RLS |
| `packages/contract` | OpenAPI 3.1 contract |
| `infra` | Local dev dependencies |
| `docs` | PRD pointer, ADRs |

## Run locally
```bash
docker compose -f infra/docker-compose.yml up -d        # Postgres 16 + roles
cd services/api && mvn spring-boot:run                  # API on :8080
cd apps/web && npm ci && npm run dev                    # PWA on :5173, proxies /api to :8080
```
### Sign up locally with OTP (no seed needed)
```bash
OTP_PEPPER=local-dev-pepper-change-me OTP_MODE=EITHER \
  mvn -f services/api spring-boot:run -Dspring-boot.run.arguments="--tarazu.auth.otp.dev-log-codes=true"   # codes are logged, dev only
# real delivery: SPRING_MAIL_HOST/USERNAME/PASSWORD + OTP_EMAIL_FROM for email, TARAZU_AUTH_OTP_SMS_URL + OTP_SMS_AUTH_VALUE/TEMPLATE_ID for SMS (see application.properties)
# then open http://localhost:5173/#/onboarding, or POST /v1/auth/signup/start; OTP_MODE = EMAIL | PHONE | EITHER | BOTH
```

### Try device sync locally with the seeded dev merchant
```bash
psql postgresql://tarazu_app:tarazu_app_dev@localhost:5432/tarazu -f infra/postgres/dev-seed.sql   # one dev merchant
TARAZU_AUTH_DEV_HEADER_ENABLED=true mvn -f services/api spring-boot:run                          # dev header on, never in production
curl -X PUT localhost:8080/v1/identity/devices/$(uuidgen) \
  -H 'X-Tenant-Id: 00000000-0000-7000-8000-000000000001' -H 'X-Staff-Id: 00000000-0000-7000-8000-000000000004' \
  -H 'Content-Type: application/json' -d '{"storeId":"00000000-0000-7000-8000-000000000003","label":"dev"}'   # copy "token"
```
Open `http://localhost:5173/#/dev/sync` (dev builds only), paste the device id/token and record test sales; see `docs/web-sync.md`
and `infra/powersync/` for the PowerSync service.

Tests and rules: see `CLAUDE.md`. Decisions: `docs/adr/`.
