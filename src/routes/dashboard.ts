import { isBehindCloudflareEdge } from "../deployment"
import { accessRefused, resolveSiteIdentity } from "../identity"
import { readOperator } from "../operators"
import { escapeHtml, html, page, topbar } from "../render"
import { derivedStatus, loadSignoffStates } from "../rounds"
import { derivedStartWorkStatus, loadStartWorkStates } from "../startWork"
import {
  customerFacingStatus,
  listSubmissionsForCustomer,
  statusText,
  titleOf,
  type Submission,
  type SubmissionStatus,
} from "../submissions"
import type { Env } from "../types"

/**
 * GET /submissions
 *
 * "The signed-in customer's own submissions, and only their own" (Gate-A
 * contract, issue #12). Scoping is the whole point of this route: it is a
 * query bound to the caller's Access identity, never a parameter the request
 * gets to name. See the contract's note 4 and the query-widening probes in
 * the sealed acceptance slice — no `?email=`, `?all=1`, etc. is ever read.
 *
 * The identity itself comes from `resolveSiteIdentity` (#1981), not
 * `readAccessIdentity`: this route returns customer-specific data, so the
 * email it scopes by is verified behind Cloudflare's edge, not merely
 * whatever an unverified `Cf-Access-Jwt-Assertion` claims.
 */
export async function submissionsDashboard(request: Request, env: Env): Promise<Response> {
  const email = await resolveSiteIdentity(request, env)
  if (!email && isBehindCloudflareEdge(request)) return accessRefused()

  const submissions = email ? await listSubmissionsForCustomer(env, email) : []

  // The same derived status the detail screen shows (`src/rounds.ts`), so a
  // request the customer has just sent back for changes does not sit on this
  // list still claiming to be waiting on them. One query for every row, not one
  // per row — see `loadSignoffStates`.
  const states = await loadSignoffStates(
    env,
    submissions
      .filter((submission) => submission.status === "awaiting-signoff")
      .map((submission) => submission.reference),
  )
  // Issue #132's operator override — same batched-lookup shape as
  // `loadSignoffStates` just above, scoped to the one stored status
  // (`describing`) whose truth can depend on it. See `src/startWork.ts`.
  const startWorkStates = await loadStartWorkStates(
    env,
    submissions
      .filter((submission) => submission.status === "describing")
      .map((submission) => submission.reference),
  )
  // `customerFacingStatus` applies issue #74's `on-hold` -> `in-progress`
  // collapse — the same mapping `detailFor` in `src/routes/submission.ts`
  // applies to the detail screen, so a row on this list and its own detail
  // screen never disagree about what the customer is shown.
  const displayOf = (submission: Submission): SubmissionStatus =>
    customerFacingStatus(
      derivedStartWorkStatus(
        derivedStatus(submission.status, states.get(submission.reference) ?? null),
        startWorkStates.get(submission.reference) ?? null,
      ),
    )

  const rows = groupByProject(submissions, displayOf)

  // Additive to the ownership scoping above, never a substitute for it: this
  // decides only whether the nav's operator section (Leads, Deliveries)
  // appears, the same `readOperator` gate `/leads` and `/deliveries`
  // themselves apply — see issue #103 and `src/render.ts`'s `topbar()`.
  const isOperator = (await readOperator(request, env)) !== null

  return html(page("My requests — coord-portal", dashboard(email, isOperator, rows)))
}

/**
 * One line on `/submissions` — either a one-off submission (today's shape,
 * unchanged) or a project standing in for every submission under it (issue
 * #109). `submissions` is already newest-first
 * (`listSubmissionsForCustomer`); this groups it without re-sorting, which is
 * what keeps a customer with no projects seeing the exact list they always
 * have — "no regression for one-off customers" is a property of this
 * function touching nothing about their rows, not a special case inside it.
 */
type DashboardRow =
  | { kind: "submission"; submission: Submission; display: SubmissionStatus }
  | { kind: "project"; projectId: string; submissions: Submission[]; display: SubmissionStatus }

/**
 * Folds a customer's flat submission list into dashboard rows: a submission
 * with no `projectId` renders exactly as it always has, and every submission
 * sharing a `projectId` collapses into one row, keyed to the newest member —
 * the input's own ordering already puts that member first, so this is a
 * single pass, not a re-sort — UNLESS a `projectId` turns out to have exactly
 * one member, which renders as an ordinary submission row instead (see below
 * for why that carve-out exists and is safe).
 *
 * ── WHY A LONE MEMBER DOES NOT BECOME A PROJECT ROW (ISSUE #129) ───────────
 * Before issue #129 (`claude-coordinator` epic #122's client-linking work,
 * `coord-portal`'s own `src/leads.ts`), the only way a submission ever
 * carried a `projectId` at all was `NewSubmissionInput.followUpFrom` (#109) —
 * and that path *always* produces at least two members, atomically: minting
 * the project and stamping the follow-up's own `project_id` happen in the
 * same `DB.batch()` as stamping the *origin* submission with it too
 * (`projectAssignmentForFollowUp`, `src/projects.ts`). A `project_id` with
 * only one submission behind it was therefore never an observable state —
 * grouping unconditionally on any `projectId` was equivalent to grouping on
 * "two or more", so this carve-out was invisible before #129.
 *
 * #129 changes that: lead promotion (`promoteLead`, `src/leads.ts`) now
 * attaches every promoted submission to a client-linked project immediately,
 * including a brand-new client's very first one — so a customer with exactly
 * one submission, freshly promoted from a lead, now legitimately has a
 * `projectId` pointing at a project with exactly one member. Rendering that
 * as a `project-row` (a distinct `data-testid` from `submission-row`, see
 * `projectRow` below) is a real, user-visible regression against
 * `tests/acceptance/ms-2/33-lead-triage-promotion.spec.ts` (sealed, never
 * reopened): three of its assertions expect exactly one `submission-row` for
 * a lead that has been promoted and nothing else, a promise this module made
 * long before #129 existed and #129's own contract never asked to relax.
 *
 * Collapsing only at two-or-more members keeps that promise for every case
 * this module has ever been asked to handle — including #109's own,
 * unchanged by construction — and gives #129's new one-submission-per-project
 * case the identical rendering a project-less submission has always had, for
 * exactly as long as it stays a party of one. The moment a second submission
 * lands in the same project (a reassignment, `#130`, or a genuine follow-up),
 * it becomes a `project-row` the same way it always would have.
 */
function groupByProject(
  submissions: Submission[],
  displayOf: (submission: Submission) => SubmissionStatus,
): DashboardRow[] {
  const rows: DashboardRow[] = []
  const groups = new Map<string, DashboardRow & { kind: "project" }>()

  for (const submission of submissions) {
    if (!submission.projectId) {
      rows.push({ kind: "submission", submission, display: displayOf(submission) })
      continue
    }
    const existing = groups.get(submission.projectId)
    if (existing) {
      existing.submissions.push(submission)
      continue
    }
    // First (newest) sighting of this project — its row's position and
    // display status come from this submission, the current state of the
    // relationship. Reclassified below if it turns out to be the only one.
    const group: DashboardRow & { kind: "project" } = {
      kind: "project",
      projectId: submission.projectId,
      submissions: [submission],
      display: displayOf(submission),
    }
    groups.set(submission.projectId, group)
    rows.push(group)
  }

  return rows.map((row) =>
    row.kind === "project" && row.submissions.length === 1
      ? { kind: "submission", submission: row.submissions[0]!, display: row.display }
      : row,
  )
}

function dashboard(email: string | null, isOperator: boolean, rows: DashboardRow[]): string {
  return `${topbar(email, "dashboard", isOperator)}
<main>
  <div class="page-head">
    <h1>My requests</h1>
    <a class="button primary" href="/intake" data-testid="nav-new-cta">New request</a>
  </div>
  ${rows.length > 0 ? list(rows) : empty()}
</main>`
}

function list(rows: DashboardRow[]): string {
  return `<ul class="submission-list" data-testid="submission-list">
${rows.map((entry) => (entry.kind === "project" ? projectRow(entry) : submissionRow(entry))).join("\n")}
  </ul>`
}

function submissionRow({
  submission,
  display,
}: DashboardRow & { kind: "submission" }): string {
  const title = titleOf(submission)
  return `    <li>
      <a class="submission-row" data-testid="submission-row" data-status="${escapeHtml(display)}"
         href="/submissions/${submission.id}">
        <div class="row-main">
          <span class="title">${escapeHtml(title)}</span>
          <span class="meta">${submission.reference} &middot; ${escapeHtml(submission.createdAt)}</span>
        </div>
        <span class="status-pill" data-testid="status-pill" data-status="${escapeHtml(display)}">${escapeHtml(statusText(display))}</span>
      </a>
    </li>`
}

/**
 * A project's row — same visual shape as `submissionRow` (`.submission-row`
 * carries both), a distinct `data-testid` so the two are never confused by a
 * locator, and a link into `/projects/:id` (issue #109's combined view)
 * rather than any one submission's own detail screen: the point of grouping
 * is that the customer should not have to know which submission covers which
 * round.
 *
 * `submissions[0]` is the newest member — `groupByProject` guarantees that —
 * so its title stands in for the project's ("what this is currently about")
 * and its reference anchors the meta line the same way a standalone row's
 * does. The count makes the grouping itself legible instead of a customer
 * wondering why one row's reference does not match what they remember
 * submitting.
 */
function projectRow({ projectId, submissions, display }: DashboardRow & { kind: "project" }): string {
  const newest = submissions[0]
  if (!newest) return ""
  const title = titleOf(newest)
  const requestCount = submissions.length
  const countLabel = requestCount === 1 ? "1 request" : `${requestCount} requests`
  return `    <li>
      <a class="submission-row" data-testid="project-row" data-status="${escapeHtml(display)}"
         href="/projects/${projectId}">
        <div class="row-main">
          <span class="title">${escapeHtml(title)}</span>
          <span class="meta">${countLabel} &middot; ${newest.reference} &middot; ${escapeHtml(newest.createdAt)}</span>
        </div>
        <span class="status-pill" data-testid="status-pill" data-status="${escapeHtml(display)}">${escapeHtml(statusText(display))}</span>
      </a>
    </li>`
}

function empty(): string {
  return `<p class="lede" data-testid="submission-list-empty">
    Nothing here yet — <a href="/intake">send your first request</a> to the team.
  </p>`
}
