import { chunkForBinding } from "./d1"
import type { Env } from "./types"

/**
 * The shipped survey — issue #328: "the one moment they are most willing to
 * say [how it went] passes unused."
 *
 * Capture only. This module has no bridge event, deliberately — see
 * `src/messages.ts`'s module comment for the identical shape: a fact this
 * portal owns outright, with no coord-owned counterpart to reconcile against
 * and no reader on the other side of the bridge that would need telling.
 * `BRIDGE_EVENT_TYPES` (`src/bridge/events.ts`) is the closed vocabulary half
 * of the sync-bridge wire contract; a survey response is not a fact the
 * fleet acts on, so it never joins that list.
 *
 * ── ISSUE #329 — THE OPERATOR-FACING READ ───────────────────────────────────
 * This module's comment used to say an operator-facing read was "explicitly
 * the sibling issue this one is not". #329 is that sibling, landed after
 * this one: `loadSurveyResponses` below is the batched read behind
 * `/requests`' per-row rating badge (`routes/requests.ts`), and
 * `routes/surveys.ts` lists every response on file, newest first. Neither is
 * a new write path, and neither changes anything above this note — capture
 * is still one response per submission, still `INSERT OR IGNORE`, still no
 * `UPDATE` path. What changes is only that a response, once given, is no
 * longer visible solely on the customer's own submission page — an operator
 * can now read it too, same as every other customer-authored fact this
 * portal already exposes to an operator (`design_rounds`, `messages`) does.
 *
 * ── ONE RESPONSE PER SUBMISSION ─────────────────────────────────────────────
 * `submission_surveys` is keyed on `submission_id` alone (the customer-visible
 * `SUB-XXXXXX` reference, same wire identity every other portal-owned table
 * here uses) — a second response for the same submission is a plain primary-key
 * collision. `recordSurveyResponse` relies on that `INSERT OR IGNORE`, not on
 * checking-then-inserting, so a doubled form submit (a network retry, a second
 * tab still open on the same shipped screen) is refused the same idempotent
 * way `preview_reviews`' `PRIMARY KEY (submission_id, preview_url)` already
 * refuses a doubled preview verdict in `src/previewReviews.ts` — there is
 * deliberately no `UPDATE` path: "a second thought is a reply to a person, not
 * a form resubmission" (issue #328).
 */

/** The pinned five-point scale — real radio buttons, not a bespoke widget. */
export const SURVEY_RATINGS = [1, 2, 3, 4, 5] as const

export type SurveyRating = (typeof SURVEY_RATINGS)[number]

/** Rating -> the label read out to a screen reader and shown on the form. */
export const SURVEY_RATING_LABELS: Record<SurveyRating, string> = {
  1: "1 star — Very unhappy",
  2: "2 stars — Unhappy",
  3: "3 stars — Okay",
  4: "4 stars — Happy",
  5: "5 stars — Very happy",
}

export interface SurveyResponse {
  rating: SurveyRating
  /** Optional, unlabelled beyond a short prompt — never required. */
  comment: string | null
  createdAt: string
}

interface SurveyRow {
  rating: number
  comment: string | null
  created_at: string
}

function isSurveyRating(value: number): value is SurveyRating {
  return (SURVEY_RATINGS as readonly number[]).includes(value)
}

/**
 * Parses the posted `rating` field. Anything that is not exactly one of the
 * five pinned integers — blank, out of range, non-numeric — is `null`, the
 * same "reject rather than guess" posture `isPreviewVerdict` (`src/previewReviews.ts`)
 * takes for its own closed vocabulary.
 */
export function parseSurveyRating(raw: string): SurveyRating | null {
  if (!/^[1-5]$/.test(raw.trim())) return null
  const parsed = Number(raw.trim())
  return isSurveyRating(parsed) ? parsed : null
}

function fromRow(row: SurveyRow): SurveyResponse | null {
  // A stored rating outside 1–5 can only come from a hand-edited row — the
  // `CHECK` constraint on `submission_surveys.rating`
  // (`migrations/0028_submission_surveys.sql`) backstops this further. Skipped
  // rather than guessed at, the same defensive shape `src/messages.ts`'s
  // `fromRow` uses for an author role it does not recognise.
  if (!isSurveyRating(row.rating)) return null
  return { rating: row.rating, comment: row.comment, createdAt: row.created_at }
}

/** The customer's response to this submission's survey, or `null` if none has been given yet. */
export async function getSurveyResponse(
  env: Env,
  submissionReference: string,
): Promise<SurveyResponse | null> {
  const row = await env.DB.prepare(
    `SELECT rating, comment, created_at FROM submission_surveys WHERE submission_id = ?`,
  )
    .bind(submissionReference)
    .first<SurveyRow>()
  return row ? fromRow(row) : null
}

/**
 * Records the customer's one-time response. `INSERT OR IGNORE` against the
 * `submission_id` primary key is the whole guard — a second attempt for the
 * same submission changes nothing and reports `recorded: false`, the caller's
 * signal that this submission already has a response and the request should
 * be refused rather than treated as a fresh one.
 */
export async function recordSurveyResponse(
  env: Env,
  submissionReference: string,
  rating: SurveyRating,
  comment: string | null,
): Promise<{ recorded: boolean }> {
  const createdAt = new Date().toISOString()
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO submission_surveys (submission_id, rating, comment, created_at)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(submissionReference, rating, comment, createdAt)
    .run()
  return { recorded: (result.meta?.changes ?? 0) > 0 }
}

/**
 * Every response on file for the given submission references, keyed by
 * reference — issue #329's batched read behind `/requests`' per-row rating
 * badge (`routes/requests.ts`'s `listAllRequestRows`). Same "one batched
 * lookup, not one query per row" shape `loadSignoffStates` (`src/rounds.ts`)
 * already established for that same list, chunked through `chunkForBinding`
 * for D1's bound-parameter ceiling (`src/d1.ts`) exactly the way that
 * function is.
 *
 * A reference with no response on file is simply absent from the returned
 * map. This function does not distinguish "not shipped yet" from "shipped,
 * nobody answered" — it only reports what is actually on file; the caller
 * (issue #329's own "say plainly when nobody answered") is the one that
 * knows a submission's status and so is the one that can tell those two
 * apart.
 */
export async function loadSurveyResponses(
  env: Env,
  submissionReferences: string[],
): Promise<Map<string, SurveyResponse>> {
  const responses = new Map<string, SurveyResponse>()
  if (submissionReferences.length === 0) return responses

  const batches = await Promise.all(
    chunkForBinding(submissionReferences).map(async (references) => {
      const placeholders = references.map(() => "?").join(", ")
      const { results } = await env.DB.prepare(
        `SELECT submission_id, rating, comment, created_at
           FROM submission_surveys
          WHERE submission_id IN (${placeholders})`,
      )
        .bind(...references)
        .all<SurveyRow & { submission_id: string }>()
      return results ?? []
    }),
  )

  for (const row of batches.flat()) {
    const response = fromRow(row)
    if (response) responses.set(row.submission_id, response)
  }
  return responses
}
