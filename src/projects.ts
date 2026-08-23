import { chunkForBinding } from "./d1"
import { generateProjectId } from "./ids"
import type { Env } from "./types"

/**
 * The entity above `submissions` — issue #109. "A customer with an ongoing
 * relationship ... shows up as two unrelated cards on `/submissions`, not one
 * project with a combined history" was the gap; this is the table that
 * closes it.
 *
 * `id`, who it belongs to, and when it started are the only facts this row
 * has ever stored on its own — everything else a screen shows about it, its
 * current status and its timeline, is still derived from the submissions
 * under it, the same way a submission's customer-visible status is derived
 * rather than duplicated (`src/rounds.ts`'s `derivedStatus`). See
 * `migrations/0012_projects.sql` for the rest of that reasoning, and
 * `NewSubmissionInput.followUpFrom` in `src/submissions.ts` for the one
 * deliberate way a submission ever joins one — never an inferred match on
 * `customer_email` alone.
 *
 * `name` (issue #149, `migrations/0018_project_name.sql`) is the one
 * exception to "thin": a project's title used to be *only* ever derived — the
 * first line of whichever submission under it happens to be newest — and
 * that title silently changed every time the customer filed a follow-up,
 * with no stable handle an operator holding many clients' many projects
 * could build a mental index against. `name` is nullable and defaults to
 * `null` ("not named") for every project that predates this column, and for
 * every one a customer's own follow-up still mints today
 * (`projectAssignmentForFollowUp` below never sets it — naming is an
 * operator act on a customer relationship, not something inferred from a
 * customer's own words); `null` still renders exactly as before, via the
 * same derivation. A name is also not "state" in the sense the paragraph
 * above guards against — there is no derived truth for it to disagree with,
 * it is a customer-relationship fact with no other representation anywhere,
 * exactly the kind of fact this repo's single-writer-per-fact rule
 * (`CLAUDE.md`) makes the portal the sole owner of.
 */
export interface Project {
  id: string
  customerEmail: string | null
  createdAt: string
  /**
   * The `clients` row this project belongs to, or `null` — issue #128's
   * `projects.client_id`, added long after this module's own `customerEmail`
   * column and deliberately not replacing it (see `migrations/0016_clients.sql`:
   * "it does not touch `submissions` — the link is `submissions → projects →
   * clients`"). `null` for every project this repo had before #128, and for
   * any project a customer's own "Start a follow-up" action creates today
   * (`projectAssignmentForFollowUp` below never sets it) — only lead
   * promotion (`src/clients.ts`) ever does.
   */
  clientId: string | null
  /**
   * An operator-chosen label, or `null` — "not named", the state of every
   * project before issue #149 and of every one a customer's own follow-up
   * still mints. `projectTitle` (`routes/leads.ts`) is the one place this is
   * ever turned into a display string: it wins outright over the derived
   * title when set, and falls back to the pre-#149 derivation when `null`.
   *
   * Deliberately not operator-only internal shorthand: it is read back by
   * that same `projectTitle` on the customer's own `/projects/:id`
   * (`routes/project.ts`), so it is customer-visible copy the moment it is
   * set — an operator naming a project should pick something they are fine
   * with the client seeing, not a code word. See `routes/project.ts`'s own
   * doc comment for the fuller reasoning behind that choice.
   */
  name: string | null
}

interface ProjectRow {
  id: string
  customer_email: string | null
  created_at: string
  client_id: string | null
  name: string | null
}

function fromRow(row: ProjectRow): Project {
  return {
    id: row.id,
    customerEmail: row.customer_email,
    createdAt: row.created_at,
    clientId: row.client_id,
    name: row.name,
  }
}

/**
 * Blank and whitespace-only collapse to `null` — "not named" — the same
 * convention `routes/account.ts`'s own `optionalField` uses for a client's
 * optional profile fields. Shared by `createClientProject` (naming a project
 * at the moment it is minted) and `renameProject` below (naming or clearing
 * one afterward), so the two never drift on what counts as blank.
 */
function normalizeProjectName(raw: string | null | undefined): string | null {
  const trimmed = typeof raw === "string" ? raw.trim() : ""
  return trimmed === "" ? null : trimmed
}

/** A durable lookup by row id — same shape as `getSubmission`. */
export async function getProject(env: Env, id: string): Promise<Project | null> {
  const row = await env.DB.prepare(`SELECT * FROM projects WHERE id = ?`).bind(id).first<ProjectRow>()
  return row ? fromRow(row) : null
}

/**
 * Many projects by id, in as few queries as D1 allows — the customer's own
 * `/submissions` (`routes/dashboard.ts`'s `groupByProject`/`projectRow`,
 * issue #149) groups their submissions by project and needs each group's
 * `name` to title its row through `projectTitleFromNewest`
 * (`routes/leads.ts`) the same way every other screen does; a per-row
 * `getProject` would spend one D1 subrequest per project row on a page that
 * can list many. Same `chunkForBinding` split `loadSignoffStates`
 * (`src/rounds.ts`) already uses, and for the identical reason — a caller
 * with more than `D1_MAX_BOUND_PARAMS` projects on one page must not become
 * `D1_ERROR: too many SQL variables` (see #104's own fix for the sibling
 * case of this on `/requests`).
 *
 * Returns a map keyed by id; an id with no matching row (should not happen
 * for a `projectId` read off a submission, but this is a caller-supplied
 * list) is simply absent from the result rather than an error, the same
 * "missing means absent" convention `loadSignoffStates` and
 * `loadStartWorkStates` already use for their own maps.
 */
export async function getProjectsByIds(env: Env, ids: string[]): Promise<Map<string, Project>> {
  const projects = new Map<string, Project>()
  if (ids.length === 0) return projects

  const batches = await Promise.all(
    chunkForBinding(ids).map(async (chunk) => {
      const placeholders = chunk.map(() => "?").join(", ")
      const { results } = await env.DB.prepare(`SELECT * FROM projects WHERE id IN (${placeholders})`)
        .bind(...chunk)
        .all<ProjectRow>()
      return results ?? []
    }),
  )

  for (const row of batches.flat()) {
    projects.set(row.id, fromRow(row))
  }
  return projects
}

/**
 * Every project carrying a given `client_id`, newest first — issue #130's
 * "which projects are even offered", quoting the ms-4 contract: "built from
 * `SELECT * FROM projects WHERE client_id = ?` — **only** projects that
 * already carry the matched `clients.id`". A project with a matching
 * `customer_email` but `client_id IS NULL` (pre-#128, or created through
 * `projectAssignmentForFollowUp`) is deliberately excluded — the contract
 * calls that out by name as a case a test may construct and expect absent.
 */
export async function listProjectsForClient(env: Env, clientId: string): Promise<Project[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM projects WHERE client_id = ? ORDER BY created_at DESC, rowid DESC`,
  )
    .bind(clientId)
    .all<ProjectRow>()
  return (results ?? []).map(fromRow)
}

/**
 * Mints one new project, client-linked from the moment it exists — the
 * "create a new project instead" half of issue #130's reassignment panel,
 * and (unlike `projectAssignmentForFollowUp`) not conditional on anything:
 * the caller already knows a submission is about to move into it.
 *
 * `name` (issue #149) is optional and defaults to `null` — the caller (the
 * "start a new project instead" branch of `applyReassignmentChoice`,
 * `routes/leads.ts`) offers the operator a field to name it inline, but a
 * blank submit is not an error, it just leaves the project deriving its
 * title the way every project before this issue always has.
 */
export async function createClientProject(
  env: Env,
  clientId: string,
  customerEmail: string | null,
  name: string | null = null,
): Promise<Project> {
  const id = generateProjectId()
  const createdAt = new Date().toISOString()
  const normalizedName = normalizeProjectName(name)

  await env.DB.prepare(
    `INSERT INTO projects (id, customer_email, client_id, created_at, name) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(id, customerEmail, clientId, createdAt, normalizedName)
    .run()

  return { id, customerEmail, clientId, createdAt, name: normalizedName }
}

/**
 * Sets, changes or clears a project's own name — issue #149's "an operator
 * can rename an existing one." A blank `rawName` is not an error: it clears
 * the name back to `null`, which is exactly "go back to deriving the title
 * from the newest submission" (`projectTitle`, `routes/leads.ts`), not a
 * failure mode — same convention `normalizeProjectName` already gives
 * `createClientProject`.
 *
 * A plain, unconditional `UPDATE`, not a returned-for-batching statement like
 * the guarded writes below: renaming has no doubled-submit race to protect
 * against the way promoting a lead or filing a first follow-up does — an
 * operator typing into one field on one screen and a customer's concurrent
 * follow-up landing on the very same project are independent facts, and the
 * worst a genuine double-click here does is write the same value twice.
 */
export async function renameProject(env: Env, id: string, rawName: string | null): Promise<void> {
  await env.DB.prepare(`UPDATE projects SET name = ? WHERE id = ?`)
    .bind(normalizeProjectName(rawName), id)
    .run()
}

/**
 * The statements that attach a brand-new submission to the same project as
 * `followUpFromId` — minting that project on its first use. Returned rather
 * than executed, exactly like `createSubmissionStatements` in
 * `src/submissions.ts` (the only caller), so everything here lands in the
 * same `DB.batch()` as the submission it is for — one transaction, so a
 * project is never created without the follow-up that asked for it existing
 * too, or vice versa.
 *
 * ── WHY THIS IS SAFE AGAINST A DOUBLED FOLLOW-UP SUBMIT ────────────────────
 * `followUpFromId` names one existing submission, never an email — this is
 * not the "does this customer already have a submission?" scan that would
 * silently merge two unrelated asks (see the migration's comment on why that
 * is explicitly ruled out). The project INSERT is guarded on `EXISTS (...
 * WHERE id = ? AND project_id IS NULL)`, and the origin row's own UPDATE
 * carries the identical guard. Both run inside the caller's transaction, so
 * within one batch either both fire (first follow-up: a project is minted and
 * the origin row is stamped with it) or neither does (a later follow-up from
 * the same origin already has a `project_id`, so both guards read false).
 *
 * Two *separate* batches from a genuinely doubled submit still converge on
 * one project: D1 runs one `DB.batch()` at a time, so whichever transaction
 * commits first wins the guard, and the second transaction's own guard check
 * now reads the row the first one already stamped. That is also why the new
 * submission's `project_id` is never the app-generated candidate id bound
 * directly — `projectIdExpr` below reads it back live, inside the same
 * transaction, from whatever the origin row's `project_id` actually is by the
 * time the submission itself is inserted.
 *
 * This `INSERT` never sets `name` (issue #149) — naming is an operator act on
 * a customer relationship, and a customer's own "Start a follow-up" is the
 * one path in this codebase that is explicitly not that.
 */
export function projectAssignmentForFollowUp(
  env: Env,
  customerEmail: string | null,
  followUpFromId: string,
  createdAt: string,
): {
  statements: D1PreparedStatement[]
  /** A SQL expression for the new submission's `project_id` column. */
  projectIdExpr: string
  projectIdBindings: unknown[]
} {
  const candidateProjectId = generateProjectId()

  const createProjectIfFirstFollowUp = env.DB.prepare(
    `INSERT INTO projects (id, customer_email, created_at)
     SELECT ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM submissions WHERE id = ? AND project_id IS NULL)`,
  ).bind(candidateProjectId, customerEmail, createdAt, followUpFromId)

  const stampOrigin = env.DB.prepare(
    `UPDATE submissions SET project_id = ? WHERE id = ? AND project_id IS NULL`,
  ).bind(candidateProjectId, followUpFromId)

  return {
    statements: [createProjectIfFirstFollowUp, stampOrigin],
    projectIdExpr: `(SELECT project_id FROM submissions WHERE id = ?)`,
    projectIdBindings: [followUpFromId],
  }
}

/**
 * The two project-creation statements issue #129's `promoteLead`
 * (`src/leads.ts`) needs — returned rather than executed, exactly like
 * `projectAssignmentForFollowUp` above, so each lands in the same
 * `DB.batch()` as the client and submission rows it belongs with.
 *
 * Both are guarded on the same condition `promoteLead` already guards its
 * own submission insert on — `leads.id = ? AND leads.promoted_at IS NULL` —
 * so a double-submitted promote of the *same* lead mints no second project:
 * on the losing side of that race every statement in the batch, including
 * this one, matches zero rows. Neither takes `src/submissions.ts`'s
 * `CreateGuard` shape; there is exactly one caller and exactly one condition,
 * so a `leadId` parameter says the same thing with less indirection.
 *
 * Neither statement below takes a `name` (issue #149): letting an operator
 * name a project at the moment promotion itself mints it is issue #124's own
 * "default-create" scope, not this one's — every project either of these
 * statements creates keeps minting with `name IS NULL`, deriving its title
 * exactly as it always has, until #124 adds its own path. `createClientProject`
 * above, and `renameProject`, are #149's own writers.
 */

/**
 * For the "operator picked an existing client, but this ask starts a new
 * project" branch — `clientId` is already known (read before the batch was
 * built), so it is bound directly.
 */
export function projectCreationForKnownClient(
  env: Env,
  id: string,
  customerEmail: string | null,
  clientId: string,
  createdAt: string,
  leadId: string,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO projects (id, customer_email, client_id, created_at)
     SELECT ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM leads WHERE id = ? AND promoted_at IS NULL)`,
  ).bind(id, customerEmail, clientId, createdAt, leadId)
}

/**
 * For the "no match" branch, where the client row this project belongs to is
 * being minted in the very same batch (`clientCreationStatement`,
 * `src/clients.ts`). `client_id` is resolved by a subquery on the email,
 * read back live within the transaction, rather than a candidate id trusted
 * to have won — on the rare race of two *different* leads sharing an email
 * promoted at once, the losing side's own client insert fires nothing (its
 * `NOT EXISTS` fails), and this subquery still finds the client row that
 * actually exists, so the project it creates lands on the real one instead
 * of an orphaned id nothing else points to.
 *
 * That said, this statement is only guarded on `leadId`, not on whether its
 * sibling client-insert was the one that won the race — so the losing lead's
 * own project insert still fires, and still resolves `client_id` correctly
 * via the subquery above. The accepted-but-real outcome of that race is a
 * client left with *two* projects (one per concurrently-promoted lead)
 * instead of the second lead joining the first project the winning
 * transaction created. That is judged strictly better than the alternative
 * (an orphaned id), but it is not "resolves correctly" in every sense — a
 * client can end up with an extra "Project 1"-shaped project nobody asked
 * for, from a race window that only exists for two never-before-seen leads
 * sharing an email promoted at the same instant.
 */
export function projectCreationForEmailResolvedClient(
  env: Env,
  id: string,
  customerEmail: string,
  createdAt: string,
  leadId: string,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO projects (id, customer_email, client_id, created_at)
     SELECT ?, ?, (SELECT id FROM clients WHERE lower(email) = lower(?)), ?
      WHERE EXISTS (SELECT 1 FROM leads WHERE id = ? AND promoted_at IS NULL)`,
  ).bind(id, customerEmail, customerEmail, createdAt, leadId)
}
