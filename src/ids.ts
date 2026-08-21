/**
 * Portal-minted identifiers.
 *
 * Neither the URL id nor the customer-facing reference is a GitHub issue
 * number, a branch name or anything else coord-side — see contract note 6
 * ("the opaque SUB-XXXXXX reference ... is a portal-minted id, not a GitHub
 * number"). Both are generated here, independently of each other, so a
 * customer who quotes a reference back to support never leaks the row id and
 * vice versa.
 */

/** `sub_` + 12 lowercase hex chars. Used only in URLs, never read aloud. */
export function generateSubmissionId(): string {
  return `sub_${randomHex(12)}`
}

/**
 * `SUB-XXXXXX` where `XXXXXX` is six upper-case hex characters — a subset of
 * `[A-Z0-9]`, the alphabet the contract and mock both use, and one Playwright
 * can assert against without pinning more than either source commits to.
 */
export function generateSubmissionReference(): string {
  return `SUB-${randomHex(6).toUpperCase()}`
}

/** `lead_` + 12 lowercase hex chars. Portal-internal; no route exposes it yet (#33 owns that). */
export function generateLeadId(): string {
  return `lead_${randomHex(12)}`
}

/**
 * `LEAD-XXXXXX` where `XXXXXX` is six upper-case hex characters — same shape
 * as `generateSubmissionReference`, and independently generated from the
 * lead's own id for the same reason: a stranger who quotes this back in an
 * email never leaks the row id, and it is never mistakable for a `SUB-XXXXXX`
 * submission reference (issue #31's rule that a public screen must carry no
 * submission reference).
 */
export function generateLeadReference(): string {
  return `LEAD-${randomHex(6).toUpperCase()}`
}

/**
 * `proj_` + 12 lowercase hex chars — same shape as `generateSubmissionId`,
 * for the same reason: portal-internal, URL-facing, never accepted from a
 * caller. A project has no customer-facing reference of its own (issue
 * #109) — the customer still quotes back a submission's `SUB-XXXXXX`; the
 * project id only ever appears in a `/projects/:id` URL they got here by
 * clicking.
 */
export function generateProjectId(): string {
  return `proj_${randomHex(12)}`
}

/**
 * `client_` + 12 lowercase hex chars — same shape as `generateProjectId`, for
 * the same reason: portal-internal, never accepted from a caller. A client
 * has no customer-facing reference of its own (issue #128) — nothing renders
 * this id back to the person it identifies, only `email` does that.
 */
export function generateClientId(): string {
  return `client_${randomHex(12)}`
}

/**
 * `evt_` + 24 lowercase hex chars — the opaque id on a sync-bridge event.
 *
 * Deliberately NOT derived from the event's revision. The revision is the
 * stream's ordering and the daemon's cursor; the id is a stable handle for one
 * event. Tying them together would mean a change to how the stream is ordered
 * silently renames every event the daemon has already recorded.
 */
export function generateEventId(): string {
  return `evt_${randomHex(24)}`
}

/**
 * `ntf_` + 24 lowercase hex chars — one row in the outbox (issue #14). Same
 * shape as `generateEventId` and for the same reason: an opaque handle for one
 * send, independent of the revision that triggered it.
 */
export function generateOutboxId(): string {
  return `ntf_${randomHex(24)}`
}

/**
 * `msg_` + 24 lowercase hex chars — one row in the message thread (issue
 * #110). Same shape as `generateEventId` / `generateOutboxId` and for the
 * same reason: an opaque, portal-internal handle for one row, never a
 * customer-facing reference — a message is read back in place on
 * `/submissions/:id`, never quoted by id the way a `SUB-XXXXXX` reference is.
 */
export function generateMessageId(): string {
  return `msg_${randomHex(24)}`
}

function randomHex(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil(length / 2)))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length)
}
