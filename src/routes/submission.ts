import { readAccessIdentity } from "../identity"
import { html, page, topbar } from "../render"
import { getSubmission } from "../submissions"
import type { Env } from "../types"

/**
 * GET /submissions/:id
 *
 * Issue #9 ends at "a reviewed draft round exists": the decomposition a
 * daemon-side agent proposes is reviewed by an engineer *before* it reaches
 * the customer (publishing it is #13). So at `describing` — the only status
 * this issue's write path can ever produce — there is no design-round surface
 * to render at all, matching the contract's `02-intake-received.html` mock
 * exactly rather than the later `submission-detail` rollup template (`04`).
 *
 * A later status here is #13's job to render; nothing in this milestone can
 * move a submission past `describing`, so that branch does not exist yet.
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

function receipt(
  email: string | null,
  submission: { id: string; reference: string },
): string {
  return `${topbar(email, "none")}
<main>
  <section class="receipt" data-testid="intake-receipt">
    <p class="status-pill" data-testid="status-pill" data-status="describing">Describing</p>
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
