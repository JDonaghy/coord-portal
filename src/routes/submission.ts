import { readAccessIdentity } from "../identity"
import { escapeHtml, html, page, topbar } from "../render"
import {
  getCoordFact,
  getSubmission,
  isRollupStatus,
  statusText,
  titleOf,
  type Submission,
  type SubmissionStatus,
} from "../submissions"
import type { Env } from "../types"

/**
 * GET /submissions/:id — "rendered content is a pure function of its status"
 * (Gate-A contract, § Route surface).
 *
 * Issue #10 rolls engineer/issue/assignment state UP into the fixed customer
 * vocabulary and is explicit that the roll-up itself is computed daemon-side
 * and arrives over the bridge as one already-collapsed `status` — this route
 * only renders it. `describing` keeps the post-submit receipt template (#9);
 * the four non-actionable, non-terminal states share one read-only rollup
 * template (contract's note on `04-submission-in-design.html`); `on-hold` and
 * `shipped` get their own small templates (`09`, `10`); `awaiting-signoff` and
 * `needs-input` are customer-actionable, but the sign-off round and the
 * question thread that belong on those screens are #13's and #11's surfaces —
 * this milestone renders only what #10 owns: the pinned pill, and nothing that
 * asks the customer for anything yet.
 */
export async function submissionDetail(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const identity = readAccessIdentity(request)
  const submission = await getSubmission(env, id)
  if (!submission || !isOwnedBy(submission, identity.email)) {
    // Same 404 either way (issue #12: "a customer can only ever see their own
    // submissions"). Knowing the URL is not authorisation, and a 404 that only
    // fires for someone else's id would itself confirm the id exists.
    return html(page("Not found — coord-portal", notFound()), { status: 404 })
  }

  const main = await detailFor(env, identity.email, submission)
  return html(page(`${submission.reference} — coord-portal`, main))
}

/**
 * GET /submissions/:id/rounds
 *
 * The design-round loop itself is issue #13 and is not built yet — a
 * submission created by this milestone's intake form never leaves
 * `describing`, so there is no round to render. What issue #12 requires here
 * is narrower and already true today: the same ownership gate as the detail
 * route, so this second door onto the record leaks nothing either.
 */
export async function submissionRounds(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const identity = readAccessIdentity(request)
  const submission = await getSubmission(env, id)
  if (!submission || !isOwnedBy(submission, identity.email)) {
    return html(page("Not found — coord-portal", notFound()), { status: 404 })
  }

  return html(
    page(`Round history — ${submission.reference} — coord-portal`, rounds(identity.email, submission)),
  )
}

/**
 * The one ownership check this file needs, in one place. `null` never owns
 * anything — an unidentified caller and a submission with no recorded
 * customer (should one ever exist) both fail closed, not open.
 */
function isOwnedBy(submission: Submission, email: string | null): boolean {
  return email !== null && submission.customerEmail === email
}

/**
 * Dispatches to the one template `data-status` actually calls for. Every
 * branch renders the same `submission-detail` root and `status-pill` (the
 * hooks the contract pins as present "all statuses") — what changes below it
 * is what issue #10 says is allowed to change: the rollup timeline for the
 * four read-only states, the pinned copy for on-hold and shipped, and nothing
 * at all yet for the two actionable states, which belong to #13 and #11.
 */
async function detailFor(env: Env, email: string | null, submission: Submission): Promise<string> {
  if (submission.status === "describing") return receipt(email, submission)
  if (isRollupStatus(submission.status)) return rollupDetail(email, submission)
  if (submission.status === "on-hold") return onHoldDetail(env, email, submission)
  if (submission.status === "shipped") return shippedDetail(email, submission)
  // awaiting-signoff, needs-input: customer-actionable, but the actions
  // themselves are #13's and #11's surfaces — see the doc comment above.
  return actionableDetail(email, submission)
}

function statusPill(status: SubmissionStatus): string {
  return `<span class="status-pill" data-testid="status-pill" data-status="${escapeHtml(status)}">${escapeHtml(statusText(status))}</span>`
}

/** `submission-reference` outside the receipt template: reference plus when it was filed. */
function referenceLine(submission: Submission): string {
  return `<p class="meta" data-testid="submission-reference">${escapeHtml(submission.reference)} &middot; submitted ${escapeHtml(submission.createdAt)}</p>`
}

function receipt(email: string | null, submission: Submission): string {
  return `${topbar(email, "none")}
<main data-testid="submission-detail" data-status="${escapeHtml(submission.status)}">
  <section class="receipt" data-testid="intake-receipt">
    <p class="status-pill" data-testid="status-pill" data-status="${escapeHtml(submission.status)}">${escapeHtml(statusText(submission.status))}</p>
    <h1>Got it — we're on it</h1>
    <p class="ref" data-testid="submission-reference">Reference ${submission.reference}</p>
    <p class="lede">
      No one is chatting with you right now, and that's fine — the team will turn this
      into a design. We'll email you the moment there's something ready for your sign-off.
      No need to check back.
    </p>
    <div class="actions">
      <a class="button primary" href="/submissions/${submission.id}" data-testid="view-submission">View this request</a>
      <a class="button secondary" href="/submissions" data-testid="back-to-dashboard">My requests</a>
    </div>
  </section>
</main>`
}

/**
 * The headline timeline shown on the four rollup states — five milestones,
 * matching `mocks/04-submission-in-design.html` exactly. `planned` and
 * `quality-check` have no milestone of their own on it: issue #10 groups both
 * under "In progress" explicitly ("request-changes reviews, merge conflicts
 * and CI churn stay hidden inside In progress / Quality check"), so both
 * highlight that step rather than leaving nothing current.
 */
const TIMELINE_STEPS: SubmissionStatus[] = [
  "describing",
  "in-design",
  "awaiting-signoff",
  "in-progress",
  "shipped",
]

function currentTimelineStep(status: SubmissionStatus): SubmissionStatus {
  return (TIMELINE_STEPS as SubmissionStatus[]).includes(status) ? status : "in-progress"
}

function rollupCopy(status: SubmissionStatus): string {
  switch (status) {
    case "in-design":
      return "Our team is turning this into a design. There's nothing for you to do right now — we'll email you the moment there's a proposal ready for your sign-off."
    case "planned":
      return "Your sign-off is in and this work is queued to start. There's nothing for you to do right now — we'll email you the moment there's an update."
    case "quality-check":
      return "The work is built and going through a final check before it ships. There's nothing for you to do right now — we'll email you the moment it's ready."
    case "in-progress":
    default:
      return "Work is underway. There's nothing for you to do right now — we'll email you the moment there's something ready for you."
  }
}

/**
 * The template for all four non-actionable rollup states — `In design`,
 * `Planned`, `In progress`, `Quality check` — per the contract's note on
 * `04-submission-in-design.html`: "Implementers render the identical
 * read-only template for all four; only `data-status`, the pill text, and the
 * highlighted `timeline-step` change."
 */
function rollupDetail(email: string | null, submission: Submission): string {
  const current = currentTimelineStep(submission.status)
  const steps = TIMELINE_STEPS.map((step) => {
    const currentAttr = step === current ? ' data-current="true"' : ""
    return `    <li data-testid="timeline-step" data-step="${step}"${currentAttr}>${escapeHtml(statusText(step))}</li>`
  }).join("\n")

  return `${topbar(email, "none")}
<main data-testid="submission-detail" data-status="${escapeHtml(submission.status)}">
  ${statusPill(submission.status)}
  <h1>${escapeHtml(titleOf(submission))}</h1>
  ${referenceLine(submission)}

  <ol class="timeline" data-testid="status-timeline" aria-label="Progress">
${steps}
  </ol>

  <section class="card">
    <p data-testid="rollup-copy">${escapeHtml(rollupCopy(submission.status))}</p>
  </section>
</main>`
}

/**
 * `awaiting-signoff` and `needs-input`: customer-actionable per the pinned
 * vocabulary table, but the design-round sign-off (#13) and the question
 * thread (#11) are the other two milestone slices' surfaces, not this one's.
 * This renders only what #10 owns — the pinned pill and reference — and
 * deliberately nothing that asks the customer for anything yet, so this
 * screen does not ship half of another issue's UI ahead of that issue's own
 * contract.
 */
function actionableDetail(email: string | null, submission: Submission): string {
  return `${topbar(email, "none")}
<main data-testid="submission-detail" data-status="${escapeHtml(submission.status)}">
  ${statusPill(submission.status)}
  <h1>${escapeHtml(titleOf(submission))}</h1>
  ${referenceLine(submission)}

  <section class="card">
    <p>We'll email you the moment this is ready to look at.</p>
  </section>
</main>`
}

/**
 * `on-hold` — the literal reading of issue #10's still-open question ("does
 * On hold surface to customers at all?"). The pinned wording and hooks render
 * exactly as `mocks/09-submission-onhold.html`; `onhold-since` renders only
 * when the daemon has actually pushed one (the business-time threshold that
 * decides it is computed daemon-side, never here — see
 * `src/bridge/ownership.ts`), and this state asks the customer for nothing.
 */
async function onHoldDetail(env: Env, email: string | null, submission: Submission): Promise<string> {
  const since = await onHoldSince(env, submission.reference)
  const sinceLine = since
    ? `<p class="meta" data-testid="onhold-since">on-hold-since: ${escapeHtml(since)}</p>`
    : ""

  return `${topbar(email, "none")}
<main data-testid="submission-detail" data-status="${escapeHtml(submission.status)}">
  ${statusPill(submission.status)}
  <h1>${escapeHtml(titleOf(submission))}</h1>
  ${referenceLine(submission)}

  <section class="card">
    <p data-testid="onhold-copy">
      This has been paused on our side for more than a business day. We'll pick it back up —
      there is nothing for you to do right now.
    </p>
    ${sinceLine}
  </section>

  <p class="provisional-flag" data-testid="onhold-provisional-note">
    This status's wording is still provisional and may change.
  </p>
</main>`
}

const ISO_8601_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

async function onHoldSince(env: Env, reference: string): Promise<string | null> {
  const value = await getCoordFact(env, reference, "onhold_since")
  return typeof value === "string" && ISO_8601_Z.test(value) ? value : null
}

/** `shipped` — terminal, per `mocks/10-submission-shipped.html`. */
function shippedDetail(email: string | null, submission: Submission): string {
  return `${topbar(email, "none")}
<main data-testid="submission-detail" data-status="${escapeHtml(submission.status)}">
  ${statusPill(submission.status)}
  <h1>${escapeHtml(titleOf(submission))}</h1>
  ${referenceLine(submission)}

  <section class="card">
    <p data-testid="shipped-copy">This is live. Thanks for working through the design with us.</p>
    <a class="button primary" href="#" data-testid="shipped-link">View the result &rarr;</a>
  </section>
</main>`
}

function rounds(email: string | null, submission: Submission): string {
  return `${topbar(email, "none")}
<main>
  <a class="back-link" href="/submissions/${submission.id}" data-testid="back-to-submission">&larr; ${escapeHtml(submission.reference)}</a>
  <h1>Round history</h1>
  <div data-testid="round-history">
    <p class="lede">No design round has been published for this request yet.</p>
  </div>
</main>`
}

function notFound(): string {
  return `<main>
  <h1>We can't find that request</h1>
  <p class="lede">It may have been submitted somewhere else, or the link is wrong.</p>
</main>`
}
