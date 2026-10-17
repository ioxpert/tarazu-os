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
Tests and rules: see `CLAUDE.md`.
