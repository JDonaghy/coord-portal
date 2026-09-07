import type { Env } from "./types"

/**
 * Coord's own outbound-message queue, mirrored here — issue #318.
 *
 * ── WHAT THIS IS AND IS NOT ─────────────────────────────────────────────────
 * Coord stages every coord-owned push (`design_round`, `question`,
 * `relayed_answer`, `status`, `preview`) in its own `portal_outbox` before
 * sending, released with `coord portal draft approve`. This module is the
 * portal's read-and-decide half of the seam that makes that queue visible and
 * actionable here instead of only in a terminal — see
 * `migrations/0027_coord_outbound_drafts.sql` for why it is a table of its
 * own and not folded into `coord_facts`, and `src/routes/bridge.ts` /
 * `src/routes/requests.ts` for the two sides that call this module.
 *
 * `applyOutboundDraftsPush` handles coord's own half — asserting what is
 * currently queued, on every poll tick. `approveOutboundDraftStatement` /
 * `rejectOutboundDraftStatement` handle the operator's: a decision, guarded to
 * a row that is still `pending`, exactly the same one-way guard
 * `approveReplyDraft` / `discardReplyDraft` (`src/notifications.ts`) already
 * apply to a portal-drafted reply.
 *
 * Both are statement-returning, not executing — mirroring
 * `appendEventStatement` itself (`src/bridge/events.ts`) — because the verdict
 * that reaches coord over `bridge_events` (`outbound_draft.approved` /
 * `outbound_draft.rejected`) and the decision recorded here must land in the
 * same `env.DB.batch()` or not at all. A draft decided but never announced is
 * a message coord waits on forever; an event announcing a decision that never
 * actually committed is a lie on the pull stream. `src/routes/requests.ts`'s
 * `postRequestDraftApprove` / `postRequestDraftReject` batch the two
 * together, the same all-or-nothing pairing `confirmRelayedAnswer`
 * (`src/questions.ts`) already establishes for exactly this situation —
 * appending the event itself is still that route's decision to make, this
 * module's job stops at handing back a guarded statement.
 */

export const COORD_OUTBOUND_DRAFT_KINDS = [
  "design_round",
  "question",
  "relayed_answer",
  "status",
  "preview",
] as const

export type CoordOutboundDraftKind = (typeof COORD_OUTBOUND_DRAFT_KINDS)[number]

export function isCoordOutboundDraftKind(value: unknown): value is CoordOutboundDraftKind {
  return (
    typeof value === "string" &&
    (COORD_OUTBOUND_DRAFT_KINDS as readonly string[]).includes(value)
  )
}

/** One coord-owned draft, still awaiting an operator's decision. */
export interface CoordOutboundDraft {
  id: string
  submissionReference: string
  kind: CoordOutboundDraftKind
  /** The editable text fields, exactly as coord queued them. */
  fields: Record<string, string>
  /** Coord's own clock — when it queued this, not when this mirror last saw it. */
  queuedAt: string
}

interface DraftRow {
  id: string
  submission_id: string
  kind: string
  fields: string
  queued_at: string
}

/** Every pending draft queued against this submission, oldest first. */
export async function listPendingOutboundDrafts(
  env: Env,
  submissionReference: string,
): Promise<CoordOutboundDraft[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, submission_id, kind, fields, queued_at
       FROM coord_outbound_drafts
      WHERE submission_id = ? AND state = 'pending'
      ORDER BY queued_at ASC`,
  )
    .bind(submissionReference)
    .all<DraftRow>()

  const drafts: CoordOutboundDraft[] = []
  for (const row of results ?? []) {
    const draft = fromRow(row)
    // A row whose `kind` predates a vocabulary this deploy no longer
    // recognises is dropped rather than rendered blank — "absent beats
    // broken" (see `src/routes/replies.ts`'s own reply-drafting conventions),
    // and coord will simply re-assert it verbatim on its next poll.
    if (draft !== null) drafts.push(draft)
  }
  return drafts
}

/** One pending draft by id, or `null` if it does not exist or is no longer `pending`. */
export async function getPendingOutboundDraft(env: Env, id: string): Promise<CoordOutboundDraft | null> {
  const row = await env.DB.prepare(
    `SELECT id, submission_id, kind, fields, queued_at
       FROM coord_outbound_drafts
      WHERE id = ? AND state = 'pending'`,
  )
    .bind(id)
    .first<DraftRow>()
  return row ? fromRow(row) : null
}

function fromRow(row: DraftRow): CoordOutboundDraft | null {
  if (!isCoordOutboundDraftKind(row.kind)) return null
  return {
    id: row.id,
    submissionReference: row.submission_id,
    kind: row.kind,
    fields: parseFields(row.fields),
    queuedAt: row.queued_at,
  }
}

/**
 * A `fields` (or `edited_fields`) JSON blob, defensively parsed to a flat
 * string map — every field this screen renders is editable free text (an
 * outcome definition, a question, an answer, a status slug, a URL), never a
 * nested structure. A value that is not a string, or a blob that is not a
 * plain object at all, is dropped rather than rendered or sent malformed.
 */
function parseFields(raw: string): Record<string, string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {}

  const fields: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string") fields[key] = value
  }
  return fields
}

/**
 * **Approve & send** — the statement that records the operator's edited text
 * and flips the gate, guarded to a row that is still `pending` so a
 * double-click or a second tab that lost the race converges on one decision
 * rather than two. Returned, not run: the caller (`postRequestDraftApprove`,
 * `src/routes/requests.ts`) batches this alongside the guarded
 * `outbound_draft.approved` event append, so the decision and the only way
 * coord ever learns of it either both land or neither does. See this module's
 * own doc comment above for why that pairing cannot be two separate
 * round trips.
 */
export function approveOutboundDraftStatement(
  env: Env,
  id: string,
  editedFields: Record<string, string>,
  decidedBy: string,
): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE coord_outbound_drafts
        SET state = 'approved', decided_at = ?, decided_by = ?, edited_fields = ?
      WHERE id = ? AND state = 'pending'`,
  ).bind(new Date().toISOString(), decidedBy, JSON.stringify(editedFields), id)
}

/**
 * **Reject** — terminal, never reaches coord as anything but "discard this
 * one". Same statement-returning, batch-with-the-event shape as
 * `approveOutboundDraftStatement` above, for the same reason.
 */
export function rejectOutboundDraftStatement(env: Env, id: string, decidedBy: string): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE coord_outbound_drafts
        SET state = 'rejected', decided_at = ?, decided_by = ?
      WHERE id = ? AND state = 'pending'`,
  ).bind(new Date().toISOString(), decidedBy, id)
}

// ── COORD'S OWN HALF: `POST /api/bridge/outbound-drafts` ────────────────────

/**
 * The most drafts one push may carry — mirrors `MAX_PUSH_UPDATES`
 * (`src/bridge/updates.ts`) for the same reason: a Worker-imposed ceiling
 * made visible, not a contract term.
 */
export const MAX_OUTBOUND_DRAFTS_PUSH = 50

export type OutboundDraftPushOutcome = "applied" | "rejected"

export interface OutboundDraftPushResult {
  id: string
  outcome: OutboundDraftPushOutcome
  reason?: string
}

/**
 * Applies a batch of coord's queued drafts, one at a time. Every well-formed
 * item is `applied`, whether or not it actually changed anything — a
 * re-assertion of a draft an operator already decided is a no-op, not a
 * failure (see the upsert's own `WHERE state = 'pending'` guard below), and
 * coord needs no way to tell "no-op because already decided" from "no-op
 * because nothing changed" apart: both mean "stop asserting this one".
 */
export async function applyOutboundDraftsPush(
  env: Env,
  rawDrafts: unknown[],
): Promise<OutboundDraftPushResult[]> {
  const results: OutboundDraftPushResult[] = []
  for (const raw of rawDrafts) {
    results.push(await applyOneDraftPush(env, raw))
  }
  return results
}

type ParsedIncomingDraft =
  | {
      draft: {
        id: string
        submissionReference: string
        kind: CoordOutboundDraftKind
        fields: Record<string, unknown>
        queuedAt: string
      }
    }
  | { error: string; id: string }

async function applyOneDraftPush(env: Env, raw: unknown): Promise<OutboundDraftPushResult> {
  const parsed = parseIncomingDraft(raw)
  if ("error" in parsed) return { id: parsed.id, outcome: "rejected", reason: parsed.error }

  const { draft } = parsed
  await env.DB.prepare(
    `INSERT INTO coord_outbound_drafts (id, submission_id, kind, fields, queued_at, state)
     VALUES (?, ?, ?, ?, ?, 'pending')
     ON CONFLICT(id) DO UPDATE SET
       submission_id = excluded.submission_id,
       kind          = excluded.kind,
       fields        = excluded.fields,
       queued_at     = excluded.queued_at
     WHERE coord_outbound_drafts.state = 'pending'`,
  )
    .bind(draft.id, draft.submissionReference, draft.kind, JSON.stringify(draft.fields), draft.queuedAt)
    .run()

  return { id: draft.id, outcome: "applied" }
}

function parseIncomingDraft(raw: unknown): ParsedIncomingDraft {
  if (!isPlainObject(raw)) return { error: "malformed_draft", id: "" }

  const idValue = raw["id"]
  const id = typeof idValue === "string" ? idValue.trim() : ""
  if (!id) return { error: "malformed_draft", id: "" }

  const submissionIdValue = raw["submission_id"]
  const submissionReference = typeof submissionIdValue === "string" ? submissionIdValue.trim() : ""
  if (!submissionReference) return { error: "malformed_draft", id }

  const kind = raw["kind"]
  if (!isCoordOutboundDraftKind(kind)) return { error: "unknown_kind", id }

  const fields = raw["fields"]
  if (!isPlainObject(fields)) return { error: "malformed_draft", id }

  const queuedAtValue = raw["queued_at"]
  const queuedAt = typeof queuedAtValue === "string" ? queuedAtValue.trim() : ""
  if (!queuedAt) return { error: "malformed_draft", id }

  return { draft: { id, submissionReference, kind, fields, queuedAt } }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
