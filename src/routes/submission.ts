import { readAccessIdentity } from "../identity"
import { getOpenQuestion, recordAnswer, type OpenQuestion } from "../questions"
import { escapeHtml, html, page, topbar } from "../render"
import {
  derivedStatus,
  getCurrentRound,
  listRounds,
  recordSignoff,
  VERDICT_TEXT,
  type DesignRound,
} from "../rounds"
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
 * `shipped` get their own small templates (`09`, `10`); `needs-input` carries
 * the question channel (#11) and `awaiting-signoff` the design round and its
 * sign-off actions (#13).
 *
 * The one nuance is that "its status" means the *derived* status — see
 * `derivedStatus` in `src/rounds.ts`. `status` is coord-owned and no portal code
 * path writes it, so a customer who has just requested changes is still stored
 * at `awaiting-signoff` until the fleet notices; what they see is `In design`,
 * because that is true and there is nothing left for them to sign off.
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
 * POST /submissions/:id — everything the customer can *say* about one
 * submission: answering an open question (#11), and approving or requesting
 * changes on the current design round (#13).
 *
 * One route, dispatched on an `action` field, because all three are the same
 * shape: a plain form post to the page that rendered it, no client-side script
 * required, and a 303 back so a reload never resubmits. Which round or question
 * the write belongs to is always derived server-side and never read from the
 * form — same reasoning `src/ids.ts` gives for never accepting an id from the
 * caller.
 */
export async function submitSubmissionAction(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const identity = readAccessIdentity(request)
  const submission = await getSubmission(env, id)
  if (!submission || !isOwnedBy(submission, identity.email)) {
    return html(page("Not found — coord-portal", notFound()), { status: 404 })
  }

  const form = await request.formData()
  const action = stringField(form, "action")

  if (action === "approve" || action === "request-changes") {
    return submitSignoff(env, identity.email, submission, action, form)
  }
  return submitAnswer(env, identity.email, submission, form)
}

/**
 * Answering an open question (#11).
 *
 * The question being answered is derived from `getOpenQuestion`, never taken
 * from the submitted form. If nothing is open by the time this lands (already
 * answered by a previous submit, a race with a fresh coordinator push, or a
 * question that was never raised), the current screen is re-rendered rather than
 * silently accepting a stray write.
 */
async function submitAnswer(
  env: Env,
  email: string | null,
  submission: Submission,
  form: FormData,
): Promise<Response> {
  const open =
    submission.status === "needs-input" ? await getOpenQuestion(env, submission.reference) : null
  if (!open) {
    const main = await detailFor(env, email, submission)
    return html(page(`${submission.reference} — coord-portal`, main), { status: 409 })
  }

  const answer = stringField(form, "answer")
  if (!answer) {
    // "an empty answer does not end the pause": nothing is recorded, and the
    // same open question is redisplayed so the composer stays reachable.
    return html(
      page(
        `${submission.reference} — coord-portal`,
        pausedDetail(email, submission, open, "Please write an answer before sending."),
      ),
      { status: 400 },
    )
  }

  await recordAnswer(env, submission.reference, open.revision, answer)

  return new Response(null, {
    status: 303,
    headers: { location: `/submissions/${submission.id}` },
  })
}

/**
 * Approving, or requesting changes on, the current design round (#13).
 *
 * Which round is being decided comes from `getCurrentRound`, never from the
 * form: a request does not get to assert which proposal it is answering, and a
 * form rendered against round 2 that arrives after round 3 opened must not land
 * a verdict on either.
 *
 * A blank comment does not burn a round. The composer is redisplayed, open, with
 * the message — nothing is recorded, no event is emitted, and the round is still
 * pending, so the customer can try again.
 */
async function submitSignoff(
  env: Env,
  email: string | null,
  submission: Submission,
  action: "approve" | "request-changes",
  form: FormData,
): Promise<Response> {
  const current =
    submission.status === "awaiting-signoff" ? await getCurrentRound(env, submission.reference) : null

  if (!current || current.verdict !== "pending") {
    // Nothing is awaiting this customer's sign-off — already decided, superseded,
    // or the submission has moved on. Re-render what is actually true.
    const main = await detailFor(env, email, submission)
    return html(page(`${submission.reference} — coord-portal`, main), { status: 409 })
  }

  if (action === "request-changes") {
    const comment = stringField(form, "changesComment") || stringField(form, "comment")
    if (!comment) {
      return html(
        page(
          `${submission.reference} — coord-portal`,
          awaitingSignoffDetail(email, submission, current, {
            composerOpen: true,
            error: "Tell us what should change before submitting.",
          }),
        ),
        { status: 400 },
      )
    }
    await recordSignoff(env, submission.reference, current.round, "changes-requested", comment)
  } else {
    // Approving asks for no comment — the contract pins `round-comment` as
    // "present only on rounds where changes were requested".
    await recordSignoff(env, submission.reference, current.round, "approved", null)
  }

  return new Response(null, {
    status: 303,
    headers: { location: `/submissions/${submission.id}` },
  })
}

function stringField(form: FormData, name: string): string {
  const value = form.get(name)
  return typeof value === "string" ? value.trim() : ""
}

/**
 * GET /submissions/:id/rounds — the versioned round history (issue #13).
 *
 * Every round the coordinator has ever published for this submission, newest
 * first, each with its verdict and (where changes were requested) the comment
 * that asked for them. A superseded round is never deleted or hidden — this page
 * is the audit trail of what was agreed, and a history that quietly loses the
 * round somebody actually signed off is worse than no history at all.
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

  const rounds = await listRounds(env, submission.reference)
  return html(
    page(
      `Round history — ${submission.reference} — coord-portal`,
      roundHistory(identity.email, submission, rounds),
    ),
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
 * four read-only states, the pinned copy for on-hold and shipped;
 * `needs-input` additionally owns the question channel (#11) and
 * `awaiting-signoff` the design round (#13).
 */
async function detailFor(env: Env, email: string | null, submission: Submission): Promise<string> {
  if (submission.status === "describing") return receipt(email, submission)
  if (isRollupStatus(submission.status)) return rollupDetail(email, submission, submission.status)
  if (submission.status === "on-hold") return onHoldDetail(env, email, submission)
  if (submission.status === "shipped") return shippedDetail(email, submission)
  if (submission.status === "needs-input") return needsInputDetail(env, email, submission)
  return signoffDetail(env, email, submission)
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
 *
 * `display` is the *derived* status, which for a submission stored at
 * `awaiting-signoff` whose current round has a verdict is `in-design` (changes
 * requested) or `planned` (approved). Everything below it — pill, timeline,
 * copy — is a pure function of that one value, so the loop's return to
 * `In design` needs no separate template and no portal write to `status`.
 */
function rollupDetail(
  email: string | null,
  submission: Submission,
  display: SubmissionStatus,
): string {
  const current = currentTimelineStep(display)
  const steps = TIMELINE_STEPS.map((step) => {
    const currentAttr = step === current ? ' data-current="true"' : ""
    return `    <li data-testid="timeline-step" data-step="${step}"${currentAttr}>${escapeHtml(statusText(step))}</li>`
  }).join("\n")

  return `${topbar(email, "none")}
<main data-testid="submission-detail" data-status="${escapeHtml(display)}">
  ${statusPill(display)}
  <h1>${escapeHtml(titleOf(submission))}</h1>
  ${referenceLine(submission)}

  <ol class="timeline" data-testid="status-timeline" aria-label="Progress">
${steps}
  </ol>

  <section class="card">
    <p data-testid="rollup-copy">${escapeHtml(rollupCopy(display))}</p>
  </section>

  ${roundHistoryLink(submission)}
</main>`
}

/**
 * The way back into the audit trail from a screen that is not showing a round.
 *
 * Rendered on the rollup states only, and only as a plain link: the contract
 * pins `round-history-link` as a hook of the awaiting-sign-off screen, so this
 * one deliberately does not carry that `data-testid` — a second element under
 * the same hook would make every `getByTestId("round-history-link")` in the
 * suite ambiguous.
 */
function roundHistoryLink(submission: Submission): string {
  return `<p class="round-history-aside"><a href="/submissions/${submission.id}/rounds">See all design rounds</a></p>`
}

/**
 * `awaiting-signoff` with no round to sign off, and `needs-input` with no open
 * question: customer-actionable per the pinned vocabulary table, but with
 * nothing yet to act on. Renders the pill and reference and deliberately
 * nothing that asks the customer for anything — an affordance with no proposal
 * behind it is worse than no affordance.
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

/* ─────────────────────────── the sign-off loop (#13) ─────────────────────── */

/**
 * `awaiting-signoff` — issue #13's design round.
 *
 * Three outcomes, all derived from portal-owned state against the coord-owned
 * round, and none of them a write to `submissions.status`:
 *
 *   no round published   -> the quiet "nothing to do yet" card. A sign-off
 *                           affordance with no proposal behind it would be a
 *                           button that decides nothing.
 *   round pending        -> the round, with Approve / Request changes.
 *   changes requested    -> `In design`. The ball is back with the team, the
 *                           round is closed, and no affordance survives.
 *   approved             -> `Planned`. "Approve is the only action that can move
 *                           a submission past Awaiting your sign-off."
 */
async function signoffDetail(
  env: Env,
  email: string | null,
  submission: Submission,
): Promise<string> {
  const current = await getCurrentRound(env, submission.reference)
  if (!current) return actionableDetail(email, submission)

  const display = derivedStatus(submission.status, { round: current.round, verdict: current.verdict })
  if (display !== "awaiting-signoff") return rollupDetail(email, submission, display)

  return awaitingSignoffDetail(email, submission, current)
}

interface ComposerState {
  /** Re-open the request-changes composer server-side after a rejected submit. */
  composerOpen?: boolean
  error?: string
}

/**
 * The awaiting-sign-off screen and its request-changes composer —
 * `mocks/05-submission-awaiting-signoff.html` and
 * `mocks/06-request-changes.html`, which the contract is explicit are the same
 * URL with the composer expanded, "not a distinct URL".
 *
 * The composer opens with **no JavaScript at all**: a visually-hidden checkbox
 * ahead of both sections, toggled by two `<label>`s (`request-changes-button`
 * and `cancel-changes`), with CSS revealing the form while it is checked. That
 * is not cleverness for its own sake — CLAUDE.md pins "no build step, no
 * framework", every other form in this portal is a plain server-rendered POST,
 * and a disclosure that depends on script would be the one control on the
 * screen that stops working when script does. The labels carry `role="button"`
 * and `tabindex` so they are still buttons to a screen reader and to the
 * keyboard.
 *
 * `checked` is also settable from the server, which is how a rejected blank
 * comment comes back with the composer still open and the customer's place
 * kept.
 */
function awaitingSignoffDetail(
  email: string | null,
  submission: Submission,
  round: DesignRound,
  state: ComposerState = {},
): string {
  const next = round.round + 1
  const checked = state.composerOpen ? " checked" : ""
  const errorBlock = state.error
    ? `<p class="composer-error" data-testid="changes-error" role="alert">${escapeHtml(state.error)}</p>`
    : ""

  return `${topbar(email, "none")}
<main data-testid="submission-detail" data-status="awaiting-signoff">
  ${statusPill("awaiting-signoff")}
  <h1>${escapeHtml(titleOf(submission))}</h1>
  ${referenceLine(submission)}

  <input class="composer-toggle" type="checkbox" id="request-changes-toggle" tabindex="-1" aria-hidden="true"${checked}>

  <section class="round-card" data-testid="design-round" data-round="${round.round}" data-verdict="pending">
    <div class="round-head">
      <span class="round-badge" data-testid="round-number">Round ${round.round}</span>
      <a class="round-history-link" href="/submissions/${submission.id}/rounds" data-testid="round-history-link">See all rounds</a>
    </div>

    <h2>What we understood</h2>
    <p class="outcome-definition" data-testid="outcome-definition">${escapeHtml(round.outcomeDefinition)}</p>

    <h2>What we're proposing</h2>
    ${decompositionList(round)}
${mockBundleSection(submission, round)}
    <div class="round-actions">
      <form method="POST" action="/submissions/${submission.id}" class="inline-form">
        <input type="hidden" name="action" value="approve">
        <button type="submit" class="primary" data-testid="approve-button">Approve</button>
      </form>
      <label class="secondary" role="button" tabindex="0" for="request-changes-toggle" data-testid="request-changes-button">Request changes</label>
    </div>
  </section>

  <form class="composer" method="POST" action="/submissions/${submission.id}"
        data-testid="request-changes-form" aria-label="Request changes">
    <input type="hidden" name="action" value="request-changes">
    <h2>What should change?</h2>
    <p class="hint">Your notes become Round ${next}. Round ${round.round} stays exactly as it is, for reference.</p>
    ${errorBlock}
    <label for="changesComment" class="visually-hidden">Requested changes</label>
    <textarea id="changesComment" name="changesComment" rows="5" required
      data-testid="changes-comment"
      placeholder="Tell us what to change and why."></textarea>
    <p class="next-round-note" data-testid="next-round-note">Submitting opens Round ${next} and moves this back to <strong>In design</strong>.</p>
    <div class="actions">
      <label class="ghost" role="button" tabindex="0" for="request-changes-toggle" data-testid="cancel-changes">Cancel</label>
      <button type="submit" class="primary" data-testid="submit-changes">Submit changes</button>
    </div>
  </form>
</main>`
}

/**
 * The decomposition, "rendered as a plain-text list of work items — no issue
 * numbers, no branch names, no agent identifiers, ever" (Gate-A contract).
 *
 * The scrubbing that makes the "ever" true happens in `src/rounds.ts`, on the
 * way into storage *and* on the way back out, so this template can stay a
 * template. The `<ul>` renders even when empty: `decomposition-list` is a pinned
 * hook, and a round coord published without work items is a thin proposal, not a
 * missing screen.
 */
function decompositionList(round: DesignRound): string {
  const items = round.decomposition
    .map((item) => `      <li data-testid="decomposition-item">${escapeHtml(item)}</li>`)
    .join("\n")
  return `<ul class="decomposition-list" data-testid="decomposition-list">
${items}
    </ul>`
}

/**
 * The mock bundle link, rendered only when coord has actually published one.
 *
 * An absolute URL or a root-relative path is used verbatim — coord may host the
 * bundle wherever it likes. Anything else is treated as a key in the ARTIFACTS
 * R2 bucket and served back through this portal (see `routes/mocks.ts`), which
 * is the arrangement issue #13 describes: "stored in R2, served read-only".
 *
 * The link text carries no identifier of any kind, so the `href` is the only
 * thing on this screen that could leak one — which is why a bare key becomes a
 * portal path rather than being echoed out.
 */
function mockBundleSection(submission: Submission, round: DesignRound): string {
  const href = mockBundleHref(submission, round)
  if (!href) return ""
  return `    <h2>Mock bundle</h2>
    <a class="mock-bundle-link" href="${escapeHtml(href)}" data-testid="mock-bundle-link"
       aria-label="Open the mock bundle for this round">
      View the mock &rarr;
    </a>

`
}

export function mockBundleHref(submission: Submission, round: DesignRound): string | null {
  const bundle = round.mockBundle?.trim()
  if (!bundle) return null
  if (/^https?:\/\//i.test(bundle) || bundle.startsWith("/")) return bundle
  return `/submissions/${submission.id}/rounds/${round.round}/mock`
}

/**
 * `GET /submissions/:id/rounds` — `mocks/07-round-history.html`.
 *
 * Newest round first. Note what does *not* carry a `data-testid` here: the
 * outcome definition and the work items render as plain markup, exactly as the
 * mock does, because `outcome-definition` and `decomposition-item` are pinned
 * hooks of the *current-round* screen. Repeating them once per historical round
 * would turn every one of those locators into a strict-mode ambiguity.
 */
function roundHistory(
  email: string | null,
  submission: Submission,
  rounds: DesignRound[],
): string {
  const body =
    rounds.length > 0
      ? rounds.map(roundEntry).join("\n")
      : `    <p class="lede">No design round has been published for this request yet.</p>`

  return `${topbar(email, "none")}
<main>
  <a class="back-link" href="/submissions/${submission.id}" data-testid="back-to-submission">&larr; ${escapeHtml(titleOf(submission))}</a>
  <h1>Round history</h1>
  <p class="meta" data-testid="submission-reference">${escapeHtml(submission.reference)}</p>

  <div data-testid="round-history">
${body}
  </div>
</main>`
}

function roundEntry(round: DesignRound): string {
  const items = round.decomposition
    .map((item) => `        <li>${escapeHtml(item)}</li>`)
    .join("\n")
  const decomposition = round.decomposition.length
    ? `      <ul class="decomposition-list">
${items}
      </ul>`
    : ""
  // Only rounds where changes were requested carry a comment — approving asks
  // for none, and a pending round has not been answered yet.
  //
  // The quotation marks `mocks/07-round-history.html` draws around this are
  // decoration, and they stay out of the DOM: this element holds the customer's
  // own words, verbatim, and anything read back out of it — by a test, by a
  // screen reader, by a copy-paste — should be exactly what they typed and not
  // a typeset version of it. The blockquote rule in `src/render.ts` carries the
  // visual instead.
  const comment =
    round.verdict === "changes-requested" && round.comment
      ? `      <blockquote data-testid="round-comment">${escapeHtml(round.comment)}</blockquote>`
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
    </section>`
}

/* ────────────────────────── the question channel (#11) ───────────────────── */

/**
 * `needs-input` — issue #11's question channel.
 *
 * `question` arrives coord-owned, in the same push that sets
 * `status: needs-input` (contract § Question channel), and stays in
 * `coord_facts` at whatever revision the daemon last wrote it — see
 * `src/questions.ts`. Whether the pause composer renders depends on that
 * question actually being *open*: a `needs-input` submission with no question
 * on record at all, or whose most recent question the customer has already
 * answered, falls back to `actionableDetail`'s quiet "nothing to do" card —
 * "a submission with no open question offers no answer channel" is a
 * black-box guarantee, not an oversight.
 */
async function needsInputDetail(env: Env, email: string | null, submission: Submission): Promise<string> {
  const open = await getOpenQuestion(env, submission.reference)
  if (!open) return actionableDetail(email, submission)
  return pausedDetail(email, submission, open)
}

/**
 * The pause screen itself: `pause-banner`, `question-thread` /
 * `question-text`, and the `answer-field` / `submit-answer` composer, exactly
 * the hooks `08-submission-needs-input.html` pins. Per the contract, "no other
 * customer action should be available on that screen while a question is
 * open" — this renders the pill, the reference, the banner and one form, and
 * nothing else. In particular no sign-off affordance leaks onto it: the
 * approve and request-changes controls exist only inside
 * `awaitingSignoffDetail`.
 *
 * `error`, when present, redisplays the same open question with a message
 * instead of advancing anything — the one path that reaches this is a blank
 * answer, which must not end the pause (see `submitAnswer`).
 */
function pausedDetail(
  email: string | null,
  submission: Submission,
  question: OpenQuestion,
  error?: string,
): string {
  const errorBlock = error
    ? `<p class="async-note" data-testid="answer-error" role="alert">${escapeHtml(error)}</p>`
    : ""

  return `${topbar(email, "none")}
<main data-testid="submission-detail" data-status="${escapeHtml(submission.status)}">
  ${statusPill(submission.status)}
  <h1>${escapeHtml(titleOf(submission))}</h1>
  ${referenceLine(submission)}

  <p class="pause-banner" data-testid="pause-banner">Work is paused until you answer.</p>

  <section class="card question-thread" data-testid="question-thread">
    <p class="question-text" data-testid="question-text">${escapeHtml(questionText(question.value))}</p>
    ${errorBlock}

    <form class="answer-form" method="POST" action="/submissions/${submission.id}" data-testid="answer-form">
      <input type="hidden" name="action" value="answer">
      <div class="field">
        <label for="answer">Your answer</label>
        <textarea id="answer" name="answer" rows="4" required
          data-testid="answer-field"
          placeholder="Write your answer here."></textarea>
      </div>
      <div class="actions">
        <button type="submit" class="primary" data-testid="submit-answer">Send answer</button>
      </div>
    </form>
  </section>
</main>`
}

/**
 * The question's value type is deliberately unpinned by the contract — the
 * daemon may push a string today and something richer later. Rendered
 * verbatim when it already is one (the expected case); otherwise serialised
 * defensively rather than dropped, so a shape this screen does not anticipate
 * still shows the customer *something* instead of a blank question.
 */
function questionText(value: unknown): string {
  if (typeof value === "string") return value
  if (value === null || value === undefined) return ""
  try {
    return JSON.stringify(value)
  } catch {
    return ""
  }
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

  ${roundHistoryLink(submission)}
</main>`
}

function notFound(): string {
  return `<main>
  <h1>We can't find that request</h1>
  <p class="lede">It may have been submitted somewhere else, or the link is wrong.</p>
</main>`
}
