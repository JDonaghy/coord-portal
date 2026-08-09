import { appendEventStatement } from "./bridge/events"
import { generateSubmissionId, generateSubmissionReference } from "./ids"
import type { Env } from "./types"

/**
 * The record model issue #8 carries forward — see `migrations/0002_submissions.sql`
 * and `migrations/0003_sync_bridge.sql`.
 *
 * A submission is created once, at `describing`, by the customer. It moves
 * through the rest of the vocabulary only when the coordinator says so, over
 * the sync bridge (#15) — `status` is coord-owned, and there is no portal code
 * path that writes it.
 */

/**
 * The pinned customer status vocabulary (Gate-A contract, from issue #10).
 * Fixed and ordered; slug → the exact customer-visible text.
 *
 * This is a closed set on purpose: it is also the validation the bridge applies
 * to an inbound `status`, so a daemon typo lands as a `rejected` outcome rather
 * than as a submission stuck in a state no screen can render.
 */
export const SUBMISSION_STATUS_TEXT = {
  describing: "Describing",
  "in-design": "In design",
  "awaiting-signoff": "Awaiting your sign-off",
  planned: "Planned",
  "in-progress": "In progress",
  "quality-check": "Quality check",
  "needs-input": "Needs your input",
  "on-hold": "On hold",
  shipped: "Shipped",
} as const

export type SubmissionStatus = keyof typeof SUBMISSION_STATUS_TEXT

export function isSubmissionStatus(value: unknown): value is SubmissionStatus {
  return typeof value === "string" && value in SUBMISSION_STATUS_TEXT
}

export function statusText(status: SubmissionStatus): string {
  return SUBMISSION_STATUS_TEXT[status]
}

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
  /**
   * The highest revision the coordinator has successfully pushed for this
   * submission, or `null` if it never has. The idempotency watermark — see
   * `src/bridge/updates.ts`.
   */
  coordRevision: number | null
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
  coord_revision: number | null
}

function fromRow(row: SubmissionRow): Submission {
  return {
    id: row.id,
    reference: row.reference,
    // A stored status outside the vocabulary can only come from a hand-edited
    // row (the bridge validates on write). Render the first state rather than a
    // blank pill: the screen stays readable and the row stays inspectable.
    status: isSubmissionStatus(row.status) ? row.status : "describing",
    customerEmail: row.customer_email,
    outcome: row.outcome,
    audience: row.audience,
    doneDefinition: row.done_definition,
    constraints: row.constraints,
    projectScope: row.project_scope,
    createdAt: row.created_at,
    coordRevision: row.coord_revision,
  }
}

/**
 * Inserts a new submission at `describing`, and the `submission.created` event
 * that tells the coordinator about it — in one `DB.batch()`, which D1 runs as a
 * single transaction.
 *
 * The batch is the point. A submission stored without its event is a request
 * the fleet never hears about; an event stored without its submission is work
 * proposed against a row that does not exist. The customer pressed the button
 * once, so exactly one of "both" or "neither" is an acceptable outcome.
 *
 * Ids and references are generated here, not accepted from the caller —
 * nothing about "which submission this is" should ever be client-supplied.
 */
export async function createSubmission(
  env: Env,
  input: NewSubmissionInput,
): Promise<Submission> {
  const id = generateSubmissionId()
  const reference = generateSubmissionReference()
  const createdAt = new Date().toISOString()

  const insertSubmission = env.DB.prepare(
    `INSERT INTO submissions
       (id, reference, status, customer_email, outcome, audience, done_definition, constraints, project_scope, created_at)
     VALUES (?, ?, 'describing', ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
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

  await env.DB.batch([
    insertSubmission,
    appendEventStatement(env, {
      type: "submission.created",
      submissionReference: reference,
      occurredAt: createdAt,
      /**
       * Everything the coordinator needs to start work, and nothing else.
       *
       * The customer's email is deliberately absent: #14's emails are sent from
       * this side, so the fleet has no use for it, and a bridge that does not
       * carry it cannot leak it. The portal-internal URL id is absent for the
       * mirror-image reason — the daemon addresses submissions by reference.
       */
      payload: {
        reference,
        outcome: input.outcome,
        audience: input.audience,
        done_definition: input.doneDefinition,
        constraints: input.constraints,
        project_scope: input.projectScope,
        created_at: createdAt,
      },
    }),
  ])

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
    coordRevision: null,
  }
}

/** A durable lookup by row id — not tied to any session or request. */
export async function getSubmission(env: Env, id: string): Promise<Submission | null> {
  const row = await env.DB.prepare(`SELECT * FROM submissions WHERE id = ?`)
    .bind(id)
    .first<SubmissionRow>()
  return row ? fromRow(row) : null
}

/**
 * Lookup by the customer-visible `SUB-XXXXXX` reference — the identifier the
 * sync bridge addresses submissions by.
 */
export async function getSubmissionByReference(
  env: Env,
  reference: string,
): Promise<Submission | null> {
  const row = await env.DB.prepare(`SELECT * FROM submissions WHERE reference = ?`)
    .bind(reference)
    .first<SubmissionRow>()
  return row ? fromRow(row) : null
}
