import type { StateReader } from '../billing/settings'
import type { LocalDb } from '../sync/schemaDb'
import { uuidv7 } from '../sync/uuid7'

/**
 * Customer consent for WhatsApp reminders (DPDP: purpose-specific, nothing pre-ticked, withdrawal as easy as granting).
 * The cashier records what the customer said at the counter ("verbal"). The event is saved on the device first and
 * reaches the server's consent ledger (POST /v1/consent/events) when there is a connection; until then the device's
 * own record answers "may I remind this customer?".
 */
export const REMINDER_PURPOSE = 'whatsapp_reminders'
/** The notice the customer was told. Bump when the wording changes. */
export const POLICY_VERSION = 'reminders-2026-10'

export type ConsentAction = 'grant' | 'withdraw'

export async function recordConsent(
  db: LocalDb,
  e: { partyId: string; action: ConsentAction; purpose?: string; channel?: 'verbal' | 'in_app' | 'paper'; now?: Date | number },
): Promise<string> {
  const nowMs = new Date(e.now ?? Date.now()).getTime()
  const id = uuidv7(nowMs)
  await db.execute(
    `INSERT INTO consent_outbox (id, party_id, purpose, action, policy_version, channel, occurred_at, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    [id, e.partyId, e.purpose ?? REMINDER_PURPOSE, e.action, POLICY_VERSION, e.channel ?? 'verbal', new Date(nowMs).toISOString()],
  )
  return id
}

/** True only when the customer's latest event for the purpose is a grant. Absence means no consent. */
export async function hasConsent(db: StateReader, partyId: string, purpose: string = REMINDER_PURPOSE): Promise<boolean> {
  const [row] = await db.getAll<{ action: string }>(
    'SELECT action FROM consent_outbox WHERE party_id = ? AND purpose = ? ORDER BY occurred_at DESC, id DESC LIMIT 1',
    [partyId, purpose],
  )
  return row?.action === 'grant'
}

/**
 * Sends unsent events oldest first. Stops at the first failure so order is kept; the server treats the event id as
 * its idempotency key, so a flush that died after the POST is safe to repeat.
 */
export async function flushConsent(
  db: LocalDb,
  cfg: { apiBase: string; deviceToken: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ sent: number; pending: number }> {
  const rows = await db.getAll<{ id: string; party_id: string; purpose: string; action: string; policy_version: string; channel: string; occurred_at: string }>(
    'SELECT id, party_id, purpose, action, policy_version, channel, occurred_at FROM consent_outbox WHERE sent_at IS NULL ORDER BY occurred_at, id',
  )
  let sent = 0
  for (const r of rows) {
    try {
      const res = await fetchImpl(`${cfg.apiBase}/v1/consent/events`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.deviceToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operationId: r.id,
          idempotencyKey: `consent:${r.id}`,
          subjectType: 'party',
          subjectId: r.party_id,
          purpose: r.purpose,
          action: r.action,
          policyVersion: r.policy_version,
          channel: r.channel,
          occurredAt: r.occurred_at,
        }),
      })
      // 4xx other than auth means the server will never accept it as is; keep it queued rather than lose the record
      if (!res.ok) break
    } catch {
      break
    }
    await db.execute('UPDATE consent_outbox SET sent_at = ? WHERE id = ?', [new Date().toISOString(), r.id])
    sent++
  }
  return { sent, pending: rows.length - sent }
}
