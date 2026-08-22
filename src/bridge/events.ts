import { generateEventId } from "../ids"
import type { Env } from "../types"

/**
 * The outbound event stream the daemon pulls.
 *
 * ── CUSTOMER-AUTHORED FACTS ONLY ───────────────────────────────────────────
 * The four types below are all facts a *customer* created. The portal never
 * emits an event about a coord-owned fact, and the reason is not tidiness: the
 * daemon pushes `status`, and if that push produced an event the daemon would
 * pull back its own write, act on it, push again, and the two sides would feed
 * each other forever. A one-way stream of "things that happened on this side"
 * is what makes the loop terminate.
 *
 * `submission.created` (#9), `question.answered` (#11, `src/questions.ts`)
 * and the sign-off pair (#13, `src/rounds.ts`) are emitted today.
 * `preview.approved` / `preview.changes_requested` (#107, `src/previewReviews.ts`)
 * are the customer's verdict on a PR's pre-merge preview build — the same
 * shape as the sign-off pair, one event per decision, for a different
 * decision. The vocabulary is closed here anyway because it is the half of
 * the contract #15 owns, and #1982 is building against it today.
 *
 * One deliberate exception: `signoff.approved` is also emitted by the
 * operator's "start work" override (#132, `src/startWork.ts`) when an
 * operator skips the sign-off loop for pre-agreed work. That payload is
 * still customer-facing-fact-shaped (it announces the same "moved toward
 * planned" outcome a real sign-off does) but is not, strictly, a fact a
 * *customer* authored — see `src/startWork.ts`'s doc comment for the full
 * reasoning and the `source: "operator_start_work"` marker that keeps the two
 * distinguishable in the payload without a new event kind.
 *
 * A second, narrower exception is `submission.project_assigned` (#146). Every
 * other event above is appended in the same `DB.batch()` as the fact it
 * announces — "an event committed without its fact ... is how the daemon
 * ends up building something nobody asked for" (see `appendEventStatement`'s
 * own comment). `submission.created` now carries `project_id` too, but two
 * things can attach — or move — a submission's project *after* that event has
 * already shipped: a follow-up (#109, `src/projects.ts`'s
 * `projectAssignmentForFollowUp`) resolving which project it lands in only
 * once its own transaction commits, and an operator's reassignment (#130,
 * `setSubmissionProject` in `src/submissions.ts`). `submission.project_assigned`
 * is how either reaches the daemon afterward, so a submission already on the
 * wire converges on the truth instead of staying pinned to whatever
 * `project_id` (often absent) it carried at creation.
 */
export const BRIDGE_EVENT_TYPES = [
  "submission.created",
  "submission.project_assigned",
  "signoff.approved",
  "signoff.changes_requested",
  "question.answered",
  "preview.approved",
  "preview.changes_requested",
] as const

export type BridgeEventType = (typeof BRIDGE_EVENT_TYPES)[number]

/** One event, in the shape the wire contract pins. Snake_case is deliberate. */
export interface BridgeEvent {
  id: string
  revision: number
  type: BridgeEventType
  submission_id: string
  occurred_at: string
  payload: Record<string, unknown>
}

export interface NewBridgeEvent {
  type: BridgeEventType
  /** The customer-visible `SUB-XXXXXX` reference — the wire identity. */
  submissionReference: string
  occurredAt: string
  payload: Record<string, unknown>
}

interface BridgeEventRow {
  revision: number
  id: string
  type: string
  submission_id: string
  occurred_at: string
  payload: string
}

export const DEFAULT_PULL_LIMIT = 50
export const MIN_PULL_LIMIT = 1
export const MAX_PULL_LIMIT = 200

/**
 * The statement that appends one event.
 *
 * Returned rather than executed so the caller can put it in the same
 * `DB.batch()` as the write it describes. An event committed without its fact —
 * or a fact committed without its event — is how the daemon ends up building
 * something nobody asked for, or never hearing about something somebody did.
 *
 * `guard` makes the append conditional on some other row's state, evaluated
 * inside the same transaction — for a write that may legitimately turn out to
 * be a no-op (promoting an already-promoted lead, #33). The fact and its event
 * must share the guard, or the pair stops being all-or-nothing.
 */
export function appendEventStatement(
  env: Env,
  event: NewBridgeEvent,
  guard?: { clause: string; bindings: unknown[] },
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO bridge_events (id, type, submission_id, occurred_at, payload)
     SELECT ?, ?, ?, ?, ?
     ${guard ? guard.clause : ""}`,
  ).bind(
    generateEventId(),
    event.type,
    event.submissionReference,
    event.occurredAt,
    JSON.stringify(event.payload),
    ...(guard ? guard.bindings : []),
  )
}

/**
 * One page of the stream, strictly after `afterRevision`.
 *
 * Reads `limit + 1` rows and keeps `limit`, which is how `has_more` is answered
 * without a second `COUNT(*)` that could disagree with the page it describes.
 */
export async function readEventsAfter(
  env: Env,
  afterRevision: number,
  limit: number,
): Promise<{ events: BridgeEvent[]; hasMore: boolean }> {
  const { results } = await env.DB.prepare(
    `SELECT revision, id, type, submission_id, occurred_at, payload
       FROM bridge_events
      WHERE revision > ?
      ORDER BY revision ASC
      LIMIT ?`,
  )
    .bind(afterRevision, limit + 1)
    .all<BridgeEventRow>()

  const rows = results ?? []
  const hasMore = rows.length > limit
  return { events: rows.slice(0, limit).map(fromRow), hasMore }
}

/** Clamps `limit` into the contract's 1–200, defaulting anything unreadable. */
export function parsePullLimit(raw: string | null): number {
  if (raw === null || raw.trim() === "") return DEFAULT_PULL_LIMIT
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return DEFAULT_PULL_LIMIT
  const floored = Math.floor(parsed)
  return Math.min(MAX_PULL_LIMIT, Math.max(MIN_PULL_LIMIT, floored))
}

function fromRow(row: BridgeEventRow): BridgeEvent {
  return {
    id: row.id,
    revision: row.revision,
    type: row.type as BridgeEventType,
    submission_id: row.submission_id,
    occurred_at: row.occurred_at,
    payload: parsePayload(row.payload),
  }
}

/**
 * A payload is stored as JSON text and returned as it was written. If it is
 * somehow unreadable the event still ships with an empty payload: losing the
 * detail of one event is recoverable, dropping the event silently is not.
 */
function parsePayload(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // fall through
  }
  return {}
}
