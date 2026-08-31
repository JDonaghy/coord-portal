import { appendEventStatement } from "./bridge/events"
import { generateEventId } from "./ids"
import { getCoordFactRecord } from "./submissions"
import type { Env } from "./types"

/**
 * The question channel — issue #11's raise -> pause -> resume loop, extended
 * by issue #159 with a third state: an operator-relayed answer, awaiting the
 * customer's one-tap confirmation (or correction) before it counts as
 * genuinely theirs.
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
 *
 * `relayed_answer` (issue #159) is also coord-owned and mirrored the same
 * way, matched against the currently open question by the `question_revision`
 * it carries in its own value — not by arrival order, since the daemon may
 * push `relayed_answer` before or after the `question` it answers, or push a
 * new one after an earlier relay for the same question turned out to be
 * wrong. See `getQuestionScreenState` for how the two facts, plus this
 * module's own `question_answers` table, combine into one of four screens.
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

/* ─────────────────────── relayed answers (issue #159) ─────────────────────── */

/** The way the operator says they got this answer — the wire vocabulary is closed. */
export type RelaySource = "verbal" | "phone" | "email"

const RELAY_SOURCES: ReadonlySet<string> = new Set<RelaySource>(["verbal", "phone", "email"])

/** One operator-relayed answer, as pushed in the `relayed_answer` coord fact's value. */
export interface RelayedAnswer {
  /** The answer text as the operator recorded it — never rendered as the customer's own words. */
  answer: string
  source: RelaySource
  /** The `question` fact's `revision` this relay claims to answer. */
  questionRevision: number
  /** When the operator says the exchange happened, as pushed — not this Worker's clock. */
  relayedAt: string
  /** The `coord_facts.revision` this relay itself was pushed at — its own identity. */
  revision: number
}

/**
 * The current `relayed_answer` fact, or `null` if the daemon has never pushed
 * one, or pushed something this screen cannot make sense of.
 *
 * The value's shape is coord-authored and, like `question`'s, not enforced by
 * the bridge push route (`src/bridge/updates.ts` accepts any JSON-serialisable
 * value for a coord-owned field it has no column for) — so this reads
 * defensively and treats anything malformed exactly like "no relay on
 * record", rather than letting a bad push crash the pause screen or, worse,
 * render half a relay as though it were whole.
 */
export async function getRelayedAnswer(
  env: Env,
  submissionReference: string,
): Promise<RelayedAnswer | null> {
  const record = await getCoordFactRecord(env, submissionReference, "relayed_answer")
  if (!record || typeof record.value !== "object" || record.value === null) return null
  const value = record.value as Record<string, unknown>

  const answer = value["answer"]
  const source = value["source"]
  const questionRevision = value["question_revision"]
  const relayedAt = value["relayed_at"]

  if (typeof answer !== "string" || answer.trim() === "") return null
  if (typeof source !== "string" || !RELAY_SOURCES.has(source)) return null
  if (typeof questionRevision !== "number" || !Number.isFinite(questionRevision)) return null
  if (typeof relayedAt !== "string" || relayedAt === "") return null

  return {
    answer,
    source: source as RelaySource,
    questionRevision,
    relayedAt,
    revision: record.revision,
  }
}

/** One row of `question_answers`, with the provenance columns issue #159 adds. */
interface AnswerRecord {
  answer: string
  answeredAt: string
  source: "client" | "relay_confirmed"
  relayedAnswerRevision: number | null
}

async function getAnswerRecord(
  env: Env,
  submissionReference: string,
  questionRevision: number,
): Promise<AnswerRecord | null> {
  const row = await env.DB.prepare(
    `SELECT answer, answered_at, source, relayed_answer_revision
       FROM question_answers WHERE submission_id = ? AND question_revision = ?`,
  )
    .bind(submissionReference, questionRevision)
    .first<{
      answer: string
      answered_at: string
      source: string
      relayed_answer_revision: number | null
    }>()
  if (!row) return null
  return {
    answer: row.answer,
    answeredAt: row.answered_at,
    source: row.source === "relay_confirmed" ? "relay_confirmed" : "client",
    relayedAnswerRevision: row.relayed_answer_revision,
  }
}

/**
 * The one thing `needsInputDetail` (`src/routes/submission.ts`) needs to
 * decide what to render, and `submitAnswer` / `submitConfirmRelay` need to
 * decide what a POST is allowed to do — the whole issue #159 state machine in
 * one read.
 *
 *   "closed"          no question on record, or the open one has already been
 *                      answered directly (or corrected) — nothing to show.
 *   "open"             a question with no matching relayed answer — the
 *                      ordinary pause composer (`pausedDetail`), unchanged
 *                      from issue #11.
 *   "relay-pending"    the open question's revision matches the current
 *                      relay's `questionRevision`, and nobody has confirmed
 *                      or corrected it yet.
 *   "relay-confirmed"  the customer has confirmed this exact relay (by its
 *                      own revision) — the question is technically answered
 *                      (`getOpenQuestion` would return `null`), but issue
 *                      #159 asks for a "reopen and correct" affordance to
 *                      keep surfacing, so this is reported as its own state
 *                      rather than collapsing into "closed".
 *
 * A relay whose `questionRevision` does not match the currently open
 * question — stale (it answered a question that has since been superseded)
 * or premature (pushed ahead of the `question` it will answer) — is simply
 * not "the" relay for this read, exactly as a `relayed_answer` push carries
 * no ordering guarantee relative to `question` per this module's own doc
 * comment.
 */
export type QuestionScreenState =
  | { kind: "closed" }
  | { kind: "open"; question: OpenQuestion }
  | { kind: "relay-pending"; question: OpenQuestion; relay: RelayedAnswer }
  | {
      kind: "relay-confirmed"
      question: OpenQuestion
      relay: RelayedAnswer
      answer: string
      answeredAt: string
    }

export async function getQuestionScreenState(
  env: Env,
  submissionReference: string,
): Promise<QuestionScreenState> {
  const question = await getCoordFactRecord(env, submissionReference, "question")
  if (!question) return { kind: "closed" }
  const open: OpenQuestion = { value: question.value, revision: question.revision }

  const relayRecord = await getRelayedAnswer(env, submissionReference)
  const relay = relayRecord && relayRecord.questionRevision === question.revision ? relayRecord : null

  const answered = await getAnswerRecord(env, submissionReference, question.revision)
  if (!answered) {
    return relay ? { kind: "relay-pending", question: open, relay } : { kind: "open", question: open }
  }

  if (relay && answered.source === "relay_confirmed" && answered.relayedAnswerRevision === relay.revision) {
    return {
      kind: "relay-confirmed",
      question: open,
      relay,
      answer: answered.answer,
      answeredAt: answered.answeredAt,
    }
  }
  return { kind: "closed" }
}

/**
 * Confirming an operator-relayed answer — "Yes, that's right" — issue #159.
 *
 * Deliberately the same shape as `recordAnswer` above (event-append guarded
 * by `NOT EXISTS`, evaluated before the write it guards, in the same
 * `DB.batch()`): idempotent against a doubled tap, and the coordinator hears
 * `question.answered` exactly once. The payload's `relay` object is the one
 * difference from a directly-typed answer — it is what lets the coordinator's
 * own archive (#2867) keep recording "the customer confirmed a relay" as a
 * distinct fact from "the customer typed this", even though, from this
 * table's point of view (`question_answers.source = 'relay_confirmed'`), the
 * question is now simply answered.
 *
 * Never touches `submissions.status`, for the same reason `recordAnswer`
 * doesn't.
 */
export async function confirmRelayedAnswer(
  env: Env,
  submissionReference: string,
  questionRevision: number,
  relay: RelayedAnswer,
): Promise<{ recorded: boolean }> {
  const answeredAt = new Date().toISOString()

  const [eventInsert] = await env.DB.batch([
    appendEventStatement(
      env,
      {
        type: "question.answered",
        submissionReference,
        occurredAt: answeredAt,
        payload: {
          answer: relay.answer,
          relay: { source: relay.source, relayed_at: relay.relayedAt, confirmed: true },
        },
      },
      {
        clause: `WHERE NOT EXISTS (
          SELECT 1 FROM question_answers WHERE submission_id = ? AND question_revision = ?
        )`,
        bindings: [submissionReference, questionRevision],
      },
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO question_answers
         (submission_id, question_revision, answer, answered_at, source, relayed_answer_revision)
       VALUES (?, ?, ?, ?, 'relay_confirmed', ?)`,
    ).bind(submissionReference, questionRevision, relay.answer, answeredAt, relay.revision),
  ])

  return { recorded: (eventInsert?.meta.changes ?? 0) > 0 }
}

/**
 * Correcting a relay-confirmed answer — "Not quite — let me correct it",
 * reached either before confirming (in which case the customer never
 * actually calls this — see `submitAnswer`, which uses plain `recordAnswer`
 * when nothing has been confirmed yet, because there is nothing to supersede)
 * or, per issue #159's "a client can reopen and correct after confirming",
 * afterward.
 *
 * `question_answers` already holds the confirmed row, so this is an `UPDATE`,
 * not an `INSERT` — the one case this table's rows are ever rewritten (see
 * `migrations/0022_relayed_answers.sql`). The guard on the event insert mirrors
 * `recordAnswer`'s trick exactly, just checking the opposite fact: it fires
 * only when, *before this call's own write*, the row was `relay_confirmed` —
 * i.e. this call is a genuine correction, not a duplicate submit of a
 * correction that already landed (which flips `source` to `'client'`, so a
 * repeat finds the guard false and changes nothing, same idempotence
 * `recordAnswer` gives an ordinary answer).
 *
 * The emitted event is a plain `question.answered`, carrying only the
 * customer's own words — "the correction supersedes rather than erases":
 * the earlier relay-confirm event is not deleted or rewritten, it simply
 * stops being the latest word on this question in the coordinator's own
 * append-only archive (`bridge_events`, and #2867 on the coordinator side).
 */
export async function correctRelayedAnswer(
  env: Env,
  submissionReference: string,
  questionRevision: number,
  answer: string,
): Promise<{ recorded: boolean }> {
  const answeredAt = new Date().toISOString()

  const [eventInsert] = await env.DB.batch([
    appendEventStatement(
      env,
      {
        type: "question.answered",
        submissionReference,
        occurredAt: answeredAt,
        payload: { answer },
      },
      {
        clause: `WHERE EXISTS (
          SELECT 1 FROM question_answers
           WHERE submission_id = ? AND question_revision = ? AND source = 'relay_confirmed'
        )`,
        bindings: [submissionReference, questionRevision],
      },
    ),
    env.DB.prepare(
      `UPDATE question_answers
          SET answer = ?, answered_at = ?, source = 'client', relayed_answer_revision = NULL
        WHERE submission_id = ? AND question_revision = ? AND source = 'relay_confirmed'`,
    ).bind(answer, answeredAt, submissionReference, questionRevision),
  ])

  return { recorded: (eventInsert?.meta.changes ?? 0) > 0 }
}
