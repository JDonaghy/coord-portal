import { selectMailProvider, type MailProvider } from "./mailProvider"
import type { Env } from "./types"

/**
 * The drain — issue #50's own title: "a Cron Trigger that sends queued
 * outbox rows, retries, and gives up visibly."
 *
 * WHY A CRON AND NOT THE REQUEST PATH (#50's own heading, quoted because it is
 * the whole design constraint here): issue #14 shipped three defects that all
 * traced back to doing notification work inside the request path. "The
 * outbox exists precisely so sending happens somewhere a failure cannot reach
 * the customer's request." Nothing in this module is ever called from a
 * request handler; `src/index.ts`'s `scheduled()` export is its only caller.
 *
 * THE THING TO GET RIGHT (#50's own heading): claiming must be safe against
 * two overlapping invocations. A read-then-write would double-send when a
 * scheduled run overlaps a retry — a customer-visible defect, not a cosmetic
 * one. `claimRow` below claims with a single conditional `UPDATE` compare-
 * and-swapped on the exact `attempts` value this invocation observed, and
 * checks `meta.changes` before ever calling the provider — the same guard
 * issue #14 needed after a reviewer found a superseded revision could still
 * record a notification (`src/bridge/updates.ts`'s `batchResults[0]?.meta.changes`).
 * A second invocation that reads the same row loses the compare-and-swap
 * (`attempts` has already moved) and skips it — "losing the race is the
 * normal case, not a fault" (contract § "Claiming safety").
 *
 * `status` stays a fixed three-slug vocabulary end to end
 * (`migrations/0010_outbox_delivery_state.sql`'s `CHECK` constraint, contract
 * § "Delivery state vocabulary") — there is no fourth "claimed"/"sending"
 * status. The claim is the `attempts` compare-and-swap alone; a claimed row
 * that is still being sent is indistinguishable, by design, from a fresh
 * `queued` row to everything except this exact race check.
 *
 * ONE ATTEMPT PER ROW PER INVOCATION. This module never retries the same row
 * twice inside a single `scheduled()` call — the "backoff" issue #50 asks for
 * is the time between separate Cron Trigger fires (or separate
 * `GET /__scheduled` calls in the sealed suite), not a busy-loop here. A
 * drain that burned every attempt in one tick would give up before a
 * customer's screen ever showed the merely-retrying state contract §
 * vocabulary pins as "indistinguishable" from fresh.
 */

/**
 * Give up after this many attempts. Contract § "Retry/backoff budget": "5" is
 * the contract's own default, not a fact discovered anywhere in issue #50 —
 * flagged here per the contract's own instruction to say so if a different
 * number is picked. This implementation keeps the contract's default.
 */
const MAX_ATTEMPTS = 5

/**
 * How many queued rows one invocation claims work from. Not pinned by #50 or
 * the contract (Notes on `50-drain.spec.ts`: "this does not pin a batch
 * size"). Generous enough that "the drain empties the whole queue" in
 * practice needs only a handful of ticks even for every row a synthetic test
 * suite could plausibly queue at once.
 */
const BATCH_SIZE = 100

export interface QueuedRow {
  id: string
  to_email: string
  from_email: string
  subject: string
  body: string
  attempts: number
}

/**
 * Claims `queued` rows and drives each one attempt closer to `sent` or
 * `failed`. Never throws past its own attempt bookkeeping — a provider call
 * that rejects or errors is exactly the case this function exists to record,
 * not to propagate; letting it throw would abort the rest of the batch over
 * one bad row.
 */
export async function drainOutbox(env: Env): Promise<void> {
  const provider = selectMailProvider(env)

  const { results } = await env.DB.prepare(
    `SELECT id, to_email, from_email, subject, body, attempts
       FROM outbox
      WHERE status = 'queued'
      ORDER BY queued_at ASC, id ASC
      LIMIT ?`,
  )
    .bind(BATCH_SIZE)
    .all<QueuedRow>()

  for (const row of results ?? []) {
    await processRow(env, provider, row)
  }
}

/**
 * Exported for `test/drain.test.ts`, which drives this directly (with a
 * fake `Env["DB"]` and a counting `MailProvider`) to assert the
 * compare-and-swap claim itself — the "thing to get right" — without needing
 * a real D1 or `wrangler dev`.
 */
export async function processRow(env: Env, provider: MailProvider, row: QueuedRow): Promise<void> {
  // The claim: a compare-and-swap on the exact `attempts` value this
  // invocation observed. `meta.changes === 1` means this call, and only this
  // call, gets to make the next attempt for this row — see the module doc
  // above for why this stands in for a claimed/sending status this schema
  // deliberately does not have.
  const claim = await env.DB.prepare(
    `UPDATE outbox SET attempts = attempts + 1
      WHERE id = ? AND status = 'queued' AND attempts = ?`,
  )
    .bind(row.id, row.attempts)
    .run()

  if (claim.meta.changes !== 1) {
    // Someone else already claimed this exact attempt — another overlapping
    // drain, or a run that already moved it past `queued` since the SELECT
    // above. Not an error; the row is somebody else's problem now.
    return
  }

  const attempts = row.attempts + 1

  const outcome = await provider.send({
    to: row.to_email,
    from: row.from_email,
    subject: row.subject,
    body: row.body,
  })

  if (outcome.ok) {
    // `AND status = 'queued'` costs nothing and matches the guard-every-write
    // convention this module follows throughout, even though the claim above
    // already means only this invocation reaches here for this row.
    await env.DB.prepare(
      `UPDATE outbox SET status = 'sent', sent_at = ?, provider_message_id = ?
        WHERE id = ? AND status = 'queued'`,
    )
      .bind(new Date().toISOString(), outcome.providerMessageId, row.id)
      .run()
    return
  }

  if (attempts >= MAX_ATTEMPTS) {
    await env.DB.prepare(
      `UPDATE outbox SET status = 'failed', last_error = ?
        WHERE id = ? AND status = 'queued'`,
    )
      .bind(outcome.error, row.id)
      .run()
    return
  }

  // Stays `queued` — the retry case. `attempts` already moved in the claim
  // above; only `last_error` needs recording, for `/deliveries` (#55) or a
  // direct D1 lookup later. Contract § vocabulary: a `queued` row renders
  // identically to a customer regardless of `attempts`, so this is invisible
  // on `/outbox` until (if ever) the row actually reaches `failed`.
  await env.DB.prepare(
    `UPDATE outbox SET last_error = ?
      WHERE id = ? AND status = 'queued'`,
  )
    .bind(outcome.error, row.id)
    .run()
}
