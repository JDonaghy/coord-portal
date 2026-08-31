import { parseFormData } from "../formData"
import { resolveSiteIdentity } from "../identity"
import { listLifecycleEvents, type LifecycleEvent, type LifecycleEventKind } from "../lifecycle"
import { listMessages, postMessage, type Message, type MessageAuthorRole } from "../messages"
import { isOperatorEmail } from "../operators"
import {
  derivedQualityCheckStatus,
  getCurrentPreviewReview,
  recordPreviewReview,
} from "../previewReviews"
import {
  confirmRelayedAnswer,
  correctRelayedAnswer,
  getQuestionScreenState,
  recordAnswer,
  type OpenQuestion,
  type QuestionScreenState,
  type RelayedAnswer,
} from "../questions"
import { escapeHtml, html, page, topbar } from "../render"
import {
  derivedStatus,
  getCurrentRound,
  listRounds,
  recordSignoff,
  VERDICT_TEXT,
  type DesignRound,
} from "../rounds"
import { derivedStartWorkStatus, getStartWork } from "../startWork"
import {
  customerFacingStatus,
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
 * template (contract's note on `04-submission-in-design.html`); `shipped`
 * gets its own small template (`10`); `needs-input` carries the question
 * channel (#11) and `awaiting-signoff` the design round and its sign-off
 * actions (#13). `on-hold` has no template of its own — issue #74 (Gate-A
 * amendment) collapses it into the same rollup template as `in-progress`,
 * before this dispatch ever sees it (`customerFacingStatus`).
 *
 * The one nuance is that "its status" means the *derived* status — see
 * `derivedStatus` in `src/rounds.ts`. `status` is coord-owned and no portal code
 * path writes it, so a customer who has just requested changes is still stored
 * at `awaiting-signoff` until the fleet notices; what they see is `In design`,
 * because that is true and there is nothing left for them to sign off.
 *
 * `isOwnedBy` is checked against `resolveSiteIdentity`'s email (#1981), not
 * `readAccessIdentity`'s: a forged, unverified claim of someone else's
 * address must not pass this check. `resolveSiteIdentity` resolving to
 * `null` (verification failed behind the edge, or nobody is signed in at
 * all) already fails `isOwnedBy` against every submission — the same 404
 * below, no separate refusal needed.
 */
export async function submissionDetail(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const email = await resolveSiteIdentity(request, env)
  const submission = await getSubmission(env, id)
  if (!submission || !isOwnedBy(submission, email)) {
    // Same 404 either way (issue #12: "a customer can only ever see their own
    // submissions"). Knowing the URL is not authorisation, and a 404 that only
    // fires for someone else's id would itself confirm the id exists.
    //
    // This stays true for an operator too (issue #110's chat thread does not
    // reopen it): `tests/acceptance/ms-2/33-lead-triage-promotion.spec.ts`,
    // "the promoted submission reference is plain text the operator cannot
    // open", sealed-asserts `GET /submissions/:id` still 404s for an operator
    // — "ms-1's ownership scoping is not reopened for the operator." The
    // operator's half of the thread lives on `/leads/:id`
    // (`src/routes/leads.ts`) instead, reached the way an operator already
    // reaches everything else about a promoted lead, never through this
    // customer-only route.
    return notFoundResponse()
  }

  // Additive to the ownership scoping above, never a substitute for it — see
  // `dashboard.ts`'s identical call, and `isOperatorEmail` in
  // `src/operators.ts`, for the full rationale (issue #103).
  // Whether *this* submission belongs to the viewer is unaffected; this only
  // decides whether the nav's operator section (Leads, Deliveries) appears.
  const isOperator = isOperatorEmail(email, request, env)

  const thread = { messages: await listMessages(env, submission.reference) }
  const main = await detailFor(env, email, isOperator, submission, thread)
  return html(page(`${submission.reference} — coord-portal`, main))
}

/**
 * POST /submissions/:id — everything the customer can *say* about one
 * submission: answering an open question (#11), approving or requesting
 * changes on the current design round (#13), and — issue #110 — posting a
 * message to the thread. Every one of these is customer-only, exactly
 * as it was before #110 — an operator's half of the thread is a separate
 * route, `POST /leads/:id/message` (`src/routes/leads.ts`), not this one; see
 * `submissionDetail`'s module comment for why this route never reopens ms-1's
 * ownership scoping for an operator.
 *
 * One route, dispatched on an `action` field, because all four are the same
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
  const email = await resolveSiteIdentity(request, env)
  const submission = await getSubmission(env, id)
  // The `email === null` disjunct is redundant with `isOwnedBy` (which already
  // requires a non-null email) in every case it can actually happen — it is
  // here so the compiler, not just the reader, knows `email` is a `string`
  // below this guard, the same way `submissionRounds` above stays satisfied
  // with `isOwnedBy` alone because it never needs to hand `email` anywhere
  // that requires non-null.
  if (!submission || !isOwnedBy(submission, email) || email === null) {
    return notFoundResponse()
  }

  // Additive to the ownership check above, never a substitute for it — see
  // `submissionDetail`'s identical call for the full rationale (issue #103).
  const isOperator = isOperatorEmail(email, request, env)

  // `request.formData()` throws a raw `TypeError` — an unhandled 500 — when
  // the request carries no `Content-Type` at all, or one it can't parse as a
  // form (issue #46, and issue #71 for the two routes this reasoning missed:
  // a bot, a broken client, or a redirect replayed as a bare POST). That is a
  // malformed request, not a server error, and this refusal has to look
  // exactly like the ownership check just above it: a POST with no body
  // content-type gets the same 404 a non-owner gets, never a 5xx that would
  // tell a prober "the id exists, the body was just wrong."
  //
  // The content-type pre-check below only rules out the common case (no
  // header at all, or a plainly non-form one). It cannot rule out a
  // `multipart/form-data` header with a missing or malformed `boundary=` —
  // that still throws inside the actual parse. So the parse itself goes
  // through `parseFormData`, which turns that throw into `null`: any failure
  // there gets the same 404, not a 5xx.
  const contentType = request.headers.get("content-type") ?? ""
  if (!isFormContentType(contentType)) return notFoundResponse()

  const form = await parseFormData(request)
  if (!form) return notFoundResponse()
  const action = stringField(form, "action")

  if (action === "message") {
    return submitMessage(env, isOperator, submission, { role: "customer", email }, form)
  }

  if (action === "approve" || action === "request-changes") {
    return submitSignoff(env, email, isOperator, submission, action, form)
  }
  if (action === "approve-preview" || action === "request-preview-changes") {
    return submitPreviewReviewAction(env, email, isOperator, submission, action, form)
  }
  if (action === "confirm-relay") {
    return submitConfirmRelay(env, email, isOperator, submission)
  }
  return submitAnswer(env, email, isOperator, submission, form)
}

/**
 * Answering an open question (#11) — and, per issue #159, correcting a
 * relayed answer the customer already confirmed.
 *
 * The question being answered is derived from `getQuestionScreenState`, never
 * taken from the submitted form. Three of its four states may legally submit
 * this form: `open` (the ordinary case), `relay-pending` (the customer typed
 * over the pre-filled relay instead of confirming it — nothing has been
 * confirmed yet, so this is just an ordinary first answer) and
 * `relay-confirmed` (a correction, per issue #159's "reopen and correct").
 * `closed` — already answered by a previous submit, a race with a fresh
 * coordinator push, or a question that was never raised — re-renders the
 * current screen rather than silently accepting a stray write, exactly as
 * before this issue.
 */
async function submitAnswer(
  env: Env,
  email: string | null,
  isOperator: boolean,
  submission: Submission,
  form: FormData,
): Promise<Response> {
  const state =
    submission.status === "needs-input"
      ? await getQuestionScreenState(env, submission.reference)
      : ({ kind: "closed" } as const)

  if (state.kind === "closed") {
    const thread = { messages: await listMessages(env, submission.reference) }
    const main = await detailFor(env, email, isOperator, submission, thread)
    return html(page(`${submission.reference} — coord-portal`, main), { status: 409 })
  }

  const answer = stringField(form, "answer")
  if (!answer) {
    // "an empty answer does not end the pause": nothing is recorded, and the
    // same screen is redisplayed, composer open, so the customer's place is
    // kept — whichever of the three answerable states it was.
    const thread = { messages: await listMessages(env, submission.reference) }
    return html(
      page(
        `${submission.reference} — coord-portal`,
        questionScreenDetail(email, isOperator, submission, state, thread, {
          composerOpen: true,
          error: "Please write an answer before sending.",
        }),
      ),
      { status: 400 },
    )
  }

  if (state.kind === "relay-confirmed") {
    // Already confirmed once — this write supersedes that confirmation
    // rather than inserting a second row (`question_answers`' primary key is
    // per question revision, and a relay-confirm already claimed it).
    await correctRelayedAnswer(env, submission.reference, state.question.revision, answer)
  } else {
    await recordAnswer(env, submission.reference, state.question.revision, answer)
  }

  return new Response(null, {
    status: 303,
    headers: { location: `/submissions/${submission.id}` },
  })
}

/**
 * Confirming an operator-relayed answer — "Yes, that's right" (issue #159).
 *
 * Legal only from `relay-pending`: a relay that has already been confirmed,
 * corrected, or superseded by a newer question re-renders the current screen
 * with a 409, the same "stray write" refusal `submitAnswer` gives a stale
 * `closed` state — a double-tap (network retry, an impatient second click)
 * still lands here, but `confirmRelayedAnswer` is itself idempotent against
 * that, so this only fires for a genuinely stale submit (e.g. a second
 * browser tab that had the relay open before it was corrected in the first).
 */
async function submitConfirmRelay(
  env: Env,
  email: string | null,
  isOperator: boolean,
  submission: Submission,
): Promise<Response> {
  const state =
    submission.status === "needs-input"
      ? await getQuestionScreenState(env, submission.reference)
      : ({ kind: "closed" } as const)

  if (state.kind !== "relay-pending") {
    const thread = { messages: await listMessages(env, submission.reference) }
    const main = await detailFor(env, email, isOperator, submission, thread)
    return html(page(`${submission.reference} — coord-portal`, main), { status: 409 })
  }

  await confirmRelayedAnswer(env, submission.reference, state.question.revision, state.relay)

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
  isOperator: boolean,
  submission: Submission,
  action: "approve" | "request-changes",
  form: FormData,
): Promise<Response> {
  const current =
    submission.status === "awaiting-signoff" ? await getCurrentRound(env, submission.reference) : null

  if (!current || current.verdict !== "pending") {
    // Nothing is awaiting this customer's sign-off — already decided, superseded,
    // or the submission has moved on. Re-render what is actually true.
    const thread = { messages: await listMessages(env, submission.reference) }
    const main = await detailFor(env, email, isOperator, submission, thread)
    return html(page(`${submission.reference} — coord-portal`, main), { status: 409 })
  }

  if (action === "request-changes") {
    const comment = stringField(form, "changesComment") || stringField(form, "comment")
    if (!comment) {
      const thread = { messages: await listMessages(env, submission.reference) }
      return html(
        page(
          `${submission.reference} — coord-portal`,
          await awaitingSignoffDetail(env, email, isOperator, submission, current, thread, {
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

/**
 * Approving, or requesting changes on, the submission's current preview build
 * (#107). Mirrors `submitSignoff` above exactly, one decision swapped for
 * another: which preview URL is being decided comes from `submission.previewUrl`,
 * never from the form, and only when nobody has already reviewed that exact
 * URL — see `getCurrentPreviewReview`. A stale form (the operator queued a
 * new preview, or the customer already decided this one in another tab)
 * re-renders whatever is actually true rather than silently accepting a
 * decision on a build nobody is looking at anymore.
 *
 * A blank comment does not record anything, same as `submitSignoff`'s: the
 * composer is redisplayed, open, with the message.
 */
async function submitPreviewReviewAction(
  env: Env,
  email: string | null,
  isOperator: boolean,
  submission: Submission,
  action: "approve-preview" | "request-preview-changes",
  form: FormData,
): Promise<Response> {
  const previewUrl = submission.status === "quality-check" ? submission.previewUrl : null
  const current = previewUrl ? await getCurrentPreviewReview(env, submission.reference, previewUrl) : null

  if (!previewUrl || current) {
    const thread = { messages: await listMessages(env, submission.reference) }
    const main = await detailFor(env, email, isOperator, submission, thread)
    return html(page(`${submission.reference} — coord-portal`, main), { status: 409 })
  }

  if (action === "request-preview-changes") {
    const comment = stringField(form, "previewComment")
    if (!comment) {
      const thread = { messages: await listMessages(env, submission.reference) }
      return html(
        page(
          `${submission.reference} — coord-portal`,
          await previewReviewDetail(env, email, isOperator, submission, previewUrl, thread, {
            composerOpen: true,
            error: "Tell us what should change before submitting.",
          }),
        ),
        { status: 400 },
      )
    }
    await recordPreviewReview(env, submission.reference, previewUrl, "changes-requested", comment)
  } else {
    // Approving asks for no comment — same rule the design round's sign-off follows.
    await recordPreviewReview(env, submission.reference, previewUrl, "approved", null)
  }

  return new Response(null, {
    status: 303,
    headers: { location: `/submissions/${submission.id}` },
  })
}

/**
 * Posting a message (#110) — customer-only on this route (see
 * `submitSubmissionAction`'s module comment for the operator's separate
 * route). `actor.email` is `resolveSiteIdentity`'s reading, never taken from
 * the form: the same "who is speaking is derived server-side, never asserted
 * by the client" rule every other write on this route already follows.
 *
 * Purely additive — see `src/messages.ts`'s module comment for why this never
 * touches `submissions.status`, a design round or a signoff. A blank message
 * does not get sent: the current screen is redisplayed with an error and
 * nothing recorded — the same shape `submitAnswer`'s blank-answer branch
 * already uses.
 */
async function submitMessage(
  env: Env,
  isOperator: boolean,
  submission: Submission,
  actor: { role: MessageAuthorRole; email: string },
  form: FormData,
): Promise<Response> {
  const body = stringField(form, "body")
  if (!body) {
    const thread = {
      messages: await listMessages(env, submission.reference),
      error: "Write a message before sending.",
    }
    const main = await detailFor(env, actor.email, isOperator, submission, thread)
    return html(page(`${submission.reference} — coord-portal`, main), { status: 400 })
  }

  await postMessage(env, submission.reference, actor.role, actor.email, body)

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
 * A cheap pre-check for the two content types `request.formData()` might be
 * able to parse. Matched by prefix, not equality, so
 * `multipart/form-data; boundary=...` — which every real multipart POST
 * carries — still passes. This does not guarantee the parse will succeed
 * (a `multipart/form-data` header with a missing or malformed `boundary=`
 * still passes here and throws in `request.formData()`); that failure mode
 * is handled separately, by wrapping the parse itself in try/catch.
 *
 * Exported so `src/routes/leads.ts`'s `POST /leads/:id/message` (issue #110)
 * shares this exact check rather than a second copy of it.
 */
export function isFormContentType(contentType: string): boolean {
  const value = contentType.toLowerCase()
  return (
    value.startsWith("application/x-www-form-urlencoded") || value.startsWith("multipart/form-data")
  )
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
  const email = await resolveSiteIdentity(request, env)
  const submission = await getSubmission(env, id)
  if (!submission || !isOwnedBy(submission, email)) {
    return notFoundResponse()
  }

  const rounds = await listRounds(env, submission.reference)
  // Additive to the ownership check above, never a substitute for it — see
  // `submissionDetail`'s identical call for the full rationale (issue #103).
  const isOperator = isOperatorEmail(email, request, env)
  return html(
    page(
      `Round history — ${submission.reference} — coord-portal`,
      roundHistory(email, isOperator, submission, rounds),
    ),
  )
}

/**
 * The one ownership check a submission needs. `null` never owns anything — an
 * unidentified caller and a submission with no recorded customer (should one
 * ever exist) both fail closed, not open.
 *
 * Exported so `routes/mocks.ts`'s bundle route uses this exact check rather
 * than a second copy of it — a mock bundle is gated on the same fact as the
 * submission it belongs to, and two copies of "same fact" is how they drift.
 */
export function isOwnedBy(submission: Submission, email: string | null): boolean {
  return email !== null && submission.customerEmail === email
}

/** The one 404 every refusal on this route renders — see `submissionDetail`'s module comment. */
function notFoundResponse(): Response {
  return html(page("Not found — coord-portal", notFound()), { status: 404 })
}

/**
 * Dispatches to the one template `data-status` actually calls for. Every
 * branch renders the same `submission-detail` root and `status-pill` (the
 * hooks the contract pins as present "all statuses") — what changes below it
 * is what issue #10 says is allowed to change: the rollup timeline for the
 * four read-only states, the pinned copy for shipped; `needs-input`
 * additionally owns the question channel (#11) and `awaiting-signoff` the
 * design round (#13).
 *
 * `display` runs the stored status through `customerFacingStatus` first —
 * issue #74's collapse of `on-hold` into `in-progress` — the same shape
 * `derivedStatus` already uses for `awaiting-signoff` inside `signoffDetail`:
 * a customer-visible value distinct from, and computed from, what is
 * actually stored. Every other status passes through unchanged, so nothing
 * below this line needs to know the collapse happened at all.
 *
 * `thread` (issue #110) rides along unchanged through every branch: the
 * message thread is "purely informational alongside the existing structured
 * signoff/question flow" (see `src/messages.ts`), so it is rendered
 * identically regardless of which status template it lands inside — every
 * branch below appends it via `messageThreadSection`, the one exception being
 * `receipt` (the `describing` template), which does not: that screen's own
 * copy already tells the customer "No one is chatting with you right now,"
 * and a chat box under that sentence would contradict it.
 *
 * A `describing` submission is checked against `src/startWork.ts` first —
 * issue #132's operator override. A submission the operator has started work
 * on is still stored at `describing` (only the coordinator's own push moves
 * that column) but reads as `Planned` here, by the same derivation
 * `derivedStatus` already uses for an approved design round: `planned` is a
 * rollup status, so it gets that shared template, not the receipt.
 */
async function detailFor(
  env: Env,
  email: string | null,
  isOperator: boolean,
  submission: Submission,
  thread: ThreadContext,
): Promise<string> {
  if (submission.status === "describing") {
    const startWork = await getStartWork(env, submission.reference)
    const started = derivedStartWorkStatus(submission.status, startWork)
    if (started !== submission.status) {
      return rollupDetail(env, email, isOperator, submission, started, thread)
    }
    return receipt(email, isOperator, submission)
  }
  const display = customerFacingStatus(submission.status)
  if (display === "quality-check" && submission.previewUrl) {
    return qualityCheckDetail(env, email, isOperator, submission, thread)
  }
  if (isRollupStatus(display)) return rollupDetail(env, email, isOperator, submission, display, thread)
  if (display === "shipped") return shippedDetail(env, email, isOperator, submission, thread)
  if (display === "needs-input") return needsInputDetail(env, email, isOperator, submission, thread)
  return signoffDetail(env, email, isOperator, submission, thread)
}

/**
 * Every message-thread renderer's second half — the list (or empty state)
 * plus the composer — bundled with an optional composer error so
 * `submitMessage`'s blank-body redisplay does not need a fifth positional
 * parameter threaded through every status template between it and here.
 */
export interface ThreadContext {
  messages: Message[]
  error?: string
}

/**
 * The message thread (#110), appended to every status template except the
 * `describing` receipt — see `detailFor`'s module comment.
 *
 * `viewerRole` decides how each message's author is labelled
 * (`messageAuthorLabel`): this file only ever calls it with `"customer"`
 * (every caller is a customer-owned template — see `detailFor`), but the
 * function itself is shape-agnostic and exported so `src/routes/leads.ts`'s
 * operator-side thread on `/leads/:id` can reuse it with `"operator"` rather
 * than a second copy of this rendering.
 *
 * `viewerEmail` is the viewer's own actual identity — `resolveSiteIdentity`'s
 * email on the customer side, `readOperator`'s on the operator side — and is
 * what `messageAuthorLabel` actually compares a message's `authorEmail`
 * against to decide "You". `viewerRole` alone used to stand in for this and
 * was wrong whenever more than one identity can share a role: `OPERATOR_EMAILS`
 * (`src/operators.ts`) is explicitly a *list*, so two operators both get
 * `viewerRole === "operator"` and role-equality alone would label a
 * colleague's message "You". The customer side never had this bug —
 * `isOwnedBy` restricts a submission's thread to exactly one customer
 * identity, so role-equality and identity-equality happen to coincide there —
 * but both call sites now pass the real email so the comparison is identity,
 * not role, everywhere.
 *
 * `postUrl` is the only submission-specific thing this function needs — the
 * form posts back to whichever route rendered it, same as every other form in
 * this portal. Here that is always `/submissions/:id` (the shared
 * action-dispatcher, hence the hidden `action=message` field); on
 * `/leads/:id` it is the operator's own dedicated `POST /leads/:id/message`,
 * which has no dispatcher to feed and simply ignores the same hidden field.
 */
export function messageThreadSection(
  postUrl: string,
  thread: ThreadContext,
  viewerRole: MessageAuthorRole,
  viewerEmail: string | null,
): string {
  const errorBlock = thread.error
    ? `<p class="message-error" data-testid="message-error" role="alert">${escapeHtml(thread.error)}</p>`
    : ""
  const list =
    thread.messages.length > 0
      ? `<ul class="message-list" data-testid="message-list">
${thread.messages.map((message) => messageItem(message, viewerRole, viewerEmail)).join("\n")}
    </ul>`
      : `<p class="message-thread-empty" data-testid="message-thread-empty">No messages yet.</p>`

  return `  <section class="message-thread" data-testid="message-thread">
    <h2>Messages</h2>
    ${list}
    ${errorBlock}
    <form class="message-form" method="POST" action="${escapeHtml(postUrl)}" data-testid="message-form">
      <input type="hidden" name="action" value="message">
      <label for="messageBody" class="visually-hidden">Write a message</label>
      <textarea id="messageBody" name="body" rows="3" required
        data-testid="message-field" placeholder="Write a message&hellip;"></textarea>
      <div class="actions">
        <button type="submit" class="primary" data-testid="submit-message">Send message</button>
      </div>
    </form>
  </section>`
}

function messageItem(message: Message, viewerRole: MessageAuthorRole, viewerEmail: string | null): string {
  return `      <li class="message-item" data-testid="message-item" data-author-role="${message.authorRole}">
        <div class="message-meta">
          <span class="message-author" data-testid="message-author">${escapeHtml(messageAuthorLabel(message, viewerRole, viewerEmail))}</span>
          <span class="message-timestamp" data-testid="message-timestamp">${escapeHtml(message.createdAt)}</span>
        </div>
        <p class="message-body" data-testid="message-body">${escapeHtml(message.body)}</p>
      </li>`
}

/**
 * "You" for a message the viewer themself posted — compared by
 * `authorEmail`, the viewer's actual identity, not `authorRole`. Role alone
 * is not enough: `src/operators.ts`'s `OPERATOR_EMAILS` is a list, so two
 * different operators both carry `viewerRole === "operator"`, and comparing
 * roles would label a colleague's message "You" (see this function's call
 * site, `messageThreadSection`, for the full story).
 *
 * Otherwise: the business's name, never a personal address, for an
 * operator's message read by a *customer* — the same brand `SIGNATURE` in
 * `src/notifications.ts` closes every email with, and for the same reason an
 * operator's own address stays off a customer-facing screen. An operator
 * reading a colleague's message, or reading a customer's message, gets that
 * author's own email — the operator has to know which colleague or which
 * customer it came from, the way every other operator screen in this portal
 * already names them (`src/routes/leads.ts`'s `lead-contact-email`).
 *
 * Exported for the one pure-function unit test this file's rendering logic
 * gets — see `test/messages.test.ts` — the rest of this module's templates
 * are covered black-box, per this repo's testing tiers (CLAUDE.md).
 */
export function messageAuthorLabel(
  message: Message,
  viewerRole: MessageAuthorRole,
  viewerEmail: string | null,
): string {
  if (viewerEmail !== null && message.authorEmail === viewerEmail) return "You"
  if (message.authorRole === "operator" && viewerRole === "customer") return "Heuron Technology"
  return message.authorEmail
}

function statusPill(status: SubmissionStatus): string {
  return `<span class="status-pill" data-testid="status-pill" data-status="${escapeHtml(status)}">${escapeHtml(statusText(status))}</span>`
}

/** `submission-reference` outside the receipt template: reference plus when it was filed. */
function referenceLine(submission: Submission): string {
  return `<p class="meta" data-testid="submission-reference">${escapeHtml(submission.reference)} &middot; submitted ${escapeHtml(submission.createdAt)}</p>`
}

function receipt(email: string | null, isOperator: boolean, submission: Submission): string {
  return `${topbar(email, "none", isOperator)}
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
async function rollupDetail(
  env: Env,
  email: string | null,
  isOperator: boolean,
  submission: Submission,
  display: SubmissionStatus,
  thread: ThreadContext,
): Promise<string> {
  const current = currentTimelineStep(display)
  const steps = TIMELINE_STEPS.map((step) => {
    const currentAttr = step === current ? ' data-current="true"' : ""
    return `    <li data-testid="timeline-step" data-step="${step}"${currentAttr}>${escapeHtml(statusText(step))}</li>`
  }).join("\n")
  const events = await listLifecycleEvents(env, submission.reference)

  return `${topbar(email, "none", isOperator)}
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

  ${activityTimeline(events)}
  ${roundHistoryLink(submission)}

${messageThreadSection(`/submissions/${submission.id}`, thread, "customer", email)}
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

/* ────────────────────── the dev-lifecycle timeline (#111) ────────────────── */

/**
 * Kind slug -> the customer-visible text. Portal-owned, exactly the shape
 * `VERDICT_TEXT` (`src/rounds.ts`) already uses for a round's verdict: coord
 * names *what happened*, this side decides *what that is called* on a
 * customer's screen. Nothing here names an issue, a PR, a branch or a check
 * by anything but its plain-language meaning — see `src/lifecycle.ts`.
 */
const LIFECYCLE_EVENT_TEXT: Record<LifecycleEventKind, string> = {
  "work-started": "Development started",
  "review-opened": "In code review",
  "checks-passing": "Automated checks passing",
  "checks-attention": "Automated checks need attention",
  "preview-ready": "Preview available",
  merged: "Changes merged",
  deployed: "Deployed",
}

/**
 * The read-only timeline issue #111 asks for, "alongside the existing
 * design-round history" — one entry per lifecycle event the coordinator has
 * pushed, oldest first, so it reads as the story of the work rather than an
 * inbox. Renders nothing when coord has never pushed one: an empty "Activity"
 * card is a worse first impression than no card at all, the same call
 * `mockBundleSection` makes for a round with no mock yet.
 *
 * `preview-ready` is the only kind that ever carries a link — #107's
 * Cloudflare Pages build, already sanitised against issue #16's wall in
 * `src/lifecycle.ts` before it ever reaches storage, so this template does
 * not have to re-decide whether a URL is safe to print.
 */
function activityTimeline(events: LifecycleEvent[]): string {
  if (events.length === 0) return ""

  const items = events
    .map((event) => {
      const link =
        event.url !== null
          ? ` &middot; <a href="${escapeHtml(event.url)}" data-testid="activity-preview-link" target="_blank" rel="noopener noreferrer">View preview &rarr;</a>`
          : ""
      return `      <li data-testid="activity-entry" data-kind="${escapeHtml(event.kind)}">
        <span class="activity-label">${escapeHtml(LIFECYCLE_EVENT_TEXT[event.kind])}</span>
        <span class="activity-date">${escapeHtml(event.occurredAt)}</span>${link}
      </li>`
    })
    .join("\n")

  return `  <section class="card activity-timeline" data-testid="activity-timeline">
    <h2>Activity</h2>
    <ul class="activity-list">
${items}
    </ul>
  </section>
`
}

/**
 * "Start a follow-up" — issue #109's one deliberate trigger for a project:
 * a signed-in customer choosing, on a submission they already own, to file
 * another one that shares its history. Links to `/intake?from=<id>`, which
 * `routes/intake.ts` treats as ordinary unless it can confirm `isOwnedBy`
 * against this exact submission — the same check this screen itself already
 * passed to render at all.
 *
 * Rendered only on `shipped`: that is the one state where "the team is done
 * with this and the customer might want more" is actually true. Every other
 * template already has the customer's attention on something live — a round
 * to decide, a question to answer, work in flight — and a second
 * call-to-action there would compete with it rather than the (still empty)
 * `describing` receipt, which has nothing yet to be a follow-up *to*.
 */
function followUpLink(submission: Submission): string {
  return `<p class="follow-up-aside"><a href="/intake?from=${encodeURIComponent(submission.id)}" data-testid="start-follow-up">Start a follow-up request</a></p>`
}

/**
 * `awaiting-signoff` with no round to sign off, and `needs-input` with no open
 * question: customer-actionable per the pinned vocabulary table, but with
 * nothing yet to act on. Renders the pill and reference and deliberately
 * nothing that asks the customer for anything — an affordance with no proposal
 * behind it is worse than no affordance.
 */
async function actionableDetail(
  env: Env,
  email: string | null,
  isOperator: boolean,
  submission: Submission,
  thread: ThreadContext,
): Promise<string> {
  const events = await listLifecycleEvents(env, submission.reference)
  return `${topbar(email, "none", isOperator)}
<main data-testid="submission-detail" data-status="${escapeHtml(submission.status)}">
  ${statusPill(submission.status)}
  <h1>${escapeHtml(titleOf(submission))}</h1>
  ${referenceLine(submission)}

  <section class="card">
    <p>We'll email you the moment this is ready to look at.</p>
  </section>

  ${activityTimeline(events)}

${messageThreadSection(`/submissions/${submission.id}`, thread, "customer", email)}
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
  isOperator: boolean,
  submission: Submission,
  thread: ThreadContext,
): Promise<string> {
  const current = await getCurrentRound(env, submission.reference)
  if (!current) return actionableDetail(env, email, isOperator, submission, thread)

  const display = derivedStatus(submission.status, { round: current.round, verdict: current.verdict })
  if (display !== "awaiting-signoff") {
    return rollupDetail(env, email, isOperator, submission, display, thread)
  }

  return awaitingSignoffDetail(env, email, isOperator, submission, current, thread)
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
 * screen that stops working when script does.
 *
 * The checkbox itself, not the labels, is the keyboard's tab stop
 * (`aria-label` gives it a name, since it has no visible text of its own).
 * That is deliberate, not incidental: a `<label>` given `role="button"` and
 * `tabindex="0"` gains no native Enter/Space-to-activate behaviour — that
 * translation from keydown to a click is built into native interactive
 * elements (`button`, `a[href]`, form controls) and otherwise only exists if
 * script adds it, which this composer does not have. A real checkbox gets
 * Space-to-toggle for free from the browser, zero script required, so it — not
 * a label wearing a button costume — is what a keyboard-only user actually
 * reaches. The two labels stay exactly as `mocks/05` and `06` pin them and
 * keep working by click (the native `for` association needs neither tabindex
 * nor focus) and keep `role="button"` for a screen-reader's own browse-mode
 * "activate" affordance, which does not depend on tab focus either. See the
 * `:focus-visible` rule on `.composer-toggle` in `src/render.ts` for how the
 * visible label still shows a focus ring even though it is the hidden
 * checkbox that is actually focused.
 *
 * `checked` is also settable from the server, which is how a rejected blank
 * comment comes back with the composer still open and the customer's place
 * kept.
 */
async function awaitingSignoffDetail(
  env: Env,
  email: string | null,
  isOperator: boolean,
  submission: Submission,
  round: DesignRound,
  thread: ThreadContext,
  state: ComposerState = {},
): Promise<string> {
  const next = round.round + 1
  const checked = state.composerOpen ? " checked" : ""
  const errorBlock = state.error
    ? `<p class="composer-error" data-testid="changes-error" role="alert">${escapeHtml(state.error)}</p>`
    : ""
  const events = await listLifecycleEvents(env, submission.reference)

  return `${topbar(email, "none", isOperator)}
<main data-testid="submission-detail" data-status="awaiting-signoff">
  ${statusPill("awaiting-signoff")}
  <h1>${escapeHtml(titleOf(submission))}</h1>
  ${referenceLine(submission)}

  <input class="composer-toggle" type="checkbox" id="request-changes-toggle" aria-label="Request changes"${checked}>

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
      <label class="secondary" role="button" for="request-changes-toggle" data-testid="request-changes-button">Request changes</label>
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
      <label class="ghost" role="button" for="request-changes-toggle" data-testid="cancel-changes">Cancel</label>
      <button type="submit" class="primary" data-testid="submit-changes">Submit changes</button>
    </div>
  </form>

  ${activityTimeline(events)}

${messageThreadSection(`/submissions/${submission.id}`, thread, "customer", email)}
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

/* ─────────────────────── the pre-merge preview gate (#107) ─────────────── */

/**
 * `quality-check` with a preview queued — issue #107.
 *
 * Three outcomes, the same shape `signoffDetail` above already uses for the
 * design-round loop, and none of them a write to `submissions.status`:
 *
 *   no review yet on this exact URL  -> the preview, with Approve / Request changes.
 *   changes requested                -> `In progress`. Nothing is left to look
 *                                        at until a new preview lands.
 *   approved                         -> the ordinary read-only `quality-check`
 *                                        card. Approving does not move the
 *                                        submission anywhere by itself — the
 *                                        operator's merge and eventual
 *                                        `shipped` push are separate, manual
 *                                        steps (design doc, "this issue does
 *                                        not automate that step").
 *
 * `qualityCheckDetail` is only ever reached once `submission.previewUrl` is
 * set (see `detailFor`'s dispatch) — a `quality-check` submission with no
 * preview queued yet falls through to the ordinary rollup template instead,
 * the same "an affordance with no proposal behind it is worse than no
 * affordance" call `actionableDetail` already makes for the sign-off loop.
 */
async function qualityCheckDetail(
  env: Env,
  email: string | null,
  isOperator: boolean,
  submission: Submission,
  thread: ThreadContext,
): Promise<string> {
  const previewUrl = submission.previewUrl
  if (!previewUrl) return rollupDetail(env, email, isOperator, submission, "quality-check", thread)

  const current = await getCurrentPreviewReview(env, submission.reference, previewUrl)
  if (!current) return previewReviewDetail(env, email, isOperator, submission, previewUrl, thread)

  const display = derivedQualityCheckStatus(submission.status, { verdict: current.verdict })
  return rollupDetail(env, email, isOperator, submission, display, thread)
}

interface PreviewComposerState {
  /** Re-open the request-changes composer server-side after a rejected submit. */
  composerOpen?: boolean
  error?: string
}

/**
 * The preview-review screen and its request-changes composer — deliberately
 * "the same UI shape as the existing design-round signoff, not a new
 * interaction pattern" (design doc): the disclosure mechanism, the CSS
 * classes and the keyboard behaviour are exactly `awaitingSignoffDetail`'s
 * (see that function's doc comment for why the toggle is a real checkbox and
 * not a `<label role="button">` alone). Only the content — a link to the real
 * build instead of a mock, no round number, no decomposition — differs.
 */
async function previewReviewDetail(
  env: Env,
  email: string | null,
  isOperator: boolean,
  submission: Submission,
  previewUrl: string,
  thread: ThreadContext,
  state: PreviewComposerState = {},
): Promise<string> {
  const checked = state.composerOpen ? " checked" : ""
  const errorBlock = state.error
    ? `<p class="composer-error" data-testid="preview-changes-error" role="alert">${escapeHtml(state.error)}</p>`
    : ""
  const events = await listLifecycleEvents(env, submission.reference)

  return `${topbar(email, "none", isOperator)}
<main data-testid="submission-detail" data-status="quality-check">
  ${statusPill("quality-check")}
  <h1>${escapeHtml(titleOf(submission))}</h1>
  ${referenceLine(submission)}

  <input class="composer-toggle" type="checkbox" id="request-preview-changes-toggle" aria-label="Request changes"${checked}>

  <section class="round-card" data-testid="preview-review" data-verdict="pending">
    <div class="round-head">
      <span class="round-badge" data-testid="preview-badge">Preview build</span>
    </div>

    <h2>Take a look</h2>
    <p>This is the real, live build — what you approve here is what ships.</p>
    <a class="mock-bundle-link" href="${escapeHtml(previewUrl)}" data-testid="preview-link"
       target="_blank" rel="noopener noreferrer">
      Open the preview &rarr;
    </a>

    <div class="round-actions">
      <form method="POST" action="/submissions/${submission.id}" class="inline-form">
        <input type="hidden" name="action" value="approve-preview">
        <button type="submit" class="primary" data-testid="approve-preview-button">Approve</button>
      </form>
      <label class="secondary" role="button" for="request-preview-changes-toggle" data-testid="request-preview-changes-button">Request changes</label>
    </div>
  </section>

  <form class="composer" method="POST" action="/submissions/${submission.id}"
        data-testid="request-preview-changes-form" aria-label="Request changes to the preview">
    <input type="hidden" name="action" value="request-preview-changes">
    <h2>What should change?</h2>
    <p class="hint">Your notes go straight to the team, and this moves back to <strong>In progress</strong> until a new preview is ready.</p>
    ${errorBlock}
    <label for="previewComment" class="visually-hidden">Requested changes</label>
    <textarea id="previewComment" name="previewComment" rows="5" required
      data-testid="preview-comment"
      placeholder="Tell us what to change and why."></textarea>
    <div class="actions">
      <label class="ghost" role="button" for="request-preview-changes-toggle" data-testid="cancel-preview-changes">Cancel</label>
      <button type="submit" class="primary" data-testid="submit-preview-changes">Submit changes</button>
    </div>
  </form>

  ${activityTimeline(events)}

${messageThreadSection(`/submissions/${submission.id}`, thread, "customer", email)}
</main>`
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
  isOperator: boolean,
  submission: Submission,
  rounds: DesignRound[],
): string {
  const body =
    rounds.length > 0
      ? rounds.map(roundEntry).join("\n")
      : `    <p class="lede">No design round has been published for this request yet.</p>`

  return `${topbar(email, "none", isOperator)}
<main>
  <a class="back-link" href="/submissions/${submission.id}" data-testid="back-to-submission">&larr; ${escapeHtml(titleOf(submission))}</a>
  <h1>Round history</h1>
  <p class="meta" data-testid="submission-reference">${escapeHtml(submission.reference)}</p>

  <div data-testid="round-history">
${body}
  </div>
</main>`
}

/**
 * One round, rendered as `mocks/07-round-history.html` pins it — badge,
 * verdict pill, opened date, what-we-understood, decomposition and (only on
 * a `changes-requested` round) the customer's own comment.
 *
 * Exported so `routes/project.ts`'s combined timeline (issue #109) reuses
 * this exact markup per submission rather than a second copy of it — the
 * same reasoning `isOwnedBy` above is exported for.
 */
export function roundEntry(round: DesignRound): string {
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
 * `needs-input` — issue #11's question channel, extended by issue #159's
 * relayed-answer confirmation.
 *
 * `question` arrives coord-owned, in the same push that sets
 * `status: needs-input` (contract § Question channel), and stays in
 * `coord_facts` at whatever revision the daemon last wrote it — see
 * `src/questions.ts`. Which of the four screens renders is exactly
 * `getQuestionScreenState`'s read: `closed` falls back to `actionableDetail`'s
 * quiet "nothing to do" card — "a submission with no open question offers no
 * answer channel" is a black-box guarantee predating this issue, and it stays
 * true for `relay-confirmed` too once a correction has landed (correcting
 * flips the row's `source` back to `'client'`, which is indistinguishable
 * from an ordinary answered question — see `getQuestionScreenState`).
 */
async function needsInputDetail(
  env: Env,
  email: string | null,
  isOperator: boolean,
  submission: Submission,
  thread: ThreadContext,
): Promise<string> {
  const state = await getQuestionScreenState(env, submission.reference)
  if (state.kind === "closed") return actionableDetail(env, email, isOperator, submission, thread)
  return questionScreenDetail(email, isOperator, submission, state, thread)
}

interface AnswerComposerState {
  /** Re-open the answer composer server-side after a rejected submit. */
  composerOpen?: boolean
  error?: string
}

/**
 * Dispatches the three answerable `QuestionScreenState`s to their template —
 * the one place `submitAnswer`'s blank-answer redisplay and
 * `needsInputDetail`'s fresh `GET` share, so both always agree on which
 * template a given state renders as.
 */
function questionScreenDetail(
  email: string | null,
  isOperator: boolean,
  submission: Submission,
  state: Exclude<QuestionScreenState, { kind: "closed" }>,
  thread: ThreadContext,
  composer: AnswerComposerState = {},
): string {
  if (state.kind === "open") {
    return pausedDetail(email, isOperator, submission, state.question, thread, composer.error)
  }
  const confirmed = state.kind === "relay-confirmed" ? { answer: state.answer, answeredAt: state.answeredAt } : undefined
  return relayedAnswerDetail(
    email,
    isOperator,
    submission,
    state.question,
    state.relay,
    thread,
    composer,
    confirmed,
  )
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
 *
 * The message thread (`messageThreadSection`, issue #110) still renders here,
 * and that is not the same "other customer action" the contract's "no other
 * customer action... while a question is open" rules out — that guarantee is
 * about a second *decision* surface (the sign-off screen's approve /
 * request-changes affordances leaking onto a paused submission, per
 * `tests/acceptance/ms-1/11-question-channel.spec.ts`'s
 * `OTHER_ACTION_TESTIDS`), not about silence. A chat message never advances or
 * blocks anything (`src/messages.ts`), so it is not one of the two decisions
 * the pause exists to keep the customer from being asked for at once.
 */
function pausedDetail(
  email: string | null,
  isOperator: boolean,
  submission: Submission,
  question: OpenQuestion,
  thread: ThreadContext,
  error?: string,
): string {
  const errorBlock = error
    ? `<p class="async-note" data-testid="answer-error" role="alert">${escapeHtml(error)}</p>`
    : ""

  return `${topbar(email, "none", isOperator)}
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

${messageThreadSection(`/submissions/${submission.id}`, thread, "customer", email)}
</main>`
}

/** The stated relay source, in the plain-language form this screen shows the customer. */
const RELAY_SOURCE_TEXT: Record<RelayedAnswer["source"], string> = {
  verbal: "in person",
  phone: "on a call",
  email: "by email",
}

/**
 * The relay-confirm screen — issue #159. Renders where `pausedDetail`'s
 * ordinary composer would, for both of the two states that carry a
 * `RelayedAnswer` matching the currently open question:
 *
 *   unconfirmed (`confirmed` unset) — the relayed text is shown framed as a
 *   claim, not a fact ("We recorded this ... — is that right?"), with two
 *   one-tap paths: "Yes, that's right" posts `action=confirm-relay`
 *   (`submitConfirmRelay` -> `confirmRelayedAnswer`), which is the only
 *   control on this whole portal that ends a pause without the customer
 *   writing a word. "Not quite — let me correct it" reveals the ordinary
 *   answer composer — same `answer-field` / `submit-answer` hooks
 *   `pausedDetail` uses — pre-filled with the relayed text so fixing one
 *   wrong sentence does not mean re-typing the whole thing. That composer
 *   posts the same `action=answer` field `pausedDetail`'s does, and
 *   `submitAnswer` handles it with plain `recordAnswer`: nothing has been
 *   confirmed yet, so there is nothing to supersede — it is just an ordinary
 *   first answer that happens to start from someone else's draft.
 *
 *   confirmed (`confirmed` set) — reached only because `needsInputDetail`
 *   checked for exactly this: `getOpenQuestion` would say this question is
 *   answered (`question_answers` already has a row), which is normally
 *   `actionableDetail`'s quiet "nothing to do" card. Issue #159's "a client
 *   can reopen and correct after confirming" is why this screen renders
 *   instead — the relay stays visible, now labelled as confirmed, with the
 *   same "Not quite" disclosure still live. Submitting it here reaches
 *   `submitAnswer` with `state.kind === "relay-confirmed"`, which calls
 *   `correctRelayedAnswer` (an `UPDATE`, not an `INSERT` — the row already
 *   exists) instead of `recordAnswer`.
 *
 * `relayed-answer`'s `data-confirmed` attribute, plus the label copy itself,
 * is the acceptance criterion made literal: "an unconfirmed relayed answer
 * ... visually distinguishable from a client-authored answer" and "must never
 * render as the client's own" — nothing on this screen, in either state,
 * presents the relayed text as though the customer had typed it.
 */
function relayedAnswerDetail(
  email: string | null,
  isOperator: boolean,
  submission: Submission,
  question: OpenQuestion,
  relay: RelayedAnswer,
  thread: ThreadContext,
  composer: AnswerComposerState,
  confirmed?: { answer: string; answeredAt: string },
): string {
  const checked = composer.composerOpen ? " checked" : ""
  const errorBlock = composer.error
    ? `<p class="async-note" data-testid="answer-error" role="alert">${escapeHtml(composer.error)}</p>`
    : ""
  const prefill = confirmed ? confirmed.answer : relay.answer
  const sourceText = RELAY_SOURCE_TEXT[relay.source]

  const label = confirmed
    ? `You confirmed this answer on ${escapeHtml(confirmed.answeredAt)}.`
    : `We recorded this ${escapeHtml(sourceText)} on ${escapeHtml(relay.relayedAt)} — is that right?`

  const confirmForm = confirmed
    ? ""
    : `      <form method="POST" action="/submissions/${submission.id}" class="inline-form">
        <input type="hidden" name="action" value="confirm-relay">
        <button type="submit" class="primary" data-testid="confirm-relay-button">Yes, that's right</button>
      </form>
`

  return `${topbar(email, "none", isOperator)}
<main data-testid="submission-detail" data-status="${escapeHtml(submission.status)}">
  ${statusPill(submission.status)}
  <h1>${escapeHtml(titleOf(submission))}</h1>
  ${referenceLine(submission)}

  ${confirmed ? "" : `<p class="pause-banner" data-testid="pause-banner">Work is paused until you answer.</p>`}

  <input class="composer-toggle" type="checkbox" id="correct-relay-toggle" aria-label="Correct this answer"${checked}>

  <section class="round-card relayed-answer" data-testid="relayed-answer" data-confirmed="${confirmed ? "true" : "false"}">
    <div class="round-head">
      <span class="round-badge" data-testid="relayed-answer-badge">Relayed answer</span>
    </div>

    <h2>The question</h2>
    <p class="question-text" data-testid="question-text">${escapeHtml(questionText(question.value))}</p>

    <h2>What we recorded</h2>
    <p class="relayed-answer-label">${label}</p>
    <p class="relayed-answer-text" data-testid="relayed-answer-text">${escapeHtml(relay.answer)}</p>
    <p class="relayed-answer-meta" data-testid="relayed-answer-meta">
      Recorded <span data-testid="relayed-answer-source">${escapeHtml(sourceText)}</span> on
      <span data-testid="relayed-answer-date">${escapeHtml(relay.relayedAt)}</span>
    </p>

    <div class="round-actions">
${confirmForm}      <label class="secondary" role="button" for="correct-relay-toggle" data-testid="correct-relay-button">Not quite &mdash; let me correct it</label>
    </div>
  </section>

  <form class="composer answer-form" method="POST" action="/submissions/${submission.id}" data-testid="answer-form">
    <input type="hidden" name="action" value="answer">
    <h2>Your answer</h2>
    ${errorBlock}
    <label for="answer" class="visually-hidden">Your answer</label>
    <textarea id="answer" name="answer" rows="4" required
      data-testid="answer-field"
      placeholder="Write your answer here.">${escapeHtml(prefill)}</textarea>
    <div class="actions">
      <label class="ghost" role="button" for="correct-relay-toggle" data-testid="cancel-correct-relay">Cancel</label>
      <button type="submit" class="primary" data-testid="submit-answer">Send answer</button>
    </div>
  </form>

${messageThreadSection(`/submissions/${submission.id}`, thread, "customer", email)}
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

/** `shipped` — terminal, per `mocks/10-submission-shipped.html`. */
async function shippedDetail(
  env: Env,
  email: string | null,
  isOperator: boolean,
  submission: Submission,
  thread: ThreadContext,
): Promise<string> {
  const events = await listLifecycleEvents(env, submission.reference)
  return `${topbar(email, "none", isOperator)}
<main data-testid="submission-detail" data-status="${escapeHtml(submission.status)}">
  ${statusPill(submission.status)}
  <h1>${escapeHtml(titleOf(submission))}</h1>
  ${referenceLine(submission)}

  <section class="card">
    <p data-testid="shipped-copy">This is live. Thanks for working through the design with us.</p>
    <a class="button primary" href="#" data-testid="shipped-link">View the result &rarr;</a>
  </section>

  ${activityTimeline(events)}
  ${roundHistoryLink(submission)}
  ${followUpLink(submission)}

${messageThreadSection(`/submissions/${submission.id}`, thread, "customer", email)}
</main>`
}

function notFound(): string {
  return `<main>
  <h1>We can't find that request</h1>
  <p class="lede">It may have been submitted somewhere else, or the link is wrong.</p>
</main>`
}
