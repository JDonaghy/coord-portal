import { lifecycleStatementsForPush } from "../lifecycle"
import { recordNotificationForStatus } from "../notifications"
import { roundStatementsForPush } from "../rounds"
import { getSubmissionByReference, isSubmissionStatus } from "../submissions"
import type { Env } from "../types"
import { isCoordOwnedField, ownerOf } from "./ownership"

/**
 * `POST /api/bridge/push` — applying the coordinator's writes.
 *
 * Three rules, and every branch below is one of them:
 *
 * 1. **Idempotent by `(submission_id, revision)`.** Assume every request
 *    arrives twice, because a daemon that times out mid-push and retries is not
 *    a bug — it is the normal case. A revision at or below the stored watermark
 *    is `already_applied`, which is a *success*: it means the fleet's intent is
 *    already reflected here.
 * 2. **Whole-update atomicity.** If any field in an update is rejected, nothing
 *    in that update is applied. A `{status, outcome}` update is not "a good
 *    status write with a bad passenger" — it is one intent, and half of it was
 *    unauthorised, so none of it lands.
 * 3. **A rejection is an outcome, not a transport failure.** Everything here
 *    returns 200 with a per-item verdict. A batch is a batch: one bad item does
 *    not fail its siblings, and the daemon needs to know precisely which item
 *    it got wrong.
 *
 * A rejected update also leaves the watermark alone. Recording its revision
 * would be applying part of it, and would silently swallow the daemon's
 * corrected retry at that same revision — it would come back
 * `already_applied` having never been applied at all.
 */

/**
 * The most updates one push may carry.
 *
 * Not a contract term — the contract says nothing about batch size — but a
 * Worker limit made visible. Each update costs at least two D1 calls (a
 * lookup and a write), and D1 calls are subrequests, which Workers caps per
 * request. A status-setting update that lands (see `recordNotificationForStatus`
 * below) can cost more still — one more for the outbox insert, and, for
 * `awaiting-signoff`, one more again to read back the design round. That extra
 * work is deferred via `ctx.waitUntil` so it never blocks the response, but it
 * still runs inside this request's lifetime and so still counts against its
 * subrequest budget. An uncapped batch fails somewhere in the middle with a
 * platform error and no per-item results, which is the least useful possible
 * answer for a daemon that then has to work out what landed. 50 mirrors the
 * pull page size; a daemon with more than that to say makes another request.
 */
export const MAX_PUSH_UPDATES = 50

export type PushOutcome = "applied" | "already_applied" | "rejected"

export interface PushResult {
  submission_id: string
  outcome: PushOutcome
  reason?: string
}

export interface PushUpdate {
  submissionId: string
  revision: number
  fields: Record<string, unknown>
}

/**
 * Applies a batch, one update at a time, in request order.
 *
 * Sequential rather than `Promise.all`: two updates in the same batch may name
 * the same submission (the daemon is allowed to send a run of revisions), and
 * the second must see what the first did. Concurrency here would make the
 * result order a coin toss on state, not just on timing.
 */
export async function applyUpdates(
  env: Env,
  rawUpdates: unknown[],
  ctx?: ExecutionContext,
): Promise<PushResult[]> {
  const results: PushResult[] = []
  for (const raw of rawUpdates) {
    results.push(await applyUpdate(env, raw, ctx))
  }
  return results
}

async function applyUpdate(env: Env, raw: unknown, ctx?: ExecutionContext): Promise<PushResult> {
  const parsed = parseUpdate(raw)
  if ("error" in parsed) {
    return { submission_id: parsed.submissionId, outcome: "rejected", reason: parsed.error }
  }
  const update = parsed.update
  const submissionId = update.submissionId

  // Ownership first: an unauthorised field is a fact about the request, and
  // answering it does not require the row to exist or the revision to be fresh.
  for (const field of Object.keys(update.fields)) {
    const owner = ownerOf(field)
    if (owner === "portal") {
      return { submission_id: submissionId, outcome: "rejected", reason: `not_owned:${field}` }
    }
    if (owner === "unknown") {
      return {
        submission_id: submissionId,
        outcome: "rejected",
        reason: `unknown_field:${field}`,
      }
    }
  }

  const submission = await getSubmissionByReference(env, submissionId)
  if (!submission) {
    return { submission_id: submissionId, outcome: "rejected", reason: "unknown_submission" }
  }

  if (submission.coordRevision !== null && update.revision <= submission.coordRevision) {
    return { submission_id: submissionId, outcome: "already_applied" }
  }

  const status = update.fields["status"]
  if (status !== undefined && !isSubmissionStatus(status)) {
    // A status outside the pinned vocabulary has no pill and no screen. Better
    // the daemon hears about it than the customer sees a blank badge.
    return { submission_id: submissionId, outcome: "rejected", reason: "invalid_value:status" }
  }

  const updatedAt = new Date().toISOString()
  const statements: D1PreparedStatement[] = []

  // The watermark moves in the same batch as the write it authorises, so a
  // half-applied update cannot exist even if this Worker dies mid-flight.
  //
  // The `coord_revision <` guard re-checks in SQL what was just checked in JS.
  // Between the lookup above and this write, a concurrent push could have
  // landed a *newer* revision, and applying this one on top would roll the
  // customer's screen backwards. Losing to a newer write is fine — the daemon
  // is told `applied`, and what it wanted is already superseded by its own more
  // recent intent.
  if (typeof status === "string") {
    statements.push(
      env.DB.prepare(
        `UPDATE submissions SET status = ?, coord_revision = ?
          WHERE reference = ? AND (coord_revision IS NULL OR coord_revision < ?)`,
      ).bind(status, update.revision, submissionId, update.revision),
    )
  } else {
    statements.push(
      env.DB.prepare(
        `UPDATE submissions SET coord_revision = ?
          WHERE reference = ? AND (coord_revision IS NULL OR coord_revision < ?)`,
      ).bind(update.revision, submissionId, update.revision),
    )
  }

  for (const [field, value] of Object.entries(update.fields)) {
    // `lifecycle_event` (#111) is append-only, like `design_round` below it —
    // a second push must not overwrite the first the way this loop's
    // last-value mirror would. It gets its own archive instead.
    if (field === "status" || field === "lifecycle_event" || !isCoordOwnedField(field)) continue
    // Coord-owned facts this milestone has no column for. Kept verbatim rather
    // than dropped: acknowledging a write and then discarding it is the one
    // behaviour a sync bridge must never have. #10/#13 render them.
    statements.push(
      env.DB.prepare(
        `INSERT INTO coord_facts (submission_id, field, value, revision, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(submission_id, field) DO UPDATE SET
           value = excluded.value,
           revision = excluded.revision,
           updated_at = excluded.updated_at
         WHERE excluded.revision >= coord_facts.revision`,
      ).bind(submissionId, field, JSON.stringify(value ?? null), update.revision, updatedAt),
    )
  }

  // `design_round` / `decomposition` / `artifacts` additionally land in the
  // versioned round archive (#13). `coord_facts` above keeps only the *current*
  // value of each field — a second push replaces the first — and issue #13's
  // whole point is that every previous round stays readable. Same batch, so a
  // round can never exist without the push that authorised it.
  statements.push(
    ...(await roundStatementsForPush(env, submissionId, update.fields, update.revision, updatedAt)),
  )

  // Issue #111's timeline entry, if this push carries one — same
  // batch-not-awaited-elsewhere shape as the round archive just above, and no
  // extra D1 read: unlike a round, an event never needs to look at what is
  // already stored to know where it lands.
  statements.push(
    ...lifecycleStatementsForPush(env, submissionId, update.fields, update.revision, updatedAt),
  )

  // No event is emitted here, ever. The portal only publishes customer-authored
  // facts; echoing the daemon's own write back at it is how two synced systems
  // talk themselves into an infinite loop. See src/bridge/events.ts.
  const batchResults = await env.DB.batch(statements)

  // Issue #14: exactly the three customer-actionable-or-terminal statuses
  // generate an email, and only a push that actually names `status` counts —
  // the round/decomposition/artifact churn a submission accumulates between
  // sends must never itself trigger one.
  //
  // `statements[0]` is always the watermark UPDATE above, guarded by
  // `coord_revision IS NULL OR coord_revision < ?`. If a concurrent push for
  // this same submission landed a newer revision between the lookup and this
  // batch, that guard makes our own write a no-op — `meta.changes` is `0` —
  // and `status` here is this (losing) request's now-stale value, not
  // whatever the submission actually ended up at. Recording a notification
  // for it would send an email for a status the customer's screen never
  // showed, so a loss is treated exactly like a rejection: no send. The
  // daemon still hears `applied`; only the notification is skipped.
  if (typeof status === "string" && (batchResults[0]?.meta.changes ?? 0) > 0) {
    // Deferred rather than awaited: this is a second, un-batched D1 round
    // trip (a third and fourth for `awaiting-signoff`, which reads back the
    // design round it just published — see `emailContent`), and it must
    // never be able to fail a request whose real, authoritative write already
    // committed above. `ctx.waitUntil` keeps it alive past the response
    // without holding the response open for it; the sealed acceptance suite
    // and `e2e/notifications.spec.ts` already poll the outbox rather than
    // expect it populated synchronously ("digest-first, not instant"). Where
    // no `ExecutionContext` is available (unit tests calling this directly),
    // fall back to awaiting it inline — still guarded by the same `catch`.
    const notify = recordNotificationForStatus(
      env,
      submission,
      status,
      update.revision,
      updatedAt,
    ).catch((err) => {
      console.error(
        `notification write failed for ${submissionId} rev ${update.revision}:`,
        err,
      )
    })
    if (ctx) {
      ctx.waitUntil(notify)
    } else {
      await notify
    }
  }

  return { submission_id: submissionId, outcome: "applied" }
}

type ParsedUpdate =
  | { update: PushUpdate }
  | { error: string; submissionId: string }

function parseUpdate(raw: unknown): ParsedUpdate {
  if (!isPlainObject(raw)) return { error: "malformed_update", submissionId: "" }

  const submissionIdValue = raw["submission_id"]
  const submissionId =
    typeof submissionIdValue === "string" ? submissionIdValue.trim() : ""
  if (!submissionId) return { error: "malformed_update", submissionId: "" }

  const revision = raw["revision"]
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
    return { error: "malformed_update", submissionId }
  }

  const fields = raw["fields"]
  if (!isPlainObject(fields)) return { error: "malformed_update", submissionId }
  if (Object.keys(fields).length === 0) {
    return { error: "no_fields", submissionId }
  }

  return { update: { submissionId, revision, fields } }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
