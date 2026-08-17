/**
 * The sole-writer table, in code.
 *
 * Every fact belongs to exactly one side. Nothing is co-written, which is why
 * there is no merge rule anywhere in this bridge and no last-writer-wins tie
 * break to get subtly wrong: a field either arrives from the side that owns it
 * or it does not arrive at all.
 *
 * Enforcement of this table is issue #8's remit; the bridge is simply the place
 * a violation actually shows up, because it is the only place the other side
 * can write at all.
 *
 * Keep this in step with the table in `docs/CUSTOMER_PORTAL.md` (§ The sync
 * bridge) and issue #15. Neither side may change it unilaterally.
 */

/** Customer-authored. Coord may never write these. */
export const PORTAL_OWNED_FIELDS = [
  "outcome",
  "audience",
  "done_definition",
  "constraints",
  "project_scope",
  "signoff_verdict",
  "signoff_comment",
  "answer",
  // Issue #107: the customer's verdict on a preview build — the portal-owned
  // mirror of `signoff_verdict` / `signoff_comment` above, listed for the
  // same reason those are: nothing on the wire is ever actually named this
  // (the verdict is written by a form POST, not a bridge push), but naming it
  // here means a coord daemon that tries anyway gets a clear `not_owned:...`
  // reason instead of the less specific `unknown_field:...` every other
  // unrecognised field falls back to.
  "preview_verdict",
  "preview_comment",
] as const

/** Engineer-authored. The portal mirrors these read-only. */
export const COORD_OWNED_FIELDS = [
  "status",
  "decomposition",
  "question",
  "design_round",
  "artifacts",
  // Issue #10: the business-time On-hold threshold is computed daemon-side;
  // this is the instant it decided the clock crossed it. Still a valid push
  // (`on-hold` stays a real stored status, issue #74) — the portal just has
  // no customer-visible surface left that reads it, since #74 collapsed the
  // On-hold screen into the ordinary in-progress rollup template.
  "onhold_since",
  // Issue #111: one entry in the dev-lifecycle timeline (a PR opening, tests
  // going green, a preview build becoming available). Handled like
  // `design_round` — read into its own append-only archive
  // (`src/lifecycle.ts`) rather than the generic `coord_facts` last-value
  // mirror, because a customer watching this timeline should still see "PR
  // opened" after "Merged" lands.
  "lifecycle_event",
  // Issue #107: the PR's Cloudflare Pages preview URL, pushed alongside
  // `status: 'quality-check'` — see `migrations/0015_preview_reviews.sql`.
  // Handled like `status` itself: written directly to
  // `submissions.preview_url` by `src/bridge/updates.ts`, not the generic
  // `coord_facts` mirror — see that migration's module comment for why a
  // real column, not a JSON-encoded fact row.
  "preview_url",
] as const

export type PortalOwnedField = (typeof PORTAL_OWNED_FIELDS)[number]
export type CoordOwnedField = (typeof COORD_OWNED_FIELDS)[number]

export type Ownership = "portal" | "coord" | "unknown"

const PORTAL = new Set<string>(PORTAL_OWNED_FIELDS)
const COORD = new Set<string>(COORD_OWNED_FIELDS)

export function ownerOf(field: string): Ownership {
  if (PORTAL.has(field)) return "portal"
  if (COORD.has(field)) return "coord"
  return "unknown"
}

export function isCoordOwnedField(field: string): field is CoordOwnedField {
  return COORD.has(field)
}
