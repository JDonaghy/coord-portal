import { generateEventId } from "./ids"
import { getCoordFactRecord } from "./submissions"
import type { Env } from "./types"

/**
 * The question channel — issue #11's raise -> pause -> resume loop.
 *
 * `question` is coord-owned (`src/bridge/ownership.ts`) and already lands in
 * `coord_facts` the same way `onhold_since` and every other column-less
 * coord fact does (see `src/bridge/updates.ts`). What this module adds is the
 * customer's half: recording that a given question has been answered, and
 * telling the two apart so the composer only ever renders for a question that
 * is actually still open.
 *
 * "Open" is defined against the coord fact's own `revision`, not against its
 * value — a daemon that re-pushes the *same* question text still gets a new
 * revision, and per issue #11 ("a second question re-opens the pause") that
 * must re-open the composer exactly like a genuinely different question
 * would. Nothing here compares question text.
 */

export interface OpenQuestion {
  /** The value the daemon pushed. Type is not pinned by the contract — render defensively. */
  value: unknown
  /** The `coord_facts.revision` this question was pushed at — the answer's key. */
  revision: number
}

/**
 * The question currently open on this submission, or `null` if there is
 * either no question on record at all, or the most recent one has already
 * been answered.
 */
export async function getOpenQuestion(env: Env, submissionReference: string): Promise<OpenQuestion | null> {
  const question = await getCoordFactRecord(env, submissionReference, "question")
  if (!question) return null
  if (await isAnswered(env, submissionReference, question.revision)) return null
  return { value: question.value, revision: question.revision }
}

/** Whether the question at `revision` has a recorded customer answer already. */
export async function isAnswered(
  env: Env,
  submissionReference: string,
  revision: number,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 FROM question_answers WHERE submission_id = ? AND question_revision = ?`,
  )
    .bind(submissionReference, revision)
    .first()
  return row !== null
}

/**
 * Records the customer's answer and publishes it to the coordinator as a
 * `question.answered` bridge event — in one `DB.batch()`, and idempotently
 * against a doubled form submit (a slow network, an impatient double-click)
 * without a separate check-then-write round trip that a concurrent request
 * could race.
 *
 * The event insert is itself guarded by `WHERE NOT EXISTS (... question_answers
 * ...)`, evaluated *before* the answer row below it lands — same statement
 * order trick `src/bridge/updates.ts` uses for its `coord_revision <` guard.
 * On the first call for a given `(submission_id, question_revision)` the
 * guard passes and the event is appended; on a retry of the same call the
 * `question_answers` row from the first attempt already exists, the guard
 * fails, and the event is silently skipped — the coordinator hears "answered"
 * once, not twice, with no window where the answer is recorded but the event
 * never fires (or vice versa): both statements commit together or neither
 * does, exactly like `createSubmission`'s event pairing.
 *
 * Never touches `submissions.status`. Resuming the thread — moving the
 * submission off `Needs your input` — is the coordinator's call alone, made
 * the next time it pushes a status (see `src/bridge/updates.ts`); this
 * function is not that call and must not try to be.
 */
export async function recordAnswer(
  env: Env,
  submissionReference: string,
  questionRevision: number,
  answer: string,
): Promise<{ recorded: boolean }> {
  const answeredAt = new Date().toISOString()

  const [eventInsert] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO bridge_events (id, type, submission_id, occurred_at, payload)
       SELECT ?, 'question.answered', ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM question_answers WHERE submission_id = ? AND question_revision = ?
        )`,
    ).bind(
      generateEventId(),
      submissionReference,
      answeredAt,
      JSON.stringify({ answer }),
      submissionReference,
      questionRevision,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO question_answers (submission_id, question_revision, answer, answered_at)
       VALUES (?, ?, ?, ?)`,
    ).bind(submissionReference, questionRevision, answer, answeredAt),
  ])

  // Whether the guard passed on *this* call — false means a prior call
  // already recorded this exact question's answer, and this one changed
  // nothing (D1's `OR IGNORE` still reports success, so this is the only
  // signal the caller has to tell "recorded" from "already was").
  return { recorded: (eventInsert?.meta.changes ?? 0) > 0 }
}
