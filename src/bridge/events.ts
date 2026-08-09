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
 * `submission.created` (#9) and `question.answered` (#11, `src/questions.ts`)
 * are emitted today; `signoff.approved` / `signoff.changes_requested` are
 * #13's screen and do not exist yet. The vocabulary is closed here anyway
 * because it is the half of the contract #15 owns, and #1982 is building
 * against it today.
 */
export const BRIDGE_EVENT_TYPES = [
  "submission.created",
  "signoff.approved",
  "signoff.changes_requested",
  "question.answered",
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
 */
export function appendEventStatement(env: Env, event: NewBridgeEvent): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO bridge_events (id, type, submission_id, occurred_at, payload)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(
    generateEventId(),
    event.type,
    event.submissionReference,
    event.occurredAt,
    JSON.stringify(event.payload),
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
