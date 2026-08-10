import { readAccessIdentity } from "../identity"
import { escapeHtml, html, page, topbar } from "../render"
import { derivedStatus, loadSignoffStates } from "../rounds"
import {
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
 */
export async function submissionsDashboard(request: Request, env: Env): Promise<Response> {
  const identity = readAccessIdentity(request)
  const submissions = identity.email
    ? await listSubmissionsForCustomer(env, identity.email)
    : []

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
  const rows = submissions.map((submission) => ({
    submission,
    display: derivedStatus(submission.status, states.get(submission.reference) ?? null),
  }))

  return html(page("My requests — coord-portal", dashboard(identity.email, rows)))
}

interface DashboardRow {
  submission: Submission
  display: SubmissionStatus
}

function dashboard(email: string | null, rows: DashboardRow[]): string {
  return `${topbar(email, "dashboard")}
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
${rows.map(row).join("\n")}
  </ul>`
}

function row({ submission, display }: DashboardRow): string {
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

function empty(): string {
  return `<p class="lede" data-testid="submission-list-empty">
    Nothing here yet — <a href="/intake">send your first request</a> to the team.
  </p>`
}
