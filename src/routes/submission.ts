import { readAccessIdentity } from "../identity"
import { escapeHtml, html, page, topbar } from "../render"
import { getSubmission, statusText, type Submission } from "../submissions"
import type { Env } from "../types"

/**
 * GET /submissions/:id
 *
 * Issue #9 ends at "a reviewed draft round exists": the decomposition a
 * daemon-side agent proposes is reviewed by an engineer *before* it reaches
 * the customer (publishing it is #13). So there is no design-round surface to
 * render here at all, matching the contract's `02-intake-received.html` mock
 * exactly rather than the later `submission-detail` rollup template (`04`).
 *
 * The richer per-status templates (the rollup timeline, the sign-off actions)
 * are #10's and #13's job. What #15 changes here is narrower and unavoidable:
 * the coordinator can now move `status` over the sync bridge, so the pill has
 * to report what the row actually says. A hard-coded "Describing" on a
 * submission the fleet has already shipped is exactly the confidently-stale
 * screen the bridge's heartbeat exists to prevent.
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

  return html(page(`${submission.reference} — coord-portal`, receipt(identity.email, submission)))
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

function receipt(email: string | null, submission: Submission): string {
  return `${topbar(email, "none")}
<main>
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
