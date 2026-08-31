import { generateClientId } from "./ids"
import type { Env } from "./types"

/**
 * The `clients` table (issue #128) — "the row that represents 'this
 * customer,' not any one project or submission of theirs" (epic #122). This
 * module is the read/write surface issue #128's schema comment explicitly
 * deferred: "Lead promotion linking, project reassignment and the client
 * profile page are the other issues under epic #122 that build on this."
 *
 * Four callers, deliberately kept as separate entry points:
 *
 *  - `leads.ts` (#129, lead promotion) needs the match decision
 *    (`getClientRecordByEmail`) and the one guarded, batchable `INSERT`
 *    (`clientCreationStatement`).
 *  - `routes/leads.ts` (#130, "reassign a submission to a different, or new,
 *    project") needs only a way to find, or start, the `clients` row a
 *    reassignment target belongs to — `getClientIdByEmail` /
 *    `findOrCreateClientId`.
 *  - `routes/account.ts` (#131, the client's own self-service profile) is the
 *    only caller that reads or writes the profile columns —
 *    `getClientByEmail` / `saveClientProfile`.
 *  - `routes/clients.ts` (#150, "merge client B into client A") is the only
 *    caller of `mergeClients` / `listMergedClients` — see `mergeClients`'
 *    own doc comment below for why this is operator-side grouping only, and
 *    deliberately never touches `submissions.customer_email` or
 *    `projects.customer_email`.
 *
 * `phone`, `ccEmails` and `address` are the only writable columns — `email`
 * is the row's identity (`clients.email UNIQUE`) and is never written by this
 * module; see `src/routes/account.ts` for why it is never accepted from a
 * request either.
 *
 * ── TWO BY-EMAIL LOOKUPS, ON PURPOSE — READ THIS BEFORE PICKING ONE ────────
 * `getClientRecordByEmail` (#129) matches `lower(email) = lower(?)` and
 * returns a `ClientRecord`; `getClientByEmail` (#131) matches `email = ?`
 * exactly and returns a full `Client`. That difference is deliberate on both
 * sides — see each function's own comment — and it is NOT type-enforced:
 * `Client` is structurally a superset of `ClientRecord`, so binding the wrong
 * one compiles cleanly and then silently fails to match a differently-cased
 * address. Pick by the question you are asking, not by which name is shorter:
 * "is there a client for this address anybody typed?" is the case-insensitive
 * one; "load the profile for the caller's own verified address" is the exact
 * one.
 *
 * ── #129 IS WHERE A CLIENT ROW FIRST GETS MINTED, NOT #130 ─────────────────
 * An earlier draft of this module (and, before that, an earlier draft of
 * `promoteLead` itself) minted a client and a first project unconditionally
 * the moment ANY lead was promoted — including a lead whose email never
 * matched anyone, which is exactly the behavior issue #129 describes as "No
 * match — auto-create a `clients` row ... and a project titled 'Project 1'
 * ... in the same batch". That is deliberate, load-bearing, and lives in
 * `promoteLead` (`src/leads.ts`), not here — this module only holds the
 * lookups and the one guarded `INSERT` statement `promoteLead` needs, plus
 * `findOrCreateClientId` for #130's own "start a new project" reassignment
 * path, which still runs long after promotion and needs its own,
 * non-batched, upsert-shaped entry point.
 *
 * ── THE TENSION THIS CREATED WITH MS-2's SEALED SUITE, AND HOW IT WAS SOLVED ──
 * `tests/acceptance/ms-2/33-lead-triage-promotion.spec.ts` (sealed, never
 * reopened) reads a just-promoted lead's submission back on the customer's
 * own `/submissions` and asserts exactly one `submission-row`.
 * `routes/dashboard.ts`'s `groupByProject` used to render ANY submission
 * carrying a non-null `project_id` as a `project-row` instead (a distinct
 * `data-testid`) — so from the moment #129 ships, EVERY promoted lead's
 * submission carries a `project_id` (the matched-existing-project branch, the
 * matched-new-project branch, and the no-match auto-create branch all set
 * one), and ms-2 test #33's own synthetic lead necessarily goes through the
 * same code path, which regressed three of that sealed suite's assertions —
 * confirmed by actually running it (`playwright.acceptance.config.ts ms-2/33`)
 * against this issue's implementation before this comment was written.
 *
 * This was not possible to route around within #129's own scope:
 * `tests/acceptance/ms-4/129-lead-promotion-client-link.spec.ts` (also
 * sealed) directly reads `submissions.project_id` back for the no-match case
 * and requires it non-null ("the promoted submission is attached to the
 * project promotion just created, not left loose") — so #129's own oracle
 * requires exactly the write that broke ms-2's. The fix instead narrows
 * `groupByProject` itself (`routes/dashboard.ts`) to collapse into a
 * `project-row` only once a project has *two or more* submissions — provably
 * behavior-preserving for every case that predates #129: #109's own
 * mechanism (`projectAssignmentForFollowUp`, `src/projects.ts`) never
 * produces a project with fewer than two members in the first place, so
 * "any `projectId`" and "two or more" were equivalent before this issue, and
 * no sealed suite anywhere pins the single-member case either way — #109 has
 * no sealed acceptance slice of its own. See `groupByProject`'s own doc
 * comment for the full reasoning; it is the one place this actually needed
 * fixing, not this module.
 *
 * ── WHO CAN MINT THE ROW ───────────────────────────────────────────────────
 * Three paths can now be the first to create a `clients` row: promotion
 * (`clientCreationStatement`, #129), an operator's reassignment
 * (`findOrCreateClientId`, #130) and a customer saving their profile
 * (`saveClientProfile`, #131). All three are idempotent against
 * `clients.email UNIQUE` and none rewrites an existing row's `id` or
 * `created_at`, so whichever arrives first wins and the others resolve onto
 * it.
 */
export interface Client {
  id: string
  email: string
  phone: string | null
  ccEmails: string | null
  address: string | null
  createdAt: string
  /**
   * The surviving `clients.id` this row was merged into (issue #150,
   * `migrations/0019_client_merge.sql`), or `null` for every row that was
   * never merged away — which is every row before that migration, and most
   * rows after it. See `mergeClients` below for the only writer.
   */
  mergedInto: string | null
  /** The companion timestamp to `mergedInto` — `null` exactly when it is. */
  mergedAt: string | null
}

interface ClientRow {
  id: string
  email: string
  phone: string | null
  cc_emails: string | null
  address: string | null
  created_at: string
  merged_into: string | null
  merged_at: string | null
}

function fromRow(row: ClientRow): Client {
  return {
    id: row.id,
    email: row.email,
    phone: row.phone,
    ccEmails: row.cc_emails,
    address: row.address,
    createdAt: row.created_at,
    mergedInto: row.merged_into,
    mergedAt: row.merged_at,
  }
}

/** A `clients` row's identity columns — `src/leads.ts`'s `promoteLead` needs
 * `email` (verbatim, for `client-attachment`'s text) and `createdAt` (to tell,
 * at render time, whether this promotion is the one that created the row — see
 * that module's own doc comment) in addition to the `id` the id-only lookup
 * below still returns for `postLeadReassign`'s callers. Deliberately NOT the
 * full `Client`: none of #129's surfaces read the profile columns, and
 * selecting them here would invite the two lookups to drift into one. */
export interface ClientRecord {
  id: string
  email: string
  createdAt: string
}

type ClientIdentityRow = Pick<ClientRow, "id" | "email" | "created_at">

function toRecord(row: ClientIdentityRow): ClientRecord {
  return { id: row.id, email: row.email, createdAt: row.created_at }
}

/**
 * A read-only lookup, for rendering `GET /leads/:id` and for `promoteLead`'s
 * own match decision — never writes. Case-insensitive, by the same inference
 * `src/operators.ts`'s allowlist comparison and ms-4 contract note 3 both
 * take: no identity provider treats an address's local part as
 * case-sensitive in practice. This is the lookup that decides whether a lead
 * is a returning customer, so a case-sensitive miss here is a user-visible
 * bug, not a nicety — contrast `getClientByEmail` below, which is exact on
 * purpose because it only ever looks up the caller's own verified address.
 */
export async function getClientRecordByEmail(env: Env, email: string): Promise<ClientRecord | null> {
  const row = await env.DB.prepare(`SELECT id, email, created_at FROM clients WHERE lower(email) = lower(?)`)
    .bind(email)
    .first<ClientIdentityRow>()
  return row ? toRecord(row) : null
}

/**
 * The other half of issue #163 (EM-3)'s rung 3 — "`getClientRecordByEmail()`
 * (case-insensitive) plus `clients.cc_emails`." A sender who is not the
 * client's own address but is copied on their mail (a spouse, an assistant,
 * a second stakeholder) still resolves to the same client, the same way
 * `mergeClients` above treats `cc_emails` as "addresses this client's mail
 * also goes to or comes from."
 *
 * `cc_emails` is free text (`routes/account.ts`'s own profile form writes it
 * unvalidated, and `mergeClients` appends to it with a bare `,` join) — never
 * guaranteed to be tightly comma-packed, so a customer who typed
 * `"a@x.test, b@x.test"` still matches. Spaces are stripped before the `LIKE`
 * rather than split-and-trimmed in JS, so this stays one query instead of a
 * full-table fetch to filter in memory. Case-insensitive for the same reason
 * `getClientRecordByEmail` is: no identity provider treats a local part as
 * case-sensitive in practice, and rung 3's whole point is not missing a real
 * match on casing alone.
 *
 * Read-only, like everything else exported from this module for EM-3 — see
 * that issue's own "adds no write path" scope note.
 */
export async function getClientRecordByCcEmail(env: Env, email: string): Promise<ClientRecord | null> {
  const row = await env.DB.prepare(
    `SELECT id, email, created_at FROM clients
      WHERE cc_emails IS NOT NULL
        AND (',' || REPLACE(lower(cc_emails), ' ', '') || ',') LIKE '%,' || lower(?) || ',%'
      LIMIT 1`,
  )
    .bind(email)
    .first<ClientIdentityRow>()
  return row ? toRecord(row) : null
}

/** Same lookup, by durable id — for `routes/leads.ts`'s attachment rendering,
 * which already has a `client_id` off a project and needs the row it names. */
export async function getClientById(env: Env, id: string): Promise<ClientRecord | null> {
  const row = await env.DB.prepare(`SELECT id, email, created_at FROM clients WHERE id = ?`)
    .bind(id)
    .first<ClientIdentityRow>()
  return row ? toRecord(row) : null
}

/** The id-only shape most callers actually want. Case-insensitive, via
 * `getClientRecordByEmail`. */
export async function getClientIdByEmail(env: Env, email: string): Promise<string | null> {
  return (await getClientRecordByEmail(env, email))?.id ?? null
}

/**
 * The client-creation statement for `promoteLead`'s no-match branch (#129) —
 * returned rather than executed so it lands in the same `DB.batch()` as the
 * project and submission it is for (see `projectCreationForEmailResolvedClient`
 * in `src/projects.ts`, which resolves `client_id` back from this row within
 * the same transaction).
 *
 * Doubly guarded: `NOT EXISTS` on the email — the same protection
 * `findOrCreateClientId` below gives its own, later, non-batched callers,
 * for the same race (two different leads sharing an email, promoted at
 * once) — *and* on `leadId`, so a double-submitted promote of one lead does
 * not mint a second client for an address that already has one. `clients.email`
 * is `UNIQUE` (0016) regardless, as the hard backstop if both checks somehow
 * lose a race neither should be able to lose within one D1 transaction.
 */
export function clientCreationStatement(
  env: Env,
  id: string,
  email: string,
  createdAt: string,
  leadId: string,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO clients (id, email, created_at)
     SELECT ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM clients WHERE lower(email) = lower(?))
        AND EXISTS (SELECT 1 FROM leads WHERE id = ? AND promoted_at IS NULL)`,
  ).bind(id, email, createdAt, email, leadId)
}

/**
 * The other place a `clients` row can be minted — `clientCreationStatement`
 * above is the one inside `promoteLead`'s own transaction (#129); this is
 * `POST /leads/:id/reassign`'s own, later, non-batched entry point (#130),
 * for an operator's "start a new project" choice on a submission whose lead
 * predates #129 and so was never matched or created at promotion time.
 * Idempotent against a double-submitted reassignment racing itself:
 * `clients.email` is `UNIQUE` (0016), so even if two requests both miss the
 * `SELECT` below, only one `INSERT` can win, and the final read always
 * resolves to whichever row exists.
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
 * for a *different* caller's lookup (lead promotion, #129, and reassignment,
 * #130 — both via `getClientRecordByEmail` / `getClientIdByEmail` above) are
 * that caller's own call to make; this one only ever looks up the caller's
 * own address, so there is no ambiguity to resolve.
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
 * the row was minted by `clientCreationStatement` at promotion (#129) or by
 * `findOrCreateClientId` on the operator's side first.
 */
/**
 * One row per client for `GET /clients` (issue #144) — "who are my
 * customers", the operator screen this repo did not have despite `clients`
 * (#128) and `projects` (#109) both existing. Newest-client-first, matching
 * every other operator list in this codebase (`listLeads`,
 * `listProjectsForClient`) — see that function's own note on why "newest"
 * means created-first rather than most-recently-active, which is instead one
 * of the columns this type carries (`lastActivityAt`) rather than the sort
 * key.
 *
 * `displayName` is `email` today, always — there is no `clients.name` column
 * (0016 never added one; issue #144's own ask, "display name (or email if
 * unnamed)", degrades to "email" for every client that exists until a future
 * issue adds one). It is still its own field, not folded into `email`,
 * because #144's contract draws them as two separate pieces of copy (a
 * heading and a contact line) and a future name column should not have to
 * touch this shape again to stop collapsing them.
 */
export interface ClientSummary {
  id: string
  email: string
  displayName: string
  createdAt: string
  /** Every `projects` row with `client_id = this client`, per
   * `listProjectsForClient` — never a project matched only by
   * `customer_email` (see that function's own doc comment). */
  projectCount: number
  /** Every submission under one of this client's projects. */
  submissionCount: number
  /**
   * The newest of: this client's own submissions' `created_at`, their
   * projects' `created_at`, or (a client with neither yet — freshly minted by
   * a reassignment, `findOrCreateClientId`) the client row's own `created_at`.
   * "Most recent activity", per #144's own column list.
   */
  lastActivityAt: string
  /**
   * The email of the client this row was merged into (issue #150), or `null`
   * for every row that was never merged away. `clientRow` (`routes/clients
   * .ts`) uses this to badge a merged-away row instead of hiding it — see
   * #150's own "the merge is visible after the fact" requirement. Note this
   * is already the *email*, not the id: `listClients` joins `clients` to
   * itself on `merged_into` so this screen never has to look the survivor up
   * a second time just to name it.
   */
  mergedIntoEmail: string | null
}

interface ClientSummaryRow {
  id: string
  email: string
  created_at: string
  project_count: number
  submission_count: number
  last_activity_at: string
  merged_into_email: string | null
}

/**
 * Every client, most-recently-created first, each with the counts and
 * last-activity timestamp `GET /clients` renders — one query rather than a
 * `listProjectsForClient` + submissions fan-out per client, the same
 * aggregate-in-SQL posture `loadSignoffStates` (`src/rounds.ts`) takes for
 * "many rows' worth of derived facts in one round trip" rather than one D1
 * subrequest per row.
 *
 * `LEFT JOIN`s throughout: a client with no projects yet (freshly created by
 * a reassignment that has not yet moved anything onto it) must still appear,
 * with zero counts, not be silently dropped by an inner join.
 */
export async function listClients(env: Env): Promise<ClientSummary[]> {
  const { results } = await env.DB.prepare(
    `SELECT
       c.id, c.email, c.created_at,
       COUNT(DISTINCT p.id) AS project_count,
       COUNT(DISTINCT s.id) AS submission_count,
       MAX(COALESCE(s.created_at, p.created_at, c.created_at)) AS last_activity_at,
       survivor.email AS merged_into_email
     FROM clients c
     LEFT JOIN projects p ON p.client_id = c.id
     LEFT JOIN submissions s ON s.project_id = p.id
     LEFT JOIN clients survivor ON survivor.id = c.merged_into
     GROUP BY c.id
     ORDER BY c.created_at DESC, c.rowid DESC`,
  ).all<ClientSummaryRow>()

  return (results ?? []).map((row) => ({
    id: row.id,
    email: row.email,
    displayName: row.email,
    createdAt: row.created_at,
    projectCount: row.project_count,
    submissionCount: row.submission_count,
    lastActivityAt: row.last_activity_at,
    mergedIntoEmail: row.merged_into_email,
  }))
}

/**
 * The full profile row for `GET /clients/:id` (issue #144) — unlike
 * `getClientById` above (identity columns only, for `routes/leads.ts`'s
 * attachment rendering), this screen shows the same contact details
 * `routes/account.ts` lets the customer maintain about themselves: phone, cc
 * emails, address.
 */
export async function getClientProfileById(env: Env, id: string): Promise<Client | null> {
  const row = await env.DB.prepare(`SELECT * FROM clients WHERE id = ?`).bind(id).first<ClientRow>()
  return row ? fromRow(row) : null
}

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

/**
 * Every distinct failure `mergeClients` refuses on — self-merge, an id that
 * does not name a `clients` row, or a merge that would chain (see the
 * function's own doc comment). `routes/clients.ts` catches this and renders
 * `error.message` back on the merge form, the same "malformed input gets a
 * message, not a 500" posture `postLeadMessage` already takes for a blank
 * message body.
 */
export class ClientMergeError extends Error {}

/** One row `listMergedClients` returns — just enough for `routes/clients.ts`'
 * "merged clients" section on the surviving client's own detail page. */
export interface MergedClient {
  id: string
  email: string
  mergedAt: string
}

interface MergedClientRow {
  id: string
  email: string
  merged_at: string
}

/**
 * The reverse of `mergeClients`' own write — every client folded into
 * `survivingId`, oldest merge first. This is how #150's "the merge is
 * visible after the fact" requirement is met on the surviving client's own
 * page: not by inferring it from `cc_emails` (which also carries addresses a
 * customer entered themselves via `saveClientProfile`, #131, and cannot be
 * told apart from a merge-sourced one once both are joined into one string),
 * but from `merged_into`, which only `mergeClients` ever writes.
 */
export async function listMergedClients(env: Env, survivingId: string): Promise<MergedClient[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, email, merged_at FROM clients WHERE merged_into = ? ORDER BY merged_at ASC, rowid ASC`,
  )
    .bind(survivingId)
    .all<MergedClientRow>()
  return (results ?? []).map((row) => ({ id: row.id, email: row.email, mergedAt: row.merged_at }))
}

/**
 * Issue #150 — "an operator can merge client B into client A, after the fact
 * ... every `projects.client_id` pointing at B is repointed to A in the same
 * batch as B's removal ... B's address is preserved on A ... `submissions
 * .customer_email` and `projects.customer_email` are NOT rewritten."
 *
 * This is deliberately operator-side grouping ONLY — the issue is explicit
 * that widening customer-side visibility (`isOwnedBy`, `src/routes/submission
 * .ts`) is a separate, dangerous decision this function must not make by
 * accident: it never touches `submissions.customer_email` or
 * `projects.customer_email`, so `isOwnedBy`'s exact-match check keeps working
 * exactly as it did before this issue, for every submission either client
 * ever filed.
 *
 * ── WHY `cc_emails`, AND WHY IT NEEDS SAYING HERE ───────────────────────────
 * `cc_emails` (0016) has meant "addresses to copy on mail" to every reader
 * since #131 — a comma-separated TEXT column the customer's own profile form
 * writes and nothing yet read. This function is the second writer, and gives
 * it a second meaning: an address a merge folded in is also appended here, so
 * the relationship is not lost the moment B's own row stops being the place
 * anyone looks. `listMergedClients` above is the structured way to tell the
 * two apart later (only `merged_into` is proof of an actual merge); this
 * column is just where the address itself ends up.
 *
 * ── SELF-MERGE AND CHAINS ────────────────────────────────────────────────────
 * Refuses `survivingId === mergedId` outright (#150's own "refuses to merge a
 * client into itself"). Also refuses merging *into* a client that has itself
 * already been merged away, and refuses re-merging a client that has already
 * been merged into a *different* survivor — both would otherwise let a chain
 * form (B into A, then A into C), which `listMergedClients(env, A)` cannot
 * represent: it only ever looks one level down, by design, because a merge
 * chain is not a case this issue's contract describes.
 *
 * ── IDEMPOTENT ────────────────────────────────────────────────────────────
 * Calling this again with the exact same `(survivingId, mergedId)` pair after
 * it already succeeded is a silent no-op — a retried or doubled form submit
 * must not re-append B's address to `cc_emails` a second time, and the
 * `merged_into IS NULL` guard on the final `UPDATE` below is what makes that
 * true even under a genuine race, not just the early-return above (which only
 * protects a *sequential* retry that reads the already-merged state).
 *
 * ── ONE BATCH, EXACTLY LIKE `promoteLead` ────────────────────────────────────
 * All three writes — the `cc_emails` append, the project repoint, and the
 * `merged_into`/`merged_at` stamp — land in one `DB.batch()`, so a project is
 * never left pointing at a `client_id` that no longer has any other record of
 * having owned it. There is no FK (0016 says so deliberately) — this
 * transaction is the only thing that keeps a merge from orphaning a project.
 */
export async function mergeClients(env: Env, survivingId: string, mergedId: string): Promise<void> {
  if (survivingId === mergedId) {
    throw new ClientMergeError("A client cannot be merged into itself.")
  }

  const [surviving, merged] = await Promise.all([
    getClientProfileById(env, survivingId),
    getClientProfileById(env, mergedId),
  ])
  if (!surviving) throw new ClientMergeError(`No such client: ${survivingId}.`)
  if (!merged) throw new ClientMergeError(`No such client: ${mergedId}.`)

  // Idempotent: this exact merge already happened. A genuine race past this
  // point is still safe — see the `merged_into IS NULL` guard below.
  if (merged.mergedInto === survivingId) return

  if (merged.mergedInto) {
    throw new ClientMergeError("This client has already been merged into a different client.")
  }
  if (surviving.mergedInto) {
    throw new ClientMergeError("Cannot merge into a client that has itself been merged away.")
  }

  const mergedAt = new Date().toISOString()

  await env.DB.batch([
    // Preserve B's address on A — see this function's own doc comment for
    // why `cc_emails` is the column and what that means for anyone reading
    // #131's own comment on it. The `LIKE` branch keeps a retried call (or a
    // genuine race with the guarded stamp below) from appending twice.
    env.DB.prepare(
      `UPDATE clients SET cc_emails =
         CASE
           WHEN cc_emails IS NULL OR cc_emails = '' THEN ?
           WHEN ',' || cc_emails || ',' LIKE '%,' || ? || ',%' THEN cc_emails
           ELSE cc_emails || ',' || ?
         END
       WHERE id = ?`,
    ).bind(merged.email, merged.email, merged.email, survivingId),

    // Every project B still owns, repointed to A — in the same batch as B's
    // own removal below, which is the entire point: there is no FK to stop
    // an orphaned `client_id`, so this transaction is what does.
    env.DB.prepare(`UPDATE projects SET client_id = ? WHERE client_id = ?`).bind(survivingId, mergedId),

    // Mark B as merged away. Guarded on `merged_into IS NULL` so a retried or
    // genuinely racing duplicate call is a no-op here too, not a clobbered
    // `merged_at`.
    env.DB.prepare(
      `UPDATE clients SET merged_into = ?, merged_at = ? WHERE id = ? AND merged_into IS NULL`,
    ).bind(survivingId, mergedAt, mergedId),
  ])
}
