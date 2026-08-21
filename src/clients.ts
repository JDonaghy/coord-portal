import { generateClientId } from "./ids"
import type { Env } from "./types"

/**
 * The `clients` table (issue #128) — "the row that represents 'this
 * customer,' not any one project or submission of theirs" (epic #122).
 *
 * Two callers, both on the operator's lead screen (`routes/leads.ts`):
 *
 *  - **promotion** (#129) — a lead whose address already names a client is
 *    promoted *into* that client, and one that does not mints a new client
 *    and its first project. That is what makes `/leads/:id`'s pre-promotion
 *    `client-match-card` possible at all: the only reason a second lead from
 *    the same address has projects to choose between is that the first one's
 *    promotion created a client row to hang them off.
 *  - **reassignment** (#130) — moving that submission between the projects
 *    of the client it already belongs to, or into a fresh one.
 *
 * ── THE ms-2 SCREEN THIS MUST NOT DISTURB ──────────────────────────────────
 * Attaching a project to the submission a promotion creates is visible on a
 * screen this milestone does not own: the customer's own `/submissions`.
 * `tests/acceptance/ms-2/33-lead-triage-promotion.spec.ts` reads a
 * just-promoted submission back there and expects a plain `submission-row` —
 * the shape a project-less submission has always rendered as — while
 * `routes/dashboard.ts` renders a project as a `project-row`.
 *
 * The resolution is in `groupByProject` (`routes/dashboard.ts`), not here: a
 * project standing alone with a single submission under it renders as that
 * submission's own row, because a group of one is not a grouping and #109's
 * project row exists to make *grouping* legible ("N requests"). So a promoted
 * lead's customer still sees exactly the row ms-2 pins, and only a project
 * that genuinely holds more than one request collapses into a project row.
 * See that function's comment for the full reasoning.
 */

interface ClientRow {
  id: string
  email: string
}

/**
 * The `clients` columns anything in this repo reads today. `phone`,
 * `cc_emails` and `address` (migration 0016) belong to #131's `/account`
 * screen and are deliberately not surfaced here.
 */
export interface Client {
  id: string
  /** Stored verbatim, as the address the lead was filed under. */
  email: string
}

/**
 * A read-only lookup, for rendering `GET /leads/:id` — never writes.
 * Case-insensitive, by the same inference `src/operators.ts`'s allowlist
 * comparison and ms-4 contract note 3 both take: no identity provider
 * treats an address's local part as case-sensitive in practice.
 */
export async function getClientByEmail(env: Env, email: string): Promise<Client | null> {
  const row = await env.DB.prepare(`SELECT id, email FROM clients WHERE lower(email) = lower(?)`)
    .bind(email)
    .first<ClientRow>()
  return row ? { id: row.id, email: row.email } : null
}

/** The same lookup when only the id is wanted. */
export async function getClientIdByEmail(env: Env, email: string): Promise<string | null> {
  return (await getClientByEmail(env, email))?.id ?? null
}

/**
 * The only place a `clients` row is ever minted: lead promotion (#129) and,
 * for a submission promoted before this shipped, the first reassignment of
 * it (#130). Both live in `routes/leads.ts`. Nothing a *customer* does
 * creates a client — `/intake` and #109's follow-ups are deliberately left
 * alone (#128: no backfill, no inference from a matching email).
 *
 * Idempotent against a double-submitted promotion or reassignment racing
 * itself: `clients.email` is `UNIQUE` (0016), so even if two requests both
 * miss the `SELECT` below, only one `INSERT` can win, and the final read
 * always resolves to whichever row exists.
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
