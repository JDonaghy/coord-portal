import { appendEventStatement } from "./bridge/events"
import { generateSubmissionId, generateSubmissionReference } from "./ids"
import { projectAssignmentForFollowUp } from "./projects"
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

/** Every slug, in the contract's pinned order. */
export const SUBMISSION_STATUSES = Object.keys(
  SUBMISSION_STATUS_TEXT,
) as SubmissionStatus[]

export function isSubmissionStatus(value: unknown): value is SubmissionStatus {
  return typeof value === "string" && value in SUBMISSION_STATUS_TEXT
}

export function statusText(status: SubmissionStatus): string {
  return SUBMISSION_STATUS_TEXT[status]
}

/**
 * "Only `Awaiting your sign-off` and `Needs your input` are customer-actionable"
 * (Gate-A contract, § Customer status vocabulary). Everything else is a
 * read-only status report.
 */
const ACTIONABLE_STATUSES = new Set<SubmissionStatus>(["awaiting-signoff", "needs-input"])

export function isActionableStatus(status: SubmissionStatus): boolean {
  return ACTIONABLE_STATUSES.has(status)
}

/** "Only `Shipped` is terminal" (same table). */
export function isTerminalStatus(status: SubmissionStatus): boolean {
  return status === "shipped"
}

/**
 * The four non-actionable, non-terminal states that "share one read-only
 * template" per the contract's note on `04-submission-in-design.html`:
 * request-changes reviews, merge conflicts and CI churn stay hidden inside
 * these while the daemon works.
 */
export const ROLLUP_STATUSES: SubmissionStatus[] = [
  "in-design",
  "planned",
  "in-progress",
  "quality-check",
]

export function isRollupStatus(status: SubmissionStatus): boolean {
  return (ROLLUP_STATUSES as SubmissionStatus[]).includes(status)
}

/**
 * Issue #74 (Gate-A amendment, contract note 1, approved 2026-08-14): "does
 * On hold surface to customers at all?" is resolved — it does not. A
 * submission the fleet has paused draws through the exact rollup template
 * pinned for `in-progress`, byte-for-byte, not a lookalike template of its
 * own.
 *
 * `on-hold` stays a real stored status and a valid bridge-push target — see
 * `SUBMISSION_STATUS_TEXT` above, still a closed set the bridge validates
 * against. Only what a customer is ever shown collapses, and it collapses
 * here, once, so every customer-visible surface (the detail screen, the
 * dashboard) shares the one mapping instead of each carrying its own copy of
 * it.
 */
export function customerFacingStatus(status: SubmissionStatus): SubmissionStatus {
  return status === "on-hold" ? "in-progress" : status
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
  /**
   * The `proj_…` id of the project this submission belongs to, or `null` for
   * a one-off request with no shared history (issue #109). See
   * `src/projects.ts` and `NewSubmissionInput.followUpFrom` below for the
   * only way this is ever set — never inferred from a matching
   * `customerEmail` alone.
   */
  projectId: string | null
  /**
   * The PR's live Cloudflare Pages preview build, or `null` until the
   * operator queues one — issue #107's pre-merge approval gate. Coord-owned,
   * pushed alongside `status: 'quality-check'` and written to this column
   * directly (see `migrations/0015_preview_reviews.sql`, `src/bridge/updates.ts`).
   * A single current value, not a version history — "the PR itself is the
   * history" (design doc). See `src/previewReviews.ts` for the customer's
   * verdict on it.
   */
  previewUrl: string | null
}

export interface NewSubmissionInput {
  customerEmail: string | null
  outcome: string
  audience: string
  doneDefinition: string
  constraints: string | null
  projectScope: string | null
  /**
   * The `sub_…` id of an existing submission this one is a follow-up to, or
   * `null`/omitted for an ordinary, standalone request.
   *
   * This is the one deliberate trigger issue #109 picks for "where a project
   * gets created vs. attached to an existing one" — see the long comment on
   * `promoteLead` in `src/leads.ts` for why lead promotion is deliberately
   * *not* the other one, and `routes/submission.ts`'s "Start a follow-up"
   * link for the only UI path that ever sets this. The caller must already
   * have checked `isOwnedBy` against this id — `createSubmissionStatements`
   * trusts it as given, the same way it trusts every other field here.
   */
  followUpFrom?: string | null
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
  project_id: string | null
  preview_url: string | null
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
    projectId: row.project_id,
    previewUrl: row.preview_url,
  }
}

/**
 * A `FROM … WHERE …` tail appended to the two statements below, so a caller can
 * make creating a submission conditional on some other row's state *inside the
 * same transaction* — see `promoteLead` in `src/leads.ts`, which uses it to make
 * a second promote of the same lead a no-op rather than a second submission.
 *
 * A SQL fragment rather than a value because the condition is about a row this
 * module knows nothing about. It is never built from request input: the only
 * caller passes a literal string and binds its parameters, same as everywhere
 * else here.
 */
export interface CreateGuard {
  /** e.g. `FROM leads WHERE leads.id = ? AND leads.promoted_at IS NULL` */
  clause: string
  bindings: unknown[]
}

export interface CreateSubmissionOptions {
  /**
   * Pre-minted identifiers, for a caller that must record where a submission
   * *will* live in the same transaction that creates it. Still portal-minted
   * (`src/ids.ts`) and still never client-supplied — the rule is that nothing
   * about "which submission this is" comes off the wire, not that only this
   * function may call the generator.
   */
  id?: string
  reference?: string
  guard?: CreateGuard
}

/**
 * The statements that create one submission at `describing` and the
 * `submission.created` event that tells the coordinator about it — returned
 * rather than executed, so a caller can put them in a batch alongside its own
 * writes. `createSubmission` below is the ordinary "just do it" wrapper.
 *
 * Every submission this portal has ever created goes through here, which is
 * what makes issue #33's "promotion must produce exactly the same event shape,
 * from the daemon's point of view, as if the customer had filled out /intake
 * directly" true by construction rather than by two code paths agreeing.
 */
export function createSubmissionStatements(
  env: Env,
  input: NewSubmissionInput,
  options: CreateSubmissionOptions = {},
): { submission: Submission; statements: D1PreparedStatement[] } {
  const id = options.id ?? generateSubmissionId()
  const reference = options.reference ?? generateSubmissionReference()
  const createdAt = new Date().toISOString()
  const guard = options.guard
  const followUpFrom = input.followUpFrom ?? null

  // Issue #109: a follow-up submission carries its `project_id` too, minted
  // (or reused) by `projectAssignmentForFollowUp`. With no follow-up target
  // the column is a plain bound `NULL` — a fresh, one-off submission, exactly
  // today's shape.
  const projectStatements: D1PreparedStatement[] = []
  let projectIdExpr = "?"
  let projectIdBindings: unknown[] = [null]
  if (followUpFrom) {
    const assignment = projectAssignmentForFollowUp(env, input.customerEmail, followUpFrom, createdAt)
    projectStatements.push(...assignment.statements)
    projectIdExpr = assignment.projectIdExpr
    projectIdBindings = assignment.projectIdBindings
  }

  // `INSERT … SELECT` rather than `INSERT … VALUES` so the guarded and
  // unguarded forms are one statement with one column list, not two that can
  // drift apart. With no guard the SELECT has no FROM and yields exactly one
  // row, which is what VALUES did.
  const insertSubmission = env.DB.prepare(
    `INSERT INTO submissions
       (id, reference, status, customer_email, outcome, audience, done_definition, constraints, project_scope, project_id, created_at)
     SELECT ?, ?, 'describing', ?, ?, ?, ?, ?, ?, ${projectIdExpr}, ?
     ${guard ? guard.clause : ""}`,
  ).bind(
    id,
    reference,
    input.customerEmail,
    input.outcome,
    input.audience,
    input.doneDefinition,
    input.constraints,
    input.projectScope,
    ...projectIdBindings,
    createdAt,
    ...(guard ? guard.bindings : []),
  )

  const appendEvent = appendEventStatement(
    env,
    {
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
    },
    guard,
  )

  return {
    submission: {
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
      // Resolved by SQL above, not known synchronously here — a follow-up's
      // true `projectId` (freshly minted, or an existing one reused) only
      // exists once the batch this statement is part of actually commits.
      // `createSubmission` below reads it back for exactly that reason;
      // any other caller building its own batch (`promoteLead`) should do the
      // same if it ever needs this field.
      projectId: null,
      // No preview build exists yet for a submission that was just created —
      // `preview_url` only ever arrives later, over the bridge (issue #107).
      previewUrl: null,
    },
    statements: [...projectStatements, insertSubmission, appendEvent],
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
  const { submission, statements } = createSubmissionStatements(env, input)
  await env.DB.batch(statements)
  // A follow-up's `projectId` is resolved by the batch above, not known to
  // `submission` yet (see the comment in `createSubmissionStatements`) — read
  // the row back rather than guess at what the guarded SQL decided. Skipped
  // for the ordinary case: it is not a follow-up, so `projectId` is already
  // correctly `null` and a second round trip would buy nothing.
  if (input.followUpFrom) {
    return (await getSubmission(env, submission.id)) ?? submission
  }
  return submission
}

/** A durable lookup by row id — not tied to any session or request. */
export async function getSubmission(env: Env, id: string): Promise<Submission | null> {
  const row = await env.DB.prepare(`SELECT * FROM submissions WHERE id = ?`)
    .bind(id)
    .first<SubmissionRow>()
  return row ? fromRow(row) : null
}

/**
 * All submissions belonging to one customer, newest first.
 *
 * This is the query behind `GET /submissions` — issue #12's "a customer can
 * only ever see their own submissions" — so it takes an email, never an
 * optional one. There is no "list everything" caller in this module; a route
 * with no verified-enough identity has nothing to bind here and must not call
 * this with a borrowed or guessed address.
 */
export async function listSubmissionsForCustomer(
  env: Env,
  customerEmail: string,
): Promise<Submission[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM submissions WHERE customer_email = ? ORDER BY created_at DESC`,
  )
    .bind(customerEmail)
    .all<SubmissionRow>()
  return (results ?? []).map(fromRow)
}

/**
 * Every submission under one project, newest first — issue #109's combined
 * timeline, the counterpart to `listSubmissionsForCustomer` at the project
 * level.
 *
 * Scoped by `customerEmail` for the identical reason that function is: this
 * is read by an authenticated route (`routes/project.ts`) that must never
 * render another customer's history, so ownership is a `WHERE` clause here,
 * not a filter applied after the fact. A project's own `customerEmail`
 * (`src/projects.ts`) is who it belongs to; every submission under it was
 * only ever attached by that same customer's own follow-up action, so the two
 * always agree — this redundant check costs one query parameter and closes
 * off a row ever rendering to the wrong caller if that invariant is ever
 * broken by a future write path.
 */
export async function listSubmissionsForProject(
  env: Env,
  projectId: string,
  customerEmail: string,
): Promise<Submission[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM submissions WHERE project_id = ? AND customer_email = ? ORDER BY created_at DESC`,
  )
    .bind(projectId, customerEmail)
    .all<SubmissionRow>()
  return (results ?? []).map(fromRow)
}

/**
 * The most recently created submission under one project, or `null` for a
 * project with none — issue #130's `projectTitle` (`routes/leads.ts`) uses
 * this to derive a display name for a project the way `titleOf` already
 * derives one for a submission (see the contract's "Project 1" section:
 * "everything it shows is derived from the submissions under it").
 *
 * Unscoped by `customerEmail`, unlike `listSubmissionsForProject`: the caller
 * here is an operator reading a client's own project list on `/leads/:id`,
 * not a customer's own `/projects/:id` — there is no single owning address
 * to check it against the way that route's ownership scoping requires.
 */
export async function getNewestSubmissionForProject(
  env: Env,
  projectId: string,
): Promise<Submission | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM submissions WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  )
    .bind(projectId)
    .first<SubmissionRow>()
  return row ? fromRow(row) : null
}

/**
 * Moves a submission to a different project — issue #130, "reassign a
 * submission to a different (or new) project". Unconditional: unlike
 * `createSubmissionStatements`'s guarded writes (a submission is only ever
 * *created* once), a promoted submission can be reassigned any number of
 * times, "not just at promotion time" (#130's own wording), so there is no
 * `WHERE project_id IS NULL` here — the whole point is overwriting a project
 * it is already in.
 *
 * The caller (`routes/leads.ts`) is responsible for checking that
 * `projectId` belongs to the same client as the submission's current
 * project — this function trusts the id it is given, the same way every
 * other write in this module trusts a caller that has already done its own
 * scoping (see `NewSubmissionInput.followUpFrom`'s doc comment).
 */
export async function setSubmissionProject(
  env: Env,
  submissionId: string,
  projectId: string,
): Promise<void> {
  await env.DB.prepare(`UPDATE submissions SET project_id = ? WHERE id = ?`)
    .bind(projectId, submissionId)
    .run()
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

/**
 * The intake form collects an outcome, not a title (contract note 3: no
 * portal-internal field schema is pinned). The first line of the outcome text
 * is close enough to a title for a list row or a detail heading, truncated so
 * one very long paragraph cannot blow out the layout.
 *
 * Shared by the dashboard rows and the submission detail screens so the same
 * submission reads with the same title everywhere.
 */
export function titleOf(submission: Submission): string {
  const firstLine = submission.outcome.split("\n")[0]?.trim() || submission.outcome
  return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine
}

/** A coord-owned fact together with the revision it was last pushed at. */
export interface CoordFact {
  value: unknown
  revision: number
}

/**
 * One coord-owned fact this milestone has no dedicated column for (issue #10:
 * `onhold_since`; #10/#13/#11 also read `question`, `design_round`,
 * `decomposition`, `artifacts` here as they build out their own screens) —
 * see `migrations/0003_sync_bridge.sql` and `src/bridge/updates.ts`, which is
 * the only writer.
 *
 * Returns the parsed value and the `coord_facts.revision` it was pushed at, or
 * `null` if the daemon has never pushed this field for this submission. The
 * revision is what lets a caller (issue #11's question channel) tell "the
 * daemon pushed a new value for this field" apart from "nothing changed" —
 * `getCoordFact` below throws it away for callers that only ever care about
 * the latest value.
 */
export async function getCoordFactRecord(
  env: Env,
  submissionReference: string,
  field: string,
): Promise<CoordFact | null> {
  const row = await env.DB.prepare(
    `SELECT value, revision FROM coord_facts WHERE submission_id = ? AND field = ?`,
  )
    .bind(submissionReference, field)
    .first<{ value: string; revision: number }>()
  if (!row) return null
  try {
    return { value: JSON.parse(row.value), revision: row.revision }
  } catch {
    return { value: null, revision: row.revision }
  }
}

/**
 * As `getCoordFactRecord`, but just the value — for the (more common) callers
 * that only ever render the latest push and have no use for its revision.
 *
 * A value of JSON `null` (explicitly pushed) and "no row at all" both read
 * back as `null` here — this milestone's screens have no need to tell them
 * apart yet.
 */
export async function getCoordFact(
  env: Env,
  submissionReference: string,
  field: string,
): Promise<unknown> {
  const record = await getCoordFactRecord(env, submissionReference, field)
  return record ? record.value : null
}
