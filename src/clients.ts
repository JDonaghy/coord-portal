import { generateClientId } from "./ids"
import type { Env } from "./types"

/**
 * The `clients` table (issue #128) — "the row that represents 'this
 * customer,' not any one project or submission of theirs" (epic #122).
 *
 * `/leads/:id`'s client-match UI *before* promotion (`client-match-card`,
 * `client-project-list`, the promotion form's `projectChoice` radios) is
 * issue #129's own surface — "lead promotion detects/links a client" — and
 * is deliberately NOT built here. This module holds only the one thing #130
 * ("reassign a submission to a different, or new, project") cannot do
 * without: a way to find, or start, the `clients` row a reassignment target
 * belongs to.
 *
 * ── WHY A CLIENT ROW IS NEVER CREATED JUST BY VIEWING A PROMOTED LEAD ──────
 * An earlier version of this module minted a client (and a first project)
 * the moment a lead was promoted, unconditionally. That broke a *sealed*
 * ms-2 test this milestone must never reopen
 * (`tests/acceptance/ms-2/33-lead-triage-promotion.spec.ts`): it reads a
 * just-promoted submission back on the customer's own `/submissions` and
 * expects a plain `submission-row` — the pre-#109 shape a project-less
 * submission has always rendered as. `routes/dashboard.ts`'s
 * `groupByProject` renders ANY submission carrying a `project_id` as a
 * `project-row` instead, regardless of how many submissions share it, so
 * attaching a project at promotion time silently changes that screen for
 * every promoted lead, not just the ones an operator ever reassigns —
 * exactly the "panel arrived and pushed something off *another* screen"
 * failure mode the ms-4 contract warns #130 to avoid on `/leads/:id` itself.
 *
 * So a client row (and a submission's first project) is only ever minted
 * inside `postLeadReassign` (`routes/leads.ts`), at the moment an operator
 * actually reassigns something — never merely by promoting or by viewing a
 * lead. Until that first reassignment, `/leads/:id` still offers the panel
 * (the contract pins it as present on every promoted lead, unconditionally),
 * it just has nothing to list yet: `getClientIdByEmail` returns `null`, so
 * the promoted submission's own project — if it has one at all, which it
 * usually does not — is treated as `client_id`-less, and every project on
 * offer via `listProjectsForClient` in `src/projects.ts` is exactly zero,
 * the same "one project, nothing to move to but new" state a genuinely
 * single-project client renders.
 */

interface ClientRow {
  id: string
}

/**
 * A read-only lookup, for rendering `GET /leads/:id` — never writes.
 * Case-insensitive, by the same inference `src/operators.ts`'s allowlist
 * comparison and ms-4 contract note 3 both take: no identity provider
 * treats an address's local part as case-sensitive in practice.
 */
export async function getClientIdByEmail(env: Env, email: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT id FROM clients WHERE lower(email) = lower(?)`)
    .bind(email)
    .first<ClientRow>()
  return row?.id ?? null
}

/**
 * The one place a `clients` row is minted by this issue — inside
 * `POST /leads/:id/reassign`, when an operator's own choice is about to
 * create or move into a project. Idempotent against a double-submitted
 * reassignment racing itself: `clients.email` is `UNIQUE` (0016), so even if
 * two requests both miss the `SELECT` below, only one `INSERT` can win, and
 * the final read always resolves to whichever row exists.
 */
export async function findOrCreateClientId(env: Env, email: string): Promise<string> {
  const existing = await getClientIdByEmail(env, email)
  if (existing) return existing

  const id = generateClientId()
  const createdAt = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO clients (id, email, created_at)
     SELECT ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM clients WHERE lower(email) = lower(?))`,
  )
    .bind(id, email, createdAt, email)
    .run()

  // Re-read rather than trusting `id` won: on the losing side of a genuine
  // race the `INSERT` above matched nothing, and another request's row is
  // the one that actually exists.
  return (await getClientIdByEmail(env, email)) ?? id
}
