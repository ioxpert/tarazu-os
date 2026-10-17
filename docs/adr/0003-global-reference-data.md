# ADR 0003: Global reference data is the one exception to "every table has tenant_id"

Status: accepted (17 Oct 2026). Amends locked rule 3 in CLAUDE.md.

## Context
GST rate rules (HSN prefix to rate) and thresholds are identical for every merchant, change by government
notification, and must change without an app release ("server-controlled, effective-dated rule tables"). Copying
them into every tenant would make each rate change a fan-out migration and let tenants drift.

## Decision
`tax_rule` and `tax_threshold` have no `tenant_id`. They are still `ENABLE` + `FORCE ROW LEVEL SECURITY`, with a
read-only policy (`FOR SELECT USING (true)`), and the API role has `SELECT` only. Ops maintain them with the admin
role (a migration or a controlled script). Rows are effective-dated and append-only (`tax_rule` has the append-only
trigger; a correction is a new row with a later `effective_from`). For an HSN code and date the rule is the most
specific matching prefix with the latest `effective_from` not after the date. `GET /v1/tax/rules?sinceId=` is a change
feed for devices; the sync rules also stream the table. No rates are seeded in migrations: the figures must come from
the official notification (`notification_ref` records which), loaded by whoever owns tax content.

Any further global table needs its own ADR. `SchemaGuardIT` has an explicit allow-list and fails otherwise.

## Consequences
- Servers validate invoices against the rule in force on the invoice date and flag mismatches (`tax_rate_mismatch`),
  which is how a device with a stale table is caught.
- Per-merchant overrides (e.g. a cess) are not modelled; add a tenant table when a real case appears.
