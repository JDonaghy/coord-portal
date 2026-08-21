import { generateClientId } from "./ids"
import type { Env } from "./types"

/**
 * The `clients` table (issue #128) — "the row that represents 'this
 * customer,' not any one project or submission of theirs" (epic #122). This
 * module is the read/write surface issue #128's schema comment explicitly
 * deferred: "Lead promotion linking, project reassignment and the client
 * profile page are the other issues under epic #122 that build on this."
 *
 * Two callers, deliberately kept as separate entry points:
 *
 *  - `routes/leads.ts` (#130, "reassign a submission to a different, or new,
 *    project") needs only a way to find, or start, the `clients` row a
 *    reassignment target belongs to — `getClientIdByEmail` /
 *    `findOrCreateClientId`.
 *  - `routes/account.ts` (#131, the client's own self-service profile) is the
 *    first caller to actually read or write the profile columns —
 *    `getClientByEmail` / `saveClientProfile`.
 *
 * `phone`, `ccEmails` and `address` are the only writable columns — `email`
 * is the row's identity (`clients.email UNIQUE`) and is never written by this
 * module; see `src/routes/account.ts` for why it is never accepted from a
 * request either.
 *
 * `/leads/:id`'s client-match UI *before* promotion (`client-match-card`,
 * `client-project-list`, the promotion form's `projectChoice` radios) is
 * issue #129's own surface — "lead promotion detects/links a client" — and
 * is deliberately NOT built here.
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
 *
 * A customer saving their profile (`saveClientProfile`) and an operator
 * reassigning their submission (`findOrCreateClientId`) can both be the first
 * to mint that row. Both are idempotent against `clients.email UNIQUE` and
 * neither rewrites an existing row's `id` or `created_at`, so whichever
 * arrives first wins and the other resolves onto it.
 */
export interface Client {
  id: string
  email: string
  phone: string | null
  ccEmails: string | null
  address: string | null
  createdAt: string
}

interface ClientRow {
  id: string
  email: string
  phone: string | null
  cc_emails: string | null
  address: string | null
  created_at: string
}

function fromRow(row: ClientRow): Client {
  return {
    id: row.id,
    email: row.email,
    phone: row.phone,
    ccEmails: row.cc_emails,
    address: row.address,
    createdAt: row.created_at,
  }
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
    .first<Pick<ClientRow, "id">>()
  return row?.id ?? null
}

/**
 * The one place a `clients` row is minted by issue #130 — inside
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

/**
 * Looks up a client by their exact email — the same string
 * `resolveSiteIdentity` hands back, never re-cased here. Matching semantics
 * for a *different* caller's lookup (lead promotion, #129; reassignment,
 * #130 — see `getClientIdByEmail` above) are that caller's own call to make;
 * this one only ever looks up the caller's own address, so there is no
 * ambiguity to resolve.
 */
export async function getClientByEmail(env: Env, email: string): Promise<Client | null> {
  const row = await env.DB.prepare(`SELECT * FROM clients WHERE email = ?`).bind(email).first<ClientRow>()
  return row ? fromRow(row) : null
}

export interface ClientProfileInput {
  phone: string | null
  ccEmails: string | null
  address: string | null
}

/**
 * Creates or updates the one `clients` row for `email` — the gap #131's
 * Gate-A contract resolves ("a customer who signed up before this milestone
 * ... has no `clients` row at all ... `POST /account` creates one on first
 * save rather than requiring it to already exist").
 *
 * One `INSERT ... ON CONFLICT(email) DO UPDATE`, not a read-then-write: two
 * concurrent first saves for the same caller (a double-click, a retried
 * request) must converge on one row, the same idempotency reasoning
 * `src/leads.ts`'s `promoteLead` gives for its own guarded batch. `email` is
 * the table's own `UNIQUE` column (migrations/0016_clients.sql), so the
 * conflict target is exactly the identity this function is keyed on. `id` and
 * `created_at` are deliberately absent from the `SET` clause: on a conflict
 * the existing row's own values win, so a second save never mints a new id
 * for the same customer or rewrites when they first appeared — including when
 * the row was minted by `findOrCreateClientId` on the operator's side first.
 */
export async function saveClientProfile(
  env: Env,
  email: string,
  input: ClientProfileInput,
): Promise<Client> {
  await env.DB.prepare(
    `INSERT INTO clients (id, email, phone, cc_emails, address, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       phone = excluded.phone,
       cc_emails = excluded.cc_emails,
       address = excluded.address`,
  )
    .bind(generateClientId(), email, input.phone, input.ccEmails, input.address, new Date().toISOString())
    .run()

  // Read back rather than assuming the INSERT branch won — see
  // `promoteLead`'s identical reasoning in `src/leads.ts` for why this is not
  // just paranoia: on the losing side of a race the row already reflects
  // whichever save actually landed last, and that is what the caller should
  // see rendered back, not the values it just tried to write.
  const client = await getClientByEmail(env, email)
  if (!client) throw new Error("saveClientProfile: upsert did not produce a readable row")
  return client
}
