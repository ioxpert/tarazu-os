# PowerSync (draft, not exercised in CI)

The device writes operations to a local SQLite op log and uploads them to our API (`POST /v1/sync/upload`).
PowerSync only streams the server's **read model** back down. Nothing here runs in CI; treat these files as a
reviewed starting point and verify them against a real PowerSync service (open question in the PR).

| File | Purpose |
|---|---|
| `sync-rules.yaml` | One bucket per merchant (`merchant_id` JWT claim) with the read-model tables, plus a global tax-rule bucket |
| `powersync.example.yaml` | Example service config (replication source, bucket storage, HS256 key) |

## Run locally

1. Postgres needs logical replication. In `infra/docker-compose.yml` add to the postgres service
   `command: ["postgres", "-c", "wal_level=logical"]` and recreate it (one-off, local only).
2. As the DB admin, create a replication role and the publication. **Row-level security applies to every role,
   including the table owner (FORCE RLS), so the replication role must have `BYPASSRLS`.** It is a read-only
   replication identity, never used by the API:
   ```sql
   CREATE ROLE powersync_repl LOGIN REPLICATION BYPASSRLS PASSWORD 'powersync_repl_dev';
   GRANT SELECT ON product, party, price_version, stock_balance, khata_balance, invoice, invoice_line, payment,
                   sales_order, tax_rule TO powersync_repl;
   CREATE PUBLICATION powersync FOR TABLE product, party, price_version, stock_balance, khata_balance, invoice,
                   invoice_line, payment, sales_order, tax_rule;
   ```
   (Do this in ops tooling, not in a Flyway migration: roles and publications are environment concerns.)
3. Create the storage database/role from `powersync.example.yaml`, generate a secret
   (`openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`), put it in `powersync.example.yaml` (`k`) and start the API with
   `POWERSYNC_URL=http://localhost:8081` and `POWERSYNC_JWT_SECRET=<same secret>`.
4. Run the service, e.g.
   `docker run --rm -p 8081:8081 -v $PWD:/config journeyapps/powersync-service:latest start -r unified -c /config/powersync.example.yaml`
5. Register a device (`PUT /v1/identity/devices/{id}`), open the web app at `http://localhost:5173/#/dev/sync`,
   paste the device token and press Connect.

## Things to know
- The JWT is minted by `GET /v1/sync/credentials` (5 minute TTL, claims `sub`=device, `merchant_id`, `store_id`, `device_id`).
  A revoked device is refused there, so its sync stops within one token lifetime.
- Synthetic ids (`store_id:product_id`, `party_id`, `invoice_id:line_no`) must stay in step with
  `apps/web/src/sync/effects.ts`, which writes optimistic local rows under the same ids.
- If a read-model table or column changes, update `sync-rules.yaml`, `apps/web/src/sync/schema.ts` and the publication together.
