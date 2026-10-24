# PowerSync (runs locally in compose; still not exercised in CI)

The device writes operations to a local SQLite op log and uploads them to our API (`POST /v1/sync/upload`).
PowerSync only streams the server's **read model** back down. Nothing here runs in CI; treat these files as a
reviewed starting point and verify them against a real PowerSync service (open question in the PR).

| File | Purpose |
|---|---|
| `sync-rules.yaml` | One bucket per merchant (`merchant_id` JWT claim) with the read-model tables, plus a global tax-rule bucket |
| `powersync.example.yaml` | Example service config (replication source, bucket storage, HS256 key) |

## Run locally

Easiest: `./scripts/dev.sh` starts Postgres (with logical replication), the API (with the PowerSync URL and the dev key), the
PowerSync service and the web app, then prints a pairing code.

By hand:
1. `docker compose -f infra/docker-compose.yml up -d postgres` (it runs with `wal_level=logical`; recreate the container once if
   you had it from before: `up -d --force-recreate postgres`).
2. Start the API once so Flyway creates the tables, with `POWERSYNC_URL=http://localhost:8081` and `POWERSYNC_JWT_SECRET` set to the
   `k` value in `powersync.local.yaml` (a throwaway dev key, committed on purpose).
3. Run `setup.sql` as the Postgres superuser. It is repeatable. It creates the `powersync_repl` and `powersync_storage` roles, the
   storage database, SELECT-only policies on exactly the synced tables, and the publication. **No `BYPASSRLS`** (ADR 0006): row-level
   security applies to every role, so the replication role gets policies instead.
   `docker compose -f infra/docker-compose.yml exec -T postgres psql -U postgres -v ON_ERROR_STOP=1 -f - < infra/powersync/setup.sql`
4. `docker compose -f infra/docker-compose.yml --profile sync up -d powersync` (service on `http://localhost:8081`).
5. Pair a device and open the web app; the status badge reads "Backed up" once uploads and downloads are caught up.

The service logs `PSYNC_S1145` ("Row Level Security is enabled ... run ALTER ROLE ... BYPASSRLS") for each table. That is its
generic check for `BYPASSRLS`; it does not look at policies. Ignore it, as long as the first snapshot copies rows.

| File | Purpose |
|---|---|
| `setup.sql` | Roles, storage database, policies and publication (table list must equal `sync-rules.yaml`; a web test checks it) |
| `powersync.local.yaml` | Service config for the compose service (local dev only, dev key inside) |
| `powersync.example.yaml` | Example config pointing at host.docker.internal, for running the service outside compose |

## Things to know
- The JWT is minted by `GET /v1/sync/credentials` (5 minute TTL, claims `sub`=device, `merchant_id`, `store_id`, `device_id`).
  A revoked device is refused there, so its sync stops within one token lifetime.
- Synthetic ids (`store_id:product_id`, `party_id`, `invoice_id:line_no`) must stay in step with
  `apps/web/src/sync/effects.ts`, which writes optimistic local rows under the same ids.
- If a read-model table or column changes, update `sync-rules.yaml`, `apps/web/src/sync/schema.ts` and the publication together.
