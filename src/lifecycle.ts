import type { Env } from "./types"

/**
 * The dev-lifecycle timeline — issue #111, the passive half of #107.
 *
 * A submission's coarse `status` (`in-design`, `in-progress`, ...) says
 * nothing about what is actually happening in the underlying repo work: an
 * issue opening, a PR going up, tests going green, a preview build becoming
 * available. This module is the coord-owned, append-only record of that
 * activity, read back as `LifecycleEvent`s and rendered as timeline entries
 * on the submission detail screen (`src/routes/submission.ts`).
 *
 * ── THE WALL STAYS THE WALL ────────────────────────────────────────────────
 * Issue #16 pins that a customer "never sees a branch, an issue number, or a
 * live agent" — enforced elsewhere by `scrubEngineerIdentifiers` scrubbing
 * coord's free text. There is no free text here to scrub: `kind` is a closed,
 * portal-owned vocabulary and the rendered copy is portal-owned too
 * (`LIFECYCLE_EVENT_TEXT` in `src/routes/submission.ts`), the same shape
 * `VERDICT_TEXT` already uses for a round's verdict. A push naming a kind
 * outside the vocabulary describes nothing this portal can safely show and is
 * read as "not a lifecycle event" rather than rejected — see
 * `readLifecyclePatch` — matching `roundStatementsForPush`'s "acknowledge and
 * do nothing with what this side cannot render" reasoning over failing the
 * whole (possibly multi-field) update for one passenger it did not expect.
 *
 * `url` is the one exception, and a narrow one: #107 gives the coordinator an
 * actual customer-facing link — the Cloudflare Pages preview build — so it is
 * accepted, but only alongside `kind: "preview-ready"` and only after
 * `sanitizePreviewUrl` confirms it is not itself a line back into the
 * engineer's world (a `github.com` link, or anything that is not a plain
 * `https:` URL).
 *
 * ── NOTIFICATIONS ──────────────────────────────────────────────────────────
 * None of this ever reaches `recordNotificationForStatus` (`src/bridge/
 * updates.ts`) — only a push that actually names `status` does. That is
 * deliberate, not an oversight: issue #111 is explicit that "not every CI run
 * needs to email the customer". This is timeline-only, noise-free browsing;
 * the three actionable-or-terminal statuses issue #14 already emails on stay
 * the only thing that lands in an inbox.
 */

/**
 * Closed and portal-owned. Adding a kind here is a rendering decision this
 * side makes deliberately, not a mirror of whatever string the daemon
 * happens to send — see the module doc for why that matters.
 */
export const LIFECYCLE_EVENT_KINDS = [
  "work-started",
  "review-opened",
  "checks-passing",
  "checks-attention",
  "preview-ready",
  "merged",
  "deployed",
] as const

export type LifecycleEventKind = (typeof LIFECYCLE_EVENT_KINDS)[number]

const KINDS = new Set<string>(LIFECYCLE_EVENT_KINDS)

function isLifecycleEventKind(value: unknown): value is LifecycleEventKind {
  return typeof value === "string" && KINDS.has(value)
}

export interface LifecycleEvent {
  kind: LifecycleEventKind
  occurredAt: string
  /** Only ever set for `preview-ready` (#107). `null` for every other kind. */
  url: string | null
}

interface LifecycleEventRow {
  kind: string
  occurred_at: string
  url: string | null
}

/** Every lifecycle event for a submission, oldest first — a story, not an inbox. */
export async function listLifecycleEvents(
  env: Env,
  submissionReference: string,
): Promise<LifecycleEvent[]> {
  const { results } = await env.DB.prepare(
    `SELECT kind, occurred_at, url
       FROM lifecycle_events
      WHERE submission_id = ?
      ORDER BY occurred_at ASC, revision ASC`,
  )
    .bind(submissionReference)
    .all<LifecycleEventRow>()

  // A row whose `kind` predates a vocabulary change (or was written by a
  // build that briefly diverged) is dropped rather than rendered blank —
  // this table has no copy for a kind it does not recognise, so showing
  // nothing is the honest option, matching `parsePayload`'s "losing the
  // detail of one event is recoverable" reasoning in `src/bridge/events.ts`.
  return (results ?? [])
    .filter((row): row is LifecycleEventRow & { kind: LifecycleEventKind } =>
      isLifecycleEventKind(row.kind),
    )
    .map((row) => ({ kind: row.kind, occurredAt: row.occurred_at, url: row.url }))
}

/** What one bridge push says about a lifecycle event. `null` means "nothing to record". */
export interface LifecyclePatch {
  kind: LifecycleEventKind
  /** Coord's own timestamp for the event, if it sent a readable one. */
  occurredAt: string | null
  url: string | null
}

/**
 * Reads the `lifecycle_event` field of a push, liberally: a bare kind string,
 * or an object carrying `kind` plus (for `preview-ready` only) a URL under
 * any of the usual spellings and a timestamp under any of the usual
 * spellings. Returns `null` when the push says nothing about a lifecycle
 * event, or names a kind outside the closed vocabulary — see the module doc
 * for why an unrecognised kind is silently dropped rather than rejected.
 */
export function readLifecyclePatch(fields: Record<string, unknown>): LifecyclePatch | null {
  if (!("lifecycle_event" in fields)) return null

  const raw = fields["lifecycle_event"]
  const object = asObject(raw)
  const kindValue = object ? firstDefined(object, ["kind", "type", "event"]) : raw
  if (!isLifecycleEventKind(kindValue)) return null

  const occurredAt = object
    ? asTimestamp(firstDefined(object, ["occurred_at", "occurredAt", "at", "timestamp"]))
    : null

  const url =
    kindValue === "preview-ready"
      ? sanitizePreviewUrl(
          object ? firstDefined(object, ["url", "href", "preview_url", "previewUrl"]) : null,
        )
      : null

  return { kind: kindValue, occurredAt, url }
}

/**
 * The statement that appends one lifecycle event — returned, not executed,
 * so the caller (`src/bridge/updates.ts`) commits it in the same
 * `DB.batch()` as the rest of the push it describes, exactly the reasoning
 * `roundStatementsForPush` gives for the same shape.
 *
 * `ON CONFLICT DO NOTHING` on `(submission_id, revision)` is the whole of
 * this table's idempotency: a retried push names the same revision and the
 * second attempt is a silent no-op, never a second entry.
 */
export function lifecycleStatementsForPush(
  env: Env,
  submissionReference: string,
  fields: Record<string, unknown>,
  revision: number,
  now: string,
): D1PreparedStatement[] {
  const patch = readLifecyclePatch(fields)
  if (patch === null) return []

  return [
    env.DB.prepare(
      `INSERT INTO lifecycle_events (submission_id, revision, kind, occurred_at, url, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(submission_id, revision) DO NOTHING`,
    ).bind(submissionReference, revision, patch.kind, patch.occurredAt ?? now, patch.url, now),
  ]
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function firstDefined(source: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = source[key]
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

function asTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed || Number.isNaN(new Date(trimmed).getTime())) return null
  return trimmed
}

/**
 * The one URL this timeline ever shows: #107's Cloudflare Pages preview
 * build. Accepted only as a well-formed `https:` URL whose host is not
 * `github.com` (or a subdomain of it) — the narrow exception to issue #16's
 * wall stays narrow even when the daemon's own idea of a "preview" drifts.
 */
function sanitizePreviewUrl(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed) return null

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (parsed.protocol !== "https:") return null
  if (/(^|\.)github\.com$/i.test(parsed.hostname)) return null
  return parsed.toString()
}
