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
 * one.
 *
 * The `attempts` compare-and-swap alone is NOT sufficient for this, and a
 * fix-round review of this file traced exactly why: it only protects two
 * invocations that raced on an *identical stale read*. It does nothing for
 * the staggered case, which is the actual threat model #50's own wording
 * names ("a scheduled run overlaps a retry") — invocation A wins the claim
 * (`attempts` 0→1) and starts `await provider.send(...)`; before A's send
 * resolves, invocation B's own fresh batch SELECT legitimately observes
 * `attempts = 1` (not stale — A really did move it there) and wins its own
 * CAS against that new value. The DB write at the end is still guarded, but
 * by then both invocations have already called the real provider for the
 * same row — the external side effect the guard cannot undo.
 *
 * `claimed_at` (`migrations/0011_outbox_claim_lease.sql`) closes that window.
 * It is a lease marker, not a fourth `status` value — `status` stays the
 * fixed three-slug vocabulary end to end (`migrations/0010_outbox_delivery_state.sql`'s
 * `CHECK` constraint, contract § "Delivery state vocabulary"); there is still
 * no "claimed"/"sending" status. Instead, the claim `UPDATE` stamps
 * `claimed_at` with this invocation's own timestamp, and the batch SELECT
 * (plus the claim `UPDATE`'s own `WHERE`) excludes any row whose
 * `claimed_at` is set and not yet lease-expired. That means invocation B's
 * SELECT never even sees a row A is mid-send on — B does not merely lose a
 * CAS after already deciding to call the provider, it never decides to in the
 * first place. `CLAIM_LEASE_MS` bounds how long a claim can block re-claiming
 * before it is treated as abandoned (e.g. the invocation was evicted
 * mid-send) and made available again — a self-healing fallback, not the
 * common path; the common path clears `claimed_at` explicitly the moment a
 * row is resolved or put back for retry, so a lease outliving its invocation
 * should be rare.
 *
 * The `attempts` CAS stays as defense in depth alongside the lease check —
 * belt and suspenders, cheap to keep, and it still fully explains the
 * identical-stale-read case `test/drain.test.ts` exercises directly.
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

/**
 * How long a `claimed_at` stamp blocks a row from being re-selected by a
 * different invocation, before it is treated as abandoned. See the module
 * doc above for why this exists (closing the staggered-overlap window the
 * `attempts` CAS alone cannot). The common path never relies on this expiry
 * — `processRow` clears `claimed_at` itself the instant a row leaves the
 * "mid-send" state, whether that lands it on `sent`, `failed`, or back on
 * `queued` for the next tick's retry. This is only the fallback for a claim
 * whose invocation never got to run that cleanup (e.g. evicted mid-`await
 * provider.send()`), so a genuinely stuck row self-heals rather than staying
 * unclaimable forever. Chosen short relative to the 5-minute Cron Trigger
 * cadence (`wrangler.toml`) — long enough that no plausible single
 * `provider.send()` call for one row is still legitimately in flight, short
 * enough that a truly abandoned claim does not survive to the next tick.
 */
const CLAIM_LEASE_MS = 90_000

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

  // Excludes rows another, still-in-flight invocation currently holds a live
  // lease on — see the module doc for why this, not the `attempts` CAS alone,
  // is what actually keeps a staggered overlapping invocation from ever
  // deciding to call the provider for a row someone else is mid-send on.
  const leaseThreshold = new Date(Date.now() - CLAIM_LEASE_MS).toISOString()

  const { results } = await env.DB.prepare(
    `SELECT id, to_email, from_email, subject, body, attempts
       FROM outbox
      WHERE status = 'queued'
        AND (claimed_at IS NULL OR claimed_at <= ?)
      ORDER BY queued_at ASC, id ASC
      LIMIT ?`,
  )
    .bind(leaseThreshold, BATCH_SIZE)
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
  const now = Date.now()
  const claimedAt = new Date(now).toISOString()
  const leaseThreshold = new Date(now - CLAIM_LEASE_MS).toISOString()

  // The claim: an `attempts` compare-and-swap (catches two invocations racing
  // on an identical stale read) AND a live-lease check (catches the
  // staggered-overlap case the CAS alone cannot — see the module doc above).
  // `meta.changes === 1` means this call, and only this call, gets to make
  // the next attempt for this row: either nobody else has a live claim on it,
  // or the previous claimant's lease has expired and is being treated as
  // abandoned.
  const claim = await env.DB.prepare(
    `UPDATE outbox SET attempts = attempts + 1, claimed_at = ?
      WHERE id = ? AND status = 'queued' AND attempts = ?
        AND (claimed_at IS NULL OR claimed_at <= ?)`,
  )
    .bind(claimedAt, row.id, row.attempts, leaseThreshold)
    .run()

  if (claim.meta.changes !== 1) {
    // Someone else already holds a live claim on this row, already claimed
    // this exact attempt, or the row already moved past `queued` since the
    // SELECT above. Not an error; the row is somebody else's problem now.
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
    // Clears `claimed_at` (this row is terminal, but tidy beats a lingering
    // lease stamp on a row nothing will ever re-claim) and `last_error` — a
    // row that failed one or more times before eventually succeeding must
    // not leave a stale error sitting against a `sent` row for a future
    // `/deliveries` view (#55) or a direct D1 lookup to misread. `AND status
    // = 'queued'` matches the guard-every-write convention this module
    // follows throughout.
    await env.DB.prepare(
      `UPDATE outbox SET status = 'sent', sent_at = ?, provider_message_id = ?,
              last_error = NULL, claimed_at = NULL
        WHERE id = ? AND status = 'queued'`,
    )
      .bind(new Date().toISOString(), outcome.providerMessageId, row.id)
      .run()
    return
  }

  if (attempts >= MAX_ATTEMPTS) {
    await env.DB.prepare(
      `UPDATE outbox SET status = 'failed', last_error = ?, claimed_at = NULL
        WHERE id = ? AND status = 'queued'`,
    )
      .bind(outcome.error, row.id)
      .run()
    return
  }

  // Stays `queued` — the retry case. `attempts` already moved in the claim
  // above. `claimed_at` is cleared back to NULL here, not left to expire on
  // its own lease: backoff is the time between separate Cron Trigger fires
  // (module doc, "ONE ATTEMPT PER ROW PER INVOCATION"), not
  // `CLAIM_LEASE_MS` — the very next tick must be able to claim this row
  // immediately. `last_error` records the raw failure, for `/deliveries`
  // (#55) or a direct D1 lookup later. Contract § vocabulary: a `queued` row
  // renders identically to a customer regardless of `attempts`, so this is
  // invisible on `/outbox` until (if ever) the row actually reaches `failed`.
  await env.DB.prepare(
    `UPDATE outbox SET last_error = ?, claimed_at = NULL
      WHERE id = ? AND status = 'queued'`,
  )
    .bind(outcome.error, row.id)
    .run()
}
