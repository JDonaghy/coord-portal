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
}

interface ProjectRow {
  id: string
  customer_email: string | null
  created_at: string
}

function fromRow(row: ProjectRow): Project {
  return {
    id: row.id,
    customerEmail: row.customer_email,
    createdAt: row.created_at,
  }
}

/** A durable lookup by row id — same shape as `getSubmission`. */
export async function getProject(env: Env, id: string): Promise<Project | null> {
  const row = await env.DB.prepare(`SELECT * FROM projects WHERE id = ?`).bind(id).first<ProjectRow>()
  return row ? fromRow(row) : null
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
