import { generateSubmissionId, generateSubmissionReference } from "./ids"
import type { Env } from "./types"

/**
 * The record model issue #8 carries forward — see `migrations/0002_submissions.sql`.
 * Scoped to what #9 needs: a submission is created once, at `describing`, and
 * nothing here yet models the later vocabulary (#10/#13). Adding those columns
 * ahead of the issue that needs them is exactly the "build ahead" this
 * milestone's issues warn against.
 */
export type SubmissionStatus = "describing"

export interface Submission {
  id: string
  reference: string
  status: SubmissionStatus
  customerEmail: string | null
  outcome: string
  audience: string
  doneDefinition: string
  constraints: string | null
  projectScope: string | null
  createdAt: string
}

export interface NewSubmissionInput {
  customerEmail: string | null
  outcome: string
  audience: string
  doneDefinition: string
  constraints: string | null
  projectScope: string | null
}

interface SubmissionRow {
  id: string
  reference: string
  status: string
  customer_email: string | null
  outcome: string
  audience: string
  done_definition: string
  constraints: string | null
  project_scope: string | null
  created_at: string
}

function fromRow(row: SubmissionRow): Submission {
  return {
    id: row.id,
    reference: row.reference,
    status: row.status as SubmissionStatus,
    customerEmail: row.customer_email,
    outcome: row.outcome,
    audience: row.audience,
    doneDefinition: row.done_definition,
    constraints: row.constraints,
    projectScope: row.project_scope,
    createdAt: row.created_at,
  }
}

/**
 * Inserts a new submission at `describing`. Ids and references are generated
 * here, not accepted from the caller — nothing about "which submission this
 * is" should ever be client-supplied.
 */
export async function createSubmission(
  env: Env,
  input: NewSubmissionInput,
): Promise<Submission> {
  const id = generateSubmissionId()
  const reference = generateSubmissionReference()
  const createdAt = new Date().toISOString()

  await env.DB.prepare(
    `INSERT INTO submissions
       (id, reference, status, customer_email, outcome, audience, done_definition, constraints, project_scope, created_at)
     VALUES (?, ?, 'describing', ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      reference,
      input.customerEmail,
      input.outcome,
      input.audience,
      input.doneDefinition,
      input.constraints,
      input.projectScope,
      createdAt,
    )
    .run()

  return {
    id,
    reference,
    status: "describing",
    customerEmail: input.customerEmail,
    outcome: input.outcome,
    audience: input.audience,
    doneDefinition: input.doneDefinition,
    constraints: input.constraints,
    projectScope: input.projectScope,
    createdAt,
  }
}

/** A durable lookup by row id — not tied to any session or request. */
export async function getSubmission(env: Env, id: string): Promise<Submission | null> {
  const row = await env.DB.prepare(`SELECT * FROM submissions WHERE id = ?`)
    .bind(id)
    .first<SubmissionRow>()
  return row ? fromRow(row) : null
}
