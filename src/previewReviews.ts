import { generateEventId } from "./ids"
import type { SubmissionStatus } from "./submissions"
import type { Env } from "./types"

/**
 * The pre-merge preview approval gate — issue #107.
 *
 * `SUB-C467AA` merged and shipped before the customer had actually looked at
 * the real build; approval was verbal, never tracked. This module is the
 * loop that closes that gap: the operator queues a PR's Cloudflare Pages
 * preview (pushed as `submissions.preview_url`, see `src/bridge/ownership.ts`
 * and `migrations/0015_preview_reviews.sql`) alongside `status:
 * 'quality-check'`, the customer opens it and either approves or requests
 * changes, and this side records that verdict and tells the coordinator.
 *
 * ── WHO WRITES WHAT ────────────────────────────────────────────────────────
 * `preview_url` is coord-owned and arrives over the bridge, same as `status`.
 * The verdict (`preview_reviews.verdict` / `.comment`) is portal-owned and
 * written only by the customer pressing a button — exactly the split
 * `src/rounds.ts` draws between `design_rounds` and `signoffs`, and for the
 * same reason: nothing here is co-written.
 *
 * ── AND WHY NOTHING HERE WRITES `submissions.status` ───────────────────────
 * `status` is coord-owned. Per the design doc, "the operator then merges and,
 * separately, still decides when to push `shipped`" — approving a preview
 * does not itself move the submission anywhere, unlike a design round's
 * approval (which the contract explicitly allows to derive `planned`). Only
 * "request changes" has a customer-visible consequence this side can state
 * with confidence: there is nothing left for anyone to look at until the
 * operator ships a fix, so the screen reads as `in-progress` — derived, never
 * stored, the same trick `derivedStatus` in `src/rounds.ts` already uses.
 */

/** The pinned verdict vocabulary — same two the sign-off loop uses (`src/rounds.ts`). */
export const PREVIEW_VERDICTS = ["approved", "changes-requested"] as const

export type PreviewVerdict = (typeof PREVIEW_VERDICTS)[number]

export interface PreviewReview {
  previewUrl: string
  verdict: PreviewVerdict
  /** Only ever set on `changes-requested` — approving asks for no comment. */
  comment: string | null
  createdAt: string
}

interface PreviewReviewRow {
  preview_url: string
  verdict: string
  comment: string | null
  created_at: string
}

function isPreviewVerdict(value: unknown): value is PreviewVerdict {
  return value === "approved" || value === "changes-requested"
}

/**
 * The customer's verdict on this *exact* preview URL, or `null` if nobody has
 * reviewed it yet — "pending". `preview_reviews` is keyed
 * `PRIMARY KEY (submission_id, preview_url)`, so this is a plain point
 * lookup, not an ordered query: a fresh `preview_url` push always starts
 * pending again, the same way a fresh design round does, just without a round
 * counter to key it by (see the migration's module comment).
 */
export async function getCurrentPreviewReview(
  env: Env,
  submissionReference: string,
  previewUrl: string,
): Promise<PreviewReview | null> {
  const row = await env.DB.prepare(
    `SELECT preview_url, verdict, comment, created_at
       FROM preview_reviews
      WHERE submission_id = ? AND preview_url = ?`,
  )
    .bind(submissionReference, previewUrl)
    .first<PreviewReviewRow>()
  if (!row || !isPreviewVerdict(row.verdict)) return null
  return {
    previewUrl: row.preview_url,
    verdict: row.verdict,
    comment: row.comment,
    createdAt: row.created_at,
  }
}

/** Just enough of the current preview review to derive a status from. */
export interface PreviewReviewState {
  verdict: PreviewVerdict
}

/**
 * The customer-visible status, derived — never stored. Mirrors `derivedStatus`
 * in `src/rounds.ts`: `status` is coord-owned, so a customer requesting
 * changes on a preview is not written back to `in-progress` by this side —
 * what they see reads as if it were, until the fleet notices and pushes its
 * own next status.
 *
 * Approval derives nothing — the stored `quality-check` already reads
 * correctly ("going through a final check before it ships"), and per the
 * design doc the operator's merge and eventual `shipped` push are separate,
 * manual steps this issue does not automate. Only `changes-requested` needs a
 * derivation: nothing is left for the customer to look at until a new preview
 * lands, so the screen should read `in-progress`, not "waiting on you".
 */
export function derivedQualityCheckStatus(
  stored: SubmissionStatus,
  state: PreviewReviewState | null,
): SubmissionStatus {
  if (stored !== "quality-check" || state === null) return stored
  return state.verdict === "changes-requested" ? "in-progress" : stored
}

/**
 * Records the customer's verdict on the current preview build and publishes
 * it to the coordinator as a `preview.approved` / `preview.changes_requested`
 * bridge event — in one `DB.batch()`, idempotently against a doubled submit.
 *
 * Exactly `recordSignoff`'s shape (`src/rounds.ts`), for exactly the same
 * reasons: the event insert is guarded by `WHERE NOT EXISTS (... preview_reviews
 * ...)`, evaluated before the verdict row lands, so a retry records nothing
 * and emits nothing while the first attempt records and emits both or
 * neither. `preview_reviews`'s own `PRIMARY KEY (submission_id, preview_url)`
 * is the second line of defence — `INSERT OR IGNORE` is then a true no-op on
 * a genuine duplicate, not merely conditional on the SELECT above having run
 * first.
 */
export async function recordPreviewReview(
  env: Env,
  submissionReference: string,
  previewUrl: string,
  verdict: PreviewVerdict,
  comment: string | null,
): Promise<{ recorded: boolean }> {
  const createdAt = new Date().toISOString()
  const type = verdict === "approved" ? "preview.approved" : "preview.changes_requested"

  const [eventInsert] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO bridge_events (id, type, submission_id, occurred_at, payload)
       SELECT ?, ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM preview_reviews WHERE submission_id = ? AND preview_url = ?
        )`,
    ).bind(
      generateEventId(),
      type,
      submissionReference,
      createdAt,
      JSON.stringify({ preview_url: previewUrl, verdict, comment }),
      submissionReference,
      previewUrl,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO preview_reviews (submission_id, preview_url, verdict, comment, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(submissionReference, previewUrl, verdict, comment, createdAt),
  ])

  return { recorded: (eventInsert?.meta.changes ?? 0) > 0 }
}
