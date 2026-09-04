import { parseFormData } from "../formData"
import { readOperator, type Operator } from "../operators"
import { recordOperatorRead } from "../operatorAccess"
import { escapeHtml, html, operatorTopbar, page } from "../render"
import {
  derivedStatus,
  getCurrentRound,
  listRounds,
  loadSignoffStates,
  VERDICT_TEXT,
  type DesignRound,
  type SignoffState,
} from "../rounds"
import { derivedStartWorkStatus, getStartWork, loadStartWorkStates, type StartWorkRecord } from "../startWork"
import {
  customerFacingStatus,
  getSubmission,
  isSubmissionStatus,
  statusText,
  titleOf,
  type Submission,
  type SubmissionStatus,
} from "../submissions"
import type { Env } from "../types"
import {
  applyReassignmentChoice,
  leadsNotFound,
  loadReassignmentOptions,
  reassignPanel,
  type ReassignmentOptions,
} from "./leads"
import { isFormContentType } from "./submission"

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
 * Read-only, like `/deliveries` — at first. No link into `/submissions/:id`:
 * that route is ownership-scoped to the customer's own Access identity (#12)
 * and 404s an operator by construction, so a link into it from here would be
 * a link to a 404. No filtering, search or pagination — the same restraint
 * #55 puts on `/deliveries` until the volume exists to justify them.
 *
 * ── `GET`/`POST /requests/:id` — ISSUE #145's REASSIGNMENT SURFACE ─────────
 * #125/#130 built "move a submission to a different, or new, project of the
 * same client" but wired it up as `POST /leads/:id/reassign` — reachable only
 * from the lead that produced the promoted submission. A submission an
 * already-onboarded customer files through `/intake` has no lead at all
 * (leads only exist for the public `/start` form), so there was structurally
 * no page anywhere that could offer to move it. This list is the one screen
 * that already renders *every* submission the portal holds regardless of
 * whether it has a lead, a project, or even a matched `clients` row, so it is
 * also the one screen that can host the fix without inventing a new query.
 *
 * `requestDetail`/`postRequestReassign` below are a second, submission-keyed
 * entry point to the exact same mechanic #130 already shipped —
 * `loadReassignmentOptions`/`applyReassignmentChoice`/`reassignPanel`
 * (`routes/leads.ts`) are shared, unchanged code, not a reimplementation.
 * `POST /leads/:id/reassign` keeps working exactly as it did; this adds a
 * second door onto the same room; it does not move the first one. Same
 * `readOperator` gate and indistinguishable 404 as every route on this
 * surface, so a non-operator gets a 404, never a 403.
 *
 * ── `GET /requests/:id/rounds` — ISSUE #304's OPERATOR ROUND READ ─────────
 * `requestDetail`'s own doc comment used to say plainly that this surface's
 * "contract is the reassignment panel, not a general operator submission
 * detail screen" and that round history in particular should not be added
 * "without its own issue". #304 is that issue: an operator reviewing a
 * `changes-requested` verdict could read `signoff_comment` off `coord
 * journal` but never open the mock it was commenting on, because
 * `routes/mocks.ts`'s bundle route and `routes/submission.ts`'s round history
 * both gate on `isOwnedBy` alone, and an operator's Access email is never a
 * submission's `customer_email`.
 *
 * `requestRounds` below, and `operatorMockBundle`
 * (`routes/mocks.ts`, wired in `src/pages.ts`), are the fix — a second,
 * operator-scoped read of the exact same `design_rounds`/`signoffs` state and
 * the exact same R2 bytes, never a widening of `isOwnedBy` itself (see that
 * function's own doc comment in `routes/submission.ts` for why not). Every
 * page this surface renders says so in its own copy
 * (`operator-access-notice`) — this is customer material read by an
 * operator, not a customer's own view of it — and every successful read is
 * recorded (`src/operatorAccess.ts`).
 */
export async function requestsInbox(request: Request, env: Env): Promise<Response> {
  const operator = await readOperator(request, env)
  if (!operator) return leadsNotFound()

  const rows = await listAllRequestRows(env)
  return html(page("Requests — coord-portal", requestsPage(operator, rows)))
}

const REQUESTS_PATH = "/requests"
const REQUEST_DETAIL_PATH = /^\/requests\/([^/?#]+)$/
const REQUEST_REASSIGN_PATH = /^\/requests\/([^/?#]+)\/reassign$/
const REQUEST_ROUNDS_PATH = /^\/requests\/([^/?#]+)\/rounds$/

/** What `handlePages` needs to know about a `/requests…` URL, or `null`. */
export function matchRequestsPath(
  pathname: string,
):
  | { kind: "index" }
  | { kind: "detail"; id: string }
  | { kind: "reassign"; id: string }
  | { kind: "rounds"; id: string }
  | null {
  if (pathname === REQUESTS_PATH) return { kind: "index" }

  const reassign = pathname.match(REQUEST_REASSIGN_PATH)
  if (reassign?.[1]) return { kind: "reassign", id: reassign[1] }

  // Checked ahead of `detail` below: `/requests/:id/rounds` would otherwise
  // never reach `REQUEST_DETAIL_PATH` (that regex requires nothing after the
  // id), but the mock-bundle path under it
  // (`/requests/:id/rounds/:n/mock[/...]`) is matched directly in
  // `src/pages.ts` via `routes/mocks.ts`'s own `matchOperatorMockBundlePath`,
  // the same split the customer-facing routes already use between
  // `SUBMISSION_ROUNDS_PATH` and `matchMockBundlePath`.
  const rounds = pathname.match(REQUEST_ROUNDS_PATH)
  if (rounds?.[1]) return { kind: "rounds", id: rounds[1] }

  const detail = pathname.match(REQUEST_DETAIL_PATH)
  if (detail?.[1]) return { kind: "detail", id: detail[1] }

  return null
}

interface SubmissionRow {
  id: string
  reference: string
  status: string
  customer_email: string | null
  outcome: string
  created_at: string
}

interface RequestRow {
  id: string
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
    `SELECT id, reference, status, customer_email, outcome, created_at
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
    const display = deriveDisplayStatus(status, state, startWorkStates.get(row.reference) ?? null)
    return {
      id: row.id,
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
 * The one derivation `listAllRequestRows` and `requestDetail` (issue #145)
 * both need — factored out so the list's batched lookups
 * (`loadSignoffStates`/`loadStartWorkStates`, chunked for D1's bound-parameter
 * ceiling, see `src/d1.ts`) and the detail screen's single-submission ones
 * (`getCurrentRound`/`getStartWork`) feed the exact same composition rather
 * than two copies drifting apart.
 */
function deriveDisplayStatus(
  status: SubmissionStatus,
  round: SignoffState | null,
  startWork: StartWorkRecord | null,
): SubmissionStatus {
  return customerFacingStatus(derivedStartWorkStatus(derivedStatus(status, round), startWork))
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
          <a class="button secondary" href="/requests/${encodeURIComponent(row.id)}" data-testid="request-reassign-link">Reassign</a>
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

/**
 * `GET /requests/:id` — issue #145. One submission, operator-facing, keyed by
 * the row id `listAllRequestRows` already carries rather than the
 * `SUB-XXXXXX` reference: `getSubmission` (`src/submissions.ts`) is the
 * durable by-id lookup every other write path in this codebase already
 * trusts, and reusing it here means this route needs no query of its own
 * beyond the one call.
 *
 * Exists for exactly one reason today — hosting the reassignment panel for a
 * submission `/leads/:id` cannot reach (see this file's module comment) — so
 * it renders just enough to orient an operator who followed the "Reassign"
 * link off the list (`requestRow` above): what it is, whose it is, and the
 * panel itself. It is not a second `/submissions/:id`; there is no message
 * thread, round history or preview link here, and none should be added
 * without its own issue — this route's contract is the reassignment panel,
 * not a general operator submission detail screen.
 */
export async function requestDetail(request: Request, env: Env, id: string): Promise<Response> {
  const operator = await readOperator(request, env)
  if (!operator) return leadsNotFound()

  const submission = await getSubmission(env, id)
  if (!submission) return leadsNotFound()

  const display = await displayStatusFor(env, submission)
  const options = await loadReassignmentOptions(env, submission.projectId, submission.customerEmail)

  return html(
    page(
      `${submission.reference} — coord-portal`,
      requestDetailPage(operator, submission, display, options),
    ),
  )
}

/**
 * `POST /requests/:id/reassign` — issue #145's second entry point for #130's
 * mechanic. Same guard shape as `postLeadReassign` (`routes/leads.ts`): an
 * unknown id gets the one operator-surface 404, a malformed or unparseable
 * body gets the same 404 (`isFormContentType`, mirroring
 * `postLeadReassign`'s identical check), and an unrecognised `projectChoice`
 * is a no-op 303 back to the screen — never an error for an operator who did
 * nothing wrong.
 *
 * `applyReassignmentChoice` is the exact function `postLeadReassign` calls —
 * same "existing sibling or a brand-new project, same client only" contract,
 * same idempotency, same event on the bridge. This route supplies
 * `submission.customerEmail` where `postLeadReassign` supplies `lead.email`;
 * every other line is the shared function's, not a second copy of it.
 */
export async function postRequestReassign(request: Request, env: Env, id: string): Promise<Response> {
  const operator = await readOperator(request, env)
  if (!operator) return leadsNotFound()

  const submission = await getSubmission(env, id)
  if (!submission) return leadsNotFound()

  const contentType = request.headers.get("content-type") ?? ""
  if (!isFormContentType(contentType)) return leadsNotFound()

  const form = await parseFormData(request)
  if (!form) return leadsNotFound()

  const options = await loadReassignmentOptions(env, submission.projectId, submission.customerEmail)

  const rawChoice = form.get("projectChoice")
  const choice = typeof rawChoice === "string" ? rawChoice.trim() : ""

  await applyReassignmentChoice(env, submission, options, choice, submission.customerEmail)

  return new Response(null, {
    status: 303,
    headers: { location: `/requests/${encodeURIComponent(submission.id)}` },
  })
}

/**
 * The same derivation `listAllRequestRows` applies per row, for the one
 * submission this detail screen renders — `getCurrentRound`/`getStartWork`
 * rather than the list's batched `loadSignoffStates`/`loadStartWorkStates`:
 * a single-submission lookup has no D1 bound-parameter ceiling to dodge (see
 * `src/d1.ts`), so there is no reason to route it through the batch helpers
 * built for a table-wide scan.
 */
async function displayStatusFor(env: Env, submission: Submission): Promise<SubmissionStatus> {
  // Fetched unconditionally, same as `listAllRequestRows`'s own
  // `loadSignoffStates` call: an operator benefits from seeing round history
  // on a submission that has since moved past sign-off too, not only the one
  // status where it changes the derived value.
  const round = await getCurrentRound(env, submission.reference)
  const startWork =
    submission.status === "describing" ? await getStartWork(env, submission.reference) : null
  return deriveDisplayStatus(
    submission.status,
    round ? { round: round.round, verdict: round.verdict } : null,
    startWork,
  )
}

function requestDetailPage(
  operator: Operator,
  submission: Submission,
  display: SubmissionStatus,
  options: ReassignmentOptions,
): string {
  return `${operatorTopbar(operator.email, "requests")}
<main data-testid="request-detail">
  <a class="back-link" href="/requests" data-testid="back-to-requests">&larr; Requests</a>

  <span class="status-pill" data-testid="status-pill" data-status="${escapeHtml(display)}">${escapeHtml(statusText(display))}</span>
  <h1 data-testid="request-detail-title">${escapeHtml(titleOf(submission))}</h1>
  <p class="meta" data-testid="request-detail-reference">${escapeHtml(submission.reference)}</p>

  <dl class="card">
    <dt>Customer</dt>
    <dd data-testid="request-detail-customer">${escapeHtml(submission.customerEmail ?? "no email on file")}</dd>
  </dl>

  <p class="round-history-aside">
    <a href="/requests/${encodeURIComponent(submission.id)}/rounds" data-testid="request-rounds-link">
      See design rounds &amp; mock bundles
    </a>
  </p>

  ${reassignPanel(`/requests/${encodeURIComponent(submission.id)}/reassign`, options)}
</main>`
}

/* ─────────────────────── the operator round read (#304) ────────────────── */

/**
 * `GET /requests/:id/rounds` — issue #304's operator-scoped read of a
 * submission's design-round history: the same `design_rounds`/`signoffs`
 * state `routes/submission.ts`'s `submissionRounds` renders for the customer,
 * plus each round's decision timestamp (which the customer's own round
 * history does not show — see `operatorRoundEntry`) and a link to each
 * round's own published bundle (which the customer's own round history does
 * not link either — only the *current* round does, from the sign-off screen).
 * An operator reviewing history has no "current round" to stand on; every
 * round here needs its own way in.
 *
 * Same guard shape as `requestDetail` just above: `readOperator` first, then
 * `getSubmission`, both refusing with the one indistinguishable
 * `leadsNotFound()` this whole surface uses. A submission with no rounds yet
 * renders the same empty state `routes/submission.ts`'s `roundHistory` does —
 * "No design round has been published for this request yet" — never an
 * error.
 *
 * Recorded via `recordOperatorRead` with `round: null` — this reads the whole
 * history, not one round's bundle; see `src/operatorAccess.ts`.
 */
export async function requestRounds(request: Request, env: Env, id: string): Promise<Response> {
  const operator = await readOperator(request, env)
  if (!operator) return leadsNotFound()

  const submission = await getSubmission(env, id)
  if (!submission) return leadsNotFound()

  const rounds = await listRounds(env, submission.reference)
  await recordOperatorRead(env, operator.email, submission.reference, null)

  return html(
    page(
      `Round history — ${submission.reference} — coord-portal`,
      operatorRoundHistoryPage(operator, submission, rounds),
    ),
  )
}

function operatorRoundHistoryPage(
  operator: Operator,
  submission: Submission,
  rounds: DesignRound[],
): string {
  const body =
    rounds.length > 0
      ? rounds.map((round) => operatorRoundEntry(submission, round)).join("\n")
      : `    <p class="lede">No design round has been published for this request yet.</p>`

  return `${operatorTopbar(operator.email, "requests")}
<main>
  <a class="back-link" href="/requests/${encodeURIComponent(submission.id)}" data-testid="back-to-request">&larr; ${escapeHtml(titleOf(submission))}</a>
  <h1>Round history</h1>
  <p class="meta" data-testid="request-detail-reference">${escapeHtml(submission.reference)}</p>

  ${operatorAccessNotice(submission)}

  <div data-testid="round-history">
${body}
  </div>
</main>`
}

/**
 * "Clearly marked as operator access to customer material, not a customer
 * view" — issue #304's own acceptance line, made literal. Rendered once per
 * page, ahead of the round list itself, so it is the first thing an operator
 * reads here, not a footnote.
 */
function operatorAccessNotice(submission: Submission): string {
  return `<p class="operator-access-notice" data-testid="operator-access-notice" role="note">
    You are viewing ${escapeHtml(submission.customerEmail ?? "this customer")}'s design rounds and
    published mocks as an operator. This is their material, not yours — the read is recorded.
  </p>`
}

/**
 * One round, operator-facing — the same facts `routes/submission.ts`'s
 * `roundEntry` renders for the customer (badge, verdict, opened date, outcome
 * definition, decomposition and, on a `changes-requested` round, the
 * customer's own comment), plus the two things only an operator's screen
 * needs:
 *
 *   `round-decided-at`   the customer's own `decidedAt` — absent on a still-
 *                        `pending` round, the same way `round-comment` is
 *                        absent on an `approved` one. The customer's own
 *                        round history never shows this (their own copy
 *                        already says "opened <date>", and they were there
 *                        when they decided); an operator reviewing a verdict
 *                        after the fact needs to know when, not just what.
 *   `operator-mock-bundle-link`
 *                        every round's own published bundle, via
 *                        `operatorMockBundleHref` below — not only the
 *                        current round's, the way the customer's sign-off
 *                        screen links just one. An operator reviewing
 *                        history has no "current round" to stand on; each
 *                        entry needs its own way into what was actually
 *                        shown.
 *
 * Deliberately its own function rather than an extra parameter threaded onto
 * `routes/submission.ts`'s exported `roundEntry` — that function is called
 * positionally as `.map(roundEntry)` from two customer-facing call sites
 * (`submission.ts` itself and `routes/project.ts`); giving it a second,
 * operator-only parameter would mean either call site accidentally passing
 * `Array.prototype.map`'s own index/array arguments through it, which is
 * exactly the "two copies drifting" failure mode `roundEntry`'s own export
 * comment warns against, applied to itself.
 */
function operatorRoundEntry(submission: Submission, round: DesignRound): string {
  const items = round.decomposition.map((item) => `        <li>${escapeHtml(item)}</li>`).join("\n")
  const decomposition = round.decomposition.length
    ? `      <ul class="decomposition-list">
${items}
      </ul>`
    : ""

  // Only rounds where changes were requested carry a comment — approving asks
  // for none, and a pending round has not been answered yet. Same rule
  // `routes/submission.ts`'s `roundEntry` applies, and the same reason its own
  // comment gives for keeping the customer's words free of decorative
  // quotation marks in the DOM.
  const comment =
    round.verdict === "changes-requested" && round.comment
      ? `      <blockquote data-testid="round-comment">${escapeHtml(round.comment)}</blockquote>`
      : ""

  const decidedAt = round.decidedAt
    ? `      <p class="round-decided-at" data-testid="round-decided-at">Decided ${escapeHtml(round.decidedAt)}</p>`
    : ""

  const href = operatorMockBundleHref(submission, round)
  const bundleLink = href
    ? `      <a class="mock-bundle-link" href="${escapeHtml(href)}" data-testid="operator-mock-bundle-link"
         aria-label="Open the published mock bundle for round ${round.round}">
        View the mock bundle &rarr;
      </a>`
    : ""

  return `    <section class="round-entry" data-testid="round-entry" data-round="${round.round}" data-verdict="${escapeHtml(round.verdict)}">
      <div class="round-entry-head">
        <span class="round-badge">Round ${round.round}</span>
        <span class="verdict-pill" data-testid="verdict-pill" data-verdict="${escapeHtml(round.verdict)}">${escapeHtml(VERDICT_TEXT[round.verdict])}</span>
        <span class="round-date">opened ${escapeHtml(round.openedAt)}</span>
      </div>
      <p class="outcome-definition">${escapeHtml(round.outcomeDefinition)}</p>
${decomposition}
${comment}
${decidedAt}
${bundleLink}
    </section>`
}

/**
 * `mockBundleHref` (`routes/submission.ts`) for the operator route instead of
 * the customer one — same two shapes (an absolute URL or root-relative path
 * used verbatim; anything else treated as an R2 key and routed back through
 * this portal), same "no identifier in the link text" reasoning, only the R2
 * read path swapped for `routes/mocks.ts`'s `operatorMockBundle`
 * (`/requests/:id/rounds/:n/mock`) instead of the customer's `mockBundle`
 * (`/submissions/:id/rounds/:n/mock`) — a link built from the customer path
 * would 404 for an operator by construction, the same way `promotedReference`
 * (`routes/leads.ts`) never links a `/submissions/:id` an operator cannot open.
 */
function operatorMockBundleHref(submission: Submission, round: DesignRound): string | null {
  const bundle = round.mockBundle?.trim()
  if (!bundle) return null
  if (/^https?:\/\//i.test(bundle) || bundle.startsWith("/")) return bundle
  return `/requests/${submission.id}/rounds/${round.round}/mock`
}
