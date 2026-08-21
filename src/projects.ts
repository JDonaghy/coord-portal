import { generateProjectId } from "./ids"
import type { Env } from "./types"

/**
 * The entity above `submissions` — issue #109. "A customer with an ongoing
 * relationship ... shows up as two unrelated cards on `/submissions`, not one
 * project with a combined history" was the gap; this is the table that
 * closes it.
 *
 * A project is deliberately thin: who it belongs to and when it started.
 * Everything else a screen shows about it — its title, its current status,
 * its timeline — is derived from the submissions under it, the same way a
 * submission's customer-visible status is derived rather than duplicated
 * (`src/rounds.ts`'s `derivedStatus`). See `migrations/0012_projects.sql` for
 * the rest of the schema reasoning, and `NewSubmissionInput.followUpFrom` in
 * `src/submissions.ts` for the one deliberate way a submission ever joins
 * one — never an inferred match on `customer_email` alone.
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
}

interface ProjectRow {
  id: string
  customer_email: string | null
  created_at: string
  client_id: string | null
}

function fromRow(row: ProjectRow): Project {
  return {
    id: row.id,
    customerEmail: row.customer_email,
    createdAt: row.created_at,
    clientId: row.client_id,
  }
}

/** A durable lookup by row id — same shape as `getSubmission`. */
export async function getProject(env: Env, id: string): Promise<Project | null> {
  const row = await env.DB.prepare(`SELECT * FROM projects WHERE id = ?`).bind(id).first<ProjectRow>()
  return row ? fromRow(row) : null
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
 */
export async function createClientProject(
  env: Env,
  clientId: string,
  customerEmail: string | null,
): Promise<Project> {
  const id = generateProjectId()
  const createdAt = new Date().toISOString()

  await env.DB.prepare(
    `INSERT INTO projects (id, customer_email, client_id, created_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(id, customerEmail, clientId, createdAt)
    .run()

  return { id, customerEmail, clientId, createdAt }
}

/**
 * Mints a client-linked project **and** moves a submission into it in one
 * transaction, but only while that submission is not in a project already —
 * issue #129's promotion-time "start a new project", and the auto-created
 * first project of a client nobody has seen before (contract mock 03).
 *
 * The guard is what makes promotion's own idempotency hold end to end.
 * `promoteLead` converges four promotes of one lead on a single submission
 * (`src/leads.ts`); without the `project_id IS NULL` clause below, each of
 * those retries would still mint a *project*, and a client that had been
 * promoted twice would show phantom reassignment targets holding nothing.
 * Both statements carry the identical guard and run in one `DB.batch()`, so
 * either the project is created and the submission lands in it, or neither
 * happens — the same shape, and the same reasoning, as
 * `projectAssignmentForFollowUp` below.
 *
 * Returns the project when this call is the one that created it, and `null`
 * when the submission was already in one (a replayed promote) — the caller
 * needs no more than that, and reading the row back would be a third query
 * for a fact no screen shows before the redirect.
 */
export async function attachNewClientProject(
  env: Env,
  submissionId: string,
  clientId: string,
  customerEmail: string | null,
): Promise<Project | null> {
  const id = generateProjectId()
  const createdAt = new Date().toISOString()

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO projects (id, customer_email, client_id, created_at)
       SELECT ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM submissions WHERE id = ? AND project_id IS NULL)`,
    ).bind(id, customerEmail, clientId, createdAt, submissionId),
    env.DB.prepare(`UPDATE submissions SET project_id = ? WHERE id = ? AND project_id IS NULL`).bind(
      id,
      submissionId,
    ),
  ])

  const project = await getProject(env, id)
  return project
}

/**
 * Moves a submission into a project it is not in yet, but only while it has
 * no project at all — the promotion-form counterpart of the unguarded
 * `setSubmissionProject` (`src/submissions.ts`), which #130's reassignment
 * uses precisely because a *promoted* submission may move any number of
 * times. A replayed `POST /leads/:id/promote` must not move a submission an
 * operator has since reassigned, so this one refuses to overwrite.
 */
export async function attachSubmissionToProjectIfUnassigned(
  env: Env,
  submissionId: string,
  projectId: string,
): Promise<void> {
  await env.DB.prepare(`UPDATE submissions SET project_id = ? WHERE id = ? AND project_id IS NULL`)
    .bind(projectId, submissionId)
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
