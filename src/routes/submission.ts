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
  const submission = await getSubmission(env, id)
  if (!submission) {
    return html(page("Not found — coord-portal", notFound()), { status: 404 })
  }

  const identity = readAccessIdentity(request)
  return html(page(`${submission.reference} — coord-portal`, receipt(identity.email, submission)))
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

function notFound(): string {
  return `<main>
  <h1>We can't find that request</h1>
  <p class="lede">It may have been submitted somewhere else, or the link is wrong.</p>
</main>`
}
