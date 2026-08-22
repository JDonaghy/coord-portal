import { appendEventStatement, type PayloadSubquery } from "./bridge/events"
import { getClientRecordByEmail } from "./clients"
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
  /**
   * A project id to attach at creation time, already known synchronously by
   * the caller — unlike `NewSubmissionInput.followUpFrom` (issue #109), whose
   * project id is resolved *inside* the same batch via a subquery because the
   * caller does not yet know it. Issue #129's lead promotion always does
   * know: the project is either an existing one the operator picked, or one
   * the same batch is about to insert with a candidate id minted in JS
   * beforehand (`promoteLead` in `src/leads.ts`) — so there is nothing to
   * look up. Ignored when `followUpFrom` is set; no caller sets both.
   */
  projectId?: string | null
  /**
   * The id of the `clients` row this submission's customer already belongs
   * to, or `null` for one nobody has matched to a client yet — issue #146's
   * `submission.created` client identity. An **id only**, never the client's
   * address: no email of any kind crosses the bridge (see the payload comment
   * in `createSubmissionStatements`).
   *
   * Only for a caller that can trust the id it already has in hand:
   * `createSubmission` below resolves it with a plain lookup of a row that
   * already existed *before* this transaction started, and `promoteLead`'s
   * matched-client branch (`src/leads.ts`) reads an existing row the same
   * way — neither is minting the row itself, so there is no race to resolve.
   * Mutually exclusive with `clientEmailToResolve` below; a caller sets
   * whichever one it actually has.
   */
  clientId?: string | null
  /**
   * Set instead of `clientId` by a caller whose own client-identity write is
   * itself racy and guarded — `promoteLead`'s no-match branch, whose
   * `clientCreationStatement` insert (`src/clients.ts`) can lose to a
   * concurrent promotion of a *different* lead sharing the same email (see
   * that statement's own doc comment: "two different leads sharing an email,
   * promoted at once"). A JS-generated candidate id is not safe to ship in
   * the event here the way `clientId` above is, so this instead resolves the
   * event's `client_id` via a live subquery on this email, inside the same
   * batch — the same trick `projectCreationForEmailResolvedClient`
   * (`src/projects.ts`) already uses to resolve `client_id` for the project
   * row it inserts alongside. See `PayloadSubquery` in `src/bridge/events.ts`.
   *
   * The email is a *lookup key* evaluated inside the database, bound to a
   * `WHERE` clause; the value spliced into the payload is the resolved `id`
   * and nothing else. The address itself never reaches the event.
   */
  clientEmailToResolve?: string
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
  let projectIdBindings: unknown[] = [options.projectId ?? null]
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

  // A follow-up's true `projectId` (freshly minted, or an existing one
  // reused) is resolved by the SQL above, not known synchronously here — it
  // only exists once the batch this statement is part of actually commits.
  // `createSubmission` below reads it back for exactly that reason, and
  // sends the daemon the same correction over the bridge (issue #146:
  // `submission.project_assigned`), because `null` is what this event ships
  // in the meantime. `options.projectId`, by contrast, *is* known
  // synchronously (see its own doc comment above) — this is the value the
  // row will carry once this transaction actually commits, and any caller
  // that needs it before then (`promoteLead` does not) can already trust it.
  const knownProjectId = followUpFrom ? null : (options.projectId ?? null)

  // `options.clientEmailToResolve` set means the caller's own client row may
  // not exist under the candidate id it has in hand yet — resolve the
  // event's client fields live, from whatever `clients` row actually exists
  // for this email once the batch commits, instead of trusting a guess. See
  // `CreateSubmissionOptions.clientEmailToResolve`'s own doc comment.
  const clientSubqueries: PayloadSubquery[] = options.clientEmailToResolve
    ? [
        {
          path: "$.client_id",
          expr: "SELECT id FROM clients WHERE lower(email) = lower(?)",
          bindings: [options.clientEmailToResolve],
        },
      ]
    : []

  const appendEvent = appendEventStatement(
    env,
    {
      type: "submission.created",
      submissionReference: reference,
      occurredAt: createdAt,
      /**
       * Everything the coordinator needs to start work, and nothing else.
       *
       * NO EMAIL ADDRESS OF ANY KIND CROSSES THIS BRIDGE. The customer's
       * email is deliberately absent: #14's emails are sent from this side,
       * so the fleet has no use for it, and a bridge that does not carry it
       * cannot leak it. The portal-internal URL id is absent for the
       * mirror-image reason — the daemon addresses submissions by reference.
       *
       * That rule covers the *client account's* address too, not just "who
       * filed this ask". An earlier round of issue #146 shipped a
       * `client_email` field here on the reasoning that a client account is a
       * different fact from a submission's filer; ms-2's contract (note 7,
       * issue #33: "coord never sees leads") disagrees, and it is the
       * authority — a promoted lead's contact address reaching the daemon is
       * exactly the leak that invariant exists to prevent, and on the paths
       * that populated the field it was in practice the same string as
       * `customerEmail`. Identity crosses as opaque ids only:
       *
       * - `client_id` — the `clients` row (`migrations/0016_clients.sql`),
       *   `null` and never invented when nobody has matched this customer to
       *   one yet.
       * - `project_id` — the `projects` row, which is what coord's
       *   approved-work panel actually keys `portal.project_repos` on.
       *
       * A human-readable label for either is the portal's to render, from its
       * own screens, where the customer's data already lives. If coord ever
       * needs to display a client, the answer is a display-name column on
       * `clients` that no customer's contact address flows into — not putting
       * the address on the wire.
       */
      payload: {
        reference,
        outcome: input.outcome,
        audience: input.audience,
        done_definition: input.doneDefinition,
        constraints: input.constraints,
        project_scope: input.projectScope,
        created_at: createdAt,
        client_id: options.clientId ?? null,
        project_id: knownProjectId,
      },
      payloadSubqueries: clientSubqueries.length > 0 ? clientSubqueries : undefined,
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
      projectId: knownProjectId,
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
  // A plain, read-only lookup — never a caller-supplied claim about who a
  // customer is (issue #146's `client_id`, same posture as every other
  // identity fact in this module). `null` for the ordinary, not-yet-a-client
  // customer; `createSubmissionStatements` renders that as absent rather than
  // inventing one. Only the row's `id` is ever handed on: its email stays on
  // this side of the bridge.
  const client = input.customerEmail ? await getClientRecordByEmail(env, input.customerEmail) : null
  // The follow-up target's *current* project, read before this transaction
  // starts — used only to decide, after the fact, whether the origin needs
  // telling it just gained a project (below). Never trusted for what this
  // new submission's own `project_id` will be: a concurrent follow-up from
  // the same origin could still win the mint inside the batch, which is
  // exactly why `createSubmissionStatements` never guesses either.
  const origin = input.followUpFrom ? await getSubmission(env, input.followUpFrom) : null

  const { submission, statements } = createSubmissionStatements(env, input, {
    clientId: client?.id ?? null,
  })
  await env.DB.batch(statements)
  // A follow-up's `projectId` is resolved by the batch above, not known to
  // `submission` yet (see the comment in `createSubmissionStatements`) — read
  // the row back rather than guess at what the guarded SQL decided. Skipped
  // for the ordinary case: it is not a follow-up, so `projectId` is already
  // correctly `null` and a second round trip would buy nothing.
  if (!input.followUpFrom) return submission

  const created = (await getSubmission(env, submission.id)) ?? submission

  // Issue #146: the `submission.created` event this batch just appended
  // necessarily shipped `project_id: null` for a follow-up — nothing in JS
  // knew, before the transaction committed, whether this submission would
  // reuse the origin's project or mint a fresh one (see
  // `projectAssignmentForFollowUp` in `src/projects.ts`). Tell the daemon the
  // truth now that it exists, in a `submission.project_assigned` event of its
  // own — necessarily a *separate* write from the fact it announces, since
  // the fact only became knowable once the first write had already landed.
  //
  // ── WHY THE SECOND BATCH IS AN ACCEPTED GAP, NOT AN OVERSIGHT ──────────────
  // This breaks, deliberately, the "one fact, one event, one transaction"
  // rule `appendEventStatement`'s own doc comment states — the true
  // `project_id` cannot be known before the first batch commits, so there is
  // no transaction that could carry both. If this second `DB.batch()` throws
  // (a transient D1 error, a worker eviction, a request abort) after the
  // first already committed, the real `project_id` is durably stored and
  // nothing ever announces it, and nothing here revisits it later — reviewed
  // and accepted for this issue rather than fixed, because closing it needs a
  // periodic reconciliation sweep (comparing `submissions.project_id` against
  // what the bridge stream has actually announced), which is out of scope
  // here and belongs with whoever owns the epic. This paragraph is that
  // explicit decision, not a silent gap.
  if (created.projectId) {
    // Ids only, exactly like `submission.created` above — see that event's
    // payload comment for why no address of any kind rides along.
    const clientFields = { client_id: client?.id ?? null }
    const corrections = [
      appendEventStatement(env, {
        type: "submission.project_assigned",
        submissionReference: created.reference,
        occurredAt: new Date().toISOString(),
        payload: { reference: created.reference, project_id: created.projectId, ...clientFields },
      }),
    ]
    // The origin only needs telling the *first* time a follow-up gives it a
    // project it did not already have — a submission's project is assigned
    // at most once and never cleared (`setSubmissionProject` only ever moves
    // it to another project, `src/projects.ts` never unsets it), so
    // `origin.projectId === null` (read before this request's own batch ran)
    // is true on exactly the one follow-up that first mints or attaches one.
    //
    // That pre-batch read is only a hint, not a lock: two follow-ups filed
    // against the same origin at nearly the same time can both read
    // `origin.projectId === null` and both reach this branch. The guard below
    // is what actually keeps the promise "exactly one correction" makes —
    // `NOT EXISTS` against `bridge_events` itself, checked at insert time, so
    // whichever of the two `DB.batch()` calls commits first wins and the
    // second's own insert matches zero rows, the same shape every other
    // guarded write in this codebase already uses for its own race.
    if (origin && origin.projectId === null) {
      corrections.push(
        appendEventStatement(
          env,
          {
            type: "submission.project_assigned",
            submissionReference: origin.reference,
            occurredAt: new Date().toISOString(),
            payload: { reference: origin.reference, project_id: created.projectId, ...clientFields },
          },
          {
            clause: `WHERE NOT EXISTS (
              SELECT 1 FROM bridge_events
               WHERE submission_id = ? AND type = 'submission.project_assigned'
            )`,
            bindings: [origin.reference],
          },
        ),
      )
    }
    await env.DB.batch(corrections)
  }

  return created
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
 * Every submission under one project, newest first — unscoped, for the
 * operator's own client/project screen (`routes/clients.ts`, issue #144).
 *
 * Deliberately not `listSubmissionsForProject` above: that function's
 * `customerEmail` scoping is the ownership check `/projects/:id` needs for
 * its customer caller, and this route has no single owning address to check
 * it against — the caller is an operator reading a client's *own* project
 * list, the same posture `getNewestSubmissionForProject` below already takes
 * for `routes/leads.ts`'s reassignment panel. See that function's doc
 * comment for the fuller rationale.
 */
export async function listSubmissionsForProjectUnscoped(
  env: Env,
  projectId: string,
): Promise<Submission[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM submissions WHERE project_id = ? ORDER BY created_at DESC, rowid DESC`,
  )
    .bind(projectId)
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
 *
 * Batches the update with a `submission.project_assigned` event (issue #146)
 * — unlike the follow-up correction in `createSubmission` above, the new
 * value is already known here before any write happens, so there is no
 * reason to give up the same-transaction guarantee every other fact/event
 * pair in this codebase gets. `submission` takes `id` and `reference` (not a
 * bare id) because the event, like every bridge event, is addressed by the
 * customer-visible reference, not the row id the caller already has handy.
 * `clientId` is passed in rather than looked up here because the caller
 * (`postLeadReassign`) already knows it from its own reassignment context —
 * a second lookup would just be a slower way to get the same answer. An id
 * and nothing else: no email crosses the bridge on this event any more than
 * on `submission.created` (see that payload's comment above).
 */
export async function setSubmissionProject(
  env: Env,
  submission: { id: string; reference: string },
  projectId: string,
  clientId: string | null,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`UPDATE submissions SET project_id = ? WHERE id = ?`).bind(
      projectId,
      submission.id,
    ),
    appendEventStatement(env, {
      type: "submission.project_assigned",
      submissionReference: submission.reference,
      occurredAt: new Date().toISOString(),
      payload: {
        reference: submission.reference,
        project_id: projectId,
        client_id: clientId,
      },
    }),
  ])
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
