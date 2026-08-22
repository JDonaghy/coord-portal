import { readOperator, type Operator } from "../operators"
import { escapeHtml, html, operatorTopbar, page } from "../render"
import { derivedStatus, loadSignoffStates, VERDICT_TEXT, type SignoffState } from "../rounds"
import { derivedStartWorkStatus, loadStartWorkStates } from "../startWork"
import {
  customerFacingStatus,
  isSubmissionStatus,
  statusText,
  type SubmissionStatus,
} from "../submissions"
import type { Env } from "../types"
import { leadsNotFound } from "./leads"

/**
 * `GET /requests` — issue #104, the operator's counterpart to `/submissions`.
 *
 * #104's own motivating line: an operator can already see every lead
 * (`/leads`, #33) and every delivery (`/deliveries`, #55), but `/submissions`
 * (`routes/dashboard.ts`) is ownership-scoped to `customer_email = ` the
 * caller's own Access identity, by design since #12. The moment an operator
 * promotes a lead, the submission it just created becomes invisible to the
 * operator who created it — there is no operator-scoped equivalent, and the
 * only way to answer "what state is that customer's request in" is to query
 * D1 directly.
 *
 * ── WHY THIS IS A NEW ROUTE, NOT A BRANCH INSIDE `/submissions` ───────────
 * #104 is explicit: "`/submissions` and `/submissions/:id` are the customer's
 * screens, and their ownership check is load-bearing — the sealed suite pins
 * 'one customer cannot open another customer's submission by URL' and 'no
 * query parameter widens the dashboard past the caller'
 * (`ms-1/12-access-auth.spec.ts`). Widening those routes for operators would
 * be changing exactly the assertion that keeps customers apart. Do not add an
 * operator branch inside them." So this file never imports
 * `listSubmissionsForCustomer` and never touches `routes/dashboard.ts`; it is
 * its own query, its own route, its own template — the exact shape
 * `routes/deliveries.ts` already established against `routes/outbox.ts` (#55),
 * down to reusing that pair's own gate and 404.
 *
 * ── AUTH: NOT A NEW MECHANISM ────────────────────────────────────────────
 * Same `readOperator` gate `/leads` and `/deliveries` already use, same
 * indistinguishable 404 (`leadsNotFound()`) for anyone it rejects — an
 * anonymous caller, a customer who owns rows in the very list they were
 * refused, or (with no operator configured behind Cloudflare's edge) literally
 * everyone. See `src/operators.ts`.
 *
 * ── WHY THIS QUERIES `submissions` DIRECTLY ───────────────────────────────
 * `src/submissions.ts` has no "every submission, unscoped" export — every
 * reader there takes an owning `customerEmail` or a `projectId` a caller has
 * already checked ownership of, on purpose (see that file's own comments on
 * `listSubmissionsForCustomer` and `listSubmissionsForProject`). Rather than
 * add a first unscoped reader to a module whose whole shape is "ownership is
 * the query", this route reads the table itself — the same choice
 * `listAllOutbox` (`src/notifications.ts`) makes for `/deliveries` against
 * `outbox`, which also has no unscoped-anywhere-else caller.
 *
 * ── SCOPE ─────────────────────────────────────────────────────────────────
 * Read-only, like `/deliveries`. No link into `/submissions/:id`: that route
 * is ownership-scoped to the customer's own Access identity (#12) and 404s an
 * operator by construction, so a link into it from here would be a link to a
 * 404. No filtering, search or pagination — the same restraint #55 puts on
 * `/deliveries` until the volume exists to justify them.
 */
export async function requestsInbox(request: Request, env: Env): Promise<Response> {
  const operator = await readOperator(request, env)
  if (!operator) return leadsNotFound()

  const rows = await listAllRequestRows(env)
  return html(page("Requests — coord-portal", requestsPage(operator, rows)))
}

interface SubmissionRow {
  reference: string
  status: string
  customer_email: string | null
  outcome: string
  created_at: string
}

interface RequestRow {
  reference: string
  title: string
  customerEmail: string | null
  createdAt: string
  display: SubmissionStatus
  round: SignoffState | null
}

/**
 * Every submission across every customer, newest first, with the same
 * customer-facing status a customer's own screens would show — see
 * `routes/dashboard.ts`'s identical `displayOf`, which this mirrors rather
 * than shares: that function closes over one customer's own list, and this
 * one is deliberately the unscoped case that module's own comments say does
 * not belong there.
 */
async function listAllRequestRows(env: Env): Promise<RequestRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT reference, status, customer_email, outcome, created_at
       FROM submissions
      ORDER BY created_at DESC`,
  ).all<SubmissionRow>()
  const submissions = results ?? []

  const references = submissions.map((row) => row.reference)
  // The newest design round + verdict for every submission that has one —
  // unfiltered by status, unlike `loadSignoffStates`'s only other caller
  // (`routes/dashboard.ts`, which asks only for `awaiting-signoff` rows to
  // derive a status from). An operator triaging the whole pipeline benefits
  // from seeing round history on a submission that has since moved past
  // sign-off too, not only the one status where it changes what is shown.
  const roundStates = await loadSignoffStates(env, references)
  // Issue #132's operator override, batched the same way — see
  // `routes/dashboard.ts`'s identical call.
  const startWorkStates = await loadStartWorkStates(
    env,
    submissions.filter((row) => row.status === "describing").map((row) => row.reference),
  )

  return submissions.map((row) => {
    const status = isSubmissionStatus(row.status) ? row.status : "describing"
    const state = roundStates.get(row.reference) ?? null
    const display = customerFacingStatus(
      derivedStartWorkStatus(
        derivedStatus(status, state),
        startWorkStates.get(row.reference) ?? null,
      ),
    )
    return {
      reference: row.reference,
      title: titleFromOutcome(row.outcome),
      customerEmail: row.customer_email,
      createdAt: row.created_at,
      display,
      round: state,
    }
  })
}

/**
 * The same derivation `titleOf` (`src/submissions.ts`) applies to a full
 * `Submission` — the intake form collects an outcome, not a title, so the
 * first line of it stands in for one — spelled out again here rather than
 * imported: this route's own query (above) selects only the columns it
 * needs off the unscoped table, not a full `Submission`, so there is no
 * value to pass `titleOf` without first faking the rest of that interface.
 */
function titleFromOutcome(outcome: string): string {
  const firstLine = outcome.split("\n")[0]?.trim() || outcome
  return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine
}

function requestsPage(operator: Operator, rows: RequestRow[]): string {
  return `${operatorTopbar(operator.email, "requests")}
<main>
  <div class="page-head">
    <h1>Requests</h1>
  </div>
  <p class="lede">Every submission the portal holds, across every customer, most recently created first — the operator-wide counterpart to a customer's own <code>/submissions</code>.</p>
  ${rows.length > 0 ? requestsList(rows) : emptyRequests()}
</main>`
}

function requestsList(rows: RequestRow[]): string {
  return `<ul class="requests-list" data-testid="requests-list">
${rows.map(requestRow).join("\n")}
  </ul>`
}

/** Mirrors `routes/leads.ts`'s `emptyInbox()` — present instead of the list, never alongside it. */
function emptyRequests(): string {
  return `<p class="lede" data-testid="requests-list-empty">Nothing submitted yet.</p>`
}

function requestRow(row: RequestRow): string {
  return `    <li>
      <div class="request-row" data-testid="request-row" data-status="${escapeHtml(row.display)}">
        <div class="row-main">
          <span class="title" data-testid="request-title">${escapeHtml(row.title)}</span>
          <span class="meta">
            <span data-testid="request-customer">${escapeHtml(row.customerEmail ?? "no email on file")}</span>
            &middot; <span data-testid="request-reference">${escapeHtml(row.reference)}</span>
            &middot; ${escapeHtml(row.createdAt)}
          </span>
        </div>
        <div class="row-side">
          <span class="status-pill" data-testid="status-pill" data-status="${escapeHtml(row.display)}">${escapeHtml(statusText(row.display))}</span>${roundBadge(row.round)}
        </div>
      </div>
    </li>`
}

/**
 * The newest design round and its verdict, present only for a submission
 * that has at least one — same optional-detail shape `deliveries.ts`'s
 * `deliveryDetail` uses for a row's status-dependent extra.
 */
function roundBadge(round: SignoffState | null): string {
  if (!round) return ""
  return `
          <span class="round-pill" data-testid="request-round" data-verdict="${escapeHtml(round.verdict)}">Round ${round.round} &middot; ${escapeHtml(VERDICT_TEXT[round.verdict])}</span>`
}
