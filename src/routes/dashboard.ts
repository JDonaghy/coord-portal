import { readAccessIdentity } from "../identity"
import { escapeHtml, html, page, topbar } from "../render"
import { listSubmissionsForCustomer, statusText, titleOf, type Submission } from "../submissions"
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

  return html(page("My requests — coord-portal", dashboard(identity.email, submissions)))
}

function dashboard(email: string | null, submissions: Submission[]): string {
  return `${topbar(email, "dashboard")}
<main>
  <div class="page-head">
    <h1>My requests</h1>
    <a class="button primary" href="/intake" data-testid="nav-new-cta">New request</a>
  </div>
  ${submissions.length > 0 ? list(submissions) : empty()}
</main>`
}

function list(submissions: Submission[]): string {
  const rows = submissions.map(row).join("\n")
  return `<ul class="submission-list" data-testid="submission-list">
${rows}
  </ul>`
}

function row(submission: Submission): string {
  const title = titleOf(submission)
  return `    <li>
      <a class="submission-row" data-testid="submission-row" data-status="${escapeHtml(submission.status)}"
         href="/submissions/${submission.id}">
        <div class="row-main">
          <span class="title">${escapeHtml(title)}</span>
          <span class="meta">${submission.reference} &middot; ${escapeHtml(submission.createdAt)}</span>
        </div>
        <span class="status-pill" data-testid="status-pill" data-status="${escapeHtml(submission.status)}">${escapeHtml(statusText(submission.status))}</span>
      </a>
    </li>`
}

function empty(): string {
  return `<p class="lede" data-testid="submission-list-empty">
    Nothing here yet — <a href="/intake">send your first request</a> to the team.
  </p>`
}
