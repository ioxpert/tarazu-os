# ADR 0013: Recovering rejected operations

Status: accepted (17 Oct 2026)

## Context
A rejected operation (`operation_result.status = 'rejected'`) is stored raw in the immutable log but is not in the
books. For a finalised sale that has already happened at the counter, that is the worst integrity gap: for example
`duplicate_invoice_number` after a reinstall reset the device counter, or an `internal_error` from a server bug.
Rejection stays the right answer at upload time (ADR 0002: reject only structural problems), so recovery is a
separate, audited, human step.

## Decision
- `GET /v1/sync/rejections` lists rejected operations with their raw payloads. `POST /v1/sync/rejections/{operationId}/reapply`
  takes `{payloadPatch?, reason}`. Both need `RESOLVE_FLAGS` (owner or manager).
- **As is** (no patch) fits server-side causes once fixed. **With a patch** (RFC 7386 merge over the original payload)
  fixes data problems, such as a new invoice number. A patch changes the contents of a document, so it is **owner only**.
- The same handler pipeline runs (`OperationProcessor.apply`), so every rule and policy applies to the corrected
  payload. If it is still invalid the result stays rejected and nothing is written.
- The log is not edited: it keeps what the device sent. The patch, reason, actor and outcome go to `audit_log` as
  `operation.reapplied`. Re-uploading the original later returns `duplicate` with `originalStatus` applied.
- Deferred children of a recovered entity (a credit note waiting for the invoice) are applied right after.
- The recovered document gets the number the owner chose; the printed receipt that the customer already holds still
  shows the old one. The reason field is where that mismatch is recorded.

## Not done
- The device's local `op_issue` row is not cleared automatically; it reconciles on the next status pull.
- No web screen yet: the endpoints are the contract for it.
