#!/usr/bin/env bash
# One command to test locally: Postgres, API, PowerSync, web, a seeded dev merchant and a fresh pairing code.
# LOCAL DEV ONLY: turns the dev tenant header on. Stop with Ctrl-C.
#   ./scripts/dev.sh          start everything and print a pairing code
#   ./scripts/dev.sh code     print another pairing code (stack already running)
set -euo pipefail
cd "$(dirname "$0")/.."

API=http://localhost:8080
WEB=http://localhost:5173
TENANT=00000000-0000-7000-8000-000000000001
OWNER=00000000-0000-7000-8000-000000000004
STORE=00000000-0000-7000-8000-000000000003
COMPOSE="docker compose -f infra/docker-compose.yml"
# the dev-only HS256 key the PowerSync service trusts (infra/powersync/powersync.local.yaml); the API signs sync tokens with it
POWERSYNC_SECRET=$(sed -n 's/^ *k: *//p' infra/powersync/powersync.local.yaml)

pairing_code() {
  curl -fsS -X POST "$API/v1/identity/device-pairings" \
    -H "X-Tenant-Id: $TENANT" -H "X-Staff-Id: $OWNER" -H 'Content-Type: application/json' \
    -d "{\"storeId\":\"$STORE\",\"label\":\"dev counter\"}" |
    sed -n 's/.*"code":"\([^"]*\)".*/\1/p'
}

if [ "${1:-}" = code ]; then pairing_code; exit; fi

# JDK 21+ is needed; macOS Homebrew installs are not on JAVA_HOME by default.
if [ -z "${JAVA_HOME:-}" ]; then
  for j in /opt/homebrew/opt/openjdk@25 /opt/homebrew/opt/openjdk@21 /opt/homebrew/opt/openjdk; do
    [ -d "$j/libexec/openjdk.jdk/Contents/Home" ] && export JAVA_HOME="$j/libexec/openjdk.jdk/Contents/Home" && break
  done
fi

$COMPOSE up -d --wait postgres
[ -d apps/web/node_modules ] || (cd apps/web && npm ci)

pids=()
trap 'kill "${pids[@]}" 2>/dev/null || true' EXIT INT TERM

(cd services/api && TARAZU_AUTH_DEV_HEADER_ENABLED=true OTP_PEPPER="${OTP_PEPPER:-local-dev-pepper-0123456789}" \
  POWERSYNC_URL=http://localhost:8081 POWERSYNC_JWT_SECRET="$POWERSYNC_SECRET" \
  ./mvnw -q spring-boot:run -Dspring-boot.run.jvmArguments="-Duser.timezone=UTC") &
pids+=($!)
(cd apps/web && npm run dev -- --host 127.0.0.1) &
pids+=($!)

echo "Waiting for the API (first start compiles, ~1 min)..."
until curl -fs "$API/actuator/health" >/dev/null 2>&1; do sleep 2; done
$COMPOSE exec -T postgres \
  psql -q -v ON_ERROR_STOP=1 -U tarazu_app -d tarazu < infra/postgres/dev-seed.sql >/dev/null
# PowerSync needs the tables Flyway just made: replication role, SELECT policies, publication (repeatable), then the service
$COMPOSE exec -T postgres psql -q -U postgres -v ON_ERROR_STOP=1 -f - < infra/powersync/setup.sql >/dev/null 2>&1
$COMPOSE --profile sync up -d powersync >/dev/null

cat <<MSG

  Web:           $WEB
  API:           $API
  PowerSync:     http://localhost:8081
  Pairing code:  $(pairing_code)   (type it on the setup screen; valid 10 min, one use)
  More codes:    ./scripts/dev.sh code

MSG
wait
