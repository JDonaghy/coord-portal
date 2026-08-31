import { getClientRecordByCcEmail, getClientRecordByEmail } from "../clients"
import { parseFormData } from "../formData"
import {
  getInboundEmailByOutboxId,
  getInboundEmailsByOutboxIds,
  retargetInboundEmailStatement,
  type InboundEmailRecord,
  type InboundRetarget,
} from "../inboundEmail"
import { getLead, leadCreationStatement, mintLead } from "../leads"
import {
  approveReplyDraft,
  discardReplyDraft,
  getPendingReplyDraft,
  intakeReplyContent,
  listPendingReplyDrafts,
  pendingDraftGuard,
  redraftReplyStatement,
  routedReplyContent,
  type ReplyDraft,
} from "../notifications"
import { readOperator, type Operator } from "../operators"
import { getProject, listProjectsForClient } from "../projects"
import { escapeHtml, html, operatorTopbar, page } from "../render"
import { getNewestSubmissionForProject } from "../submissions"
import type { Env } from "../types"
import { leadsNotFound, projectTitleFromNewest } from "./leads"
import { isFormContentType } from "./submission"

/**
 * `/replies` — issue #166 (EM-6 of milestone #5, epic #160). "The gate becomes
 * operable."
 *
 * Everything before this issue could *hold* a drafted reply and nothing could
 * let it go. `migrations/0021_outbox_approval.sql` (EM-2) made "waiting for a
 * human" representable and unsendable; EM-4 and EM-5 started writing rows in
 * that state for every inbound message that earns an answer. Until this route
 * existed, every one of them was stuck there forever — a queue with no door.
 * This is the door: read the message, read why the router placed it where it
 * did, fix the draft's typos, and either send it, bin it, or tell the router
 * it was wrong.
 *
 * ── AUTH: NOT A NEW MECHANISM ────────────────────────────────────────────────
 * The same `readOperator` gate and the same indistinguishable 404
 * (`leadsNotFound()`) `/leads` and `/deliveries` already use — issue #166's
 * own words, "no new auth mechanism, no new env var". A non-operator, an
 * anonymous caller, and (behind Cloudflare's edge with no `OPERATOR_EMAILS`
 * configured) everyone alike get the customer-facing "we can't find that"
 * page, never a 403 or a login redirect that would confirm the surface exists.
 * See `src/operators.ts`.
 *
 * ── WHY THIS IS NOT AN EXTENSION OF `/deliveries` ────────────────────────────
 * `src/routes/deliveries.ts` was built read-only on purpose, and its own
 * module comment argues at length against parameterising one rendering path
 * with an `isOperator` flag — "a single place that can pass the wrong value
 * and leak provider internals onto a customer's screen." Adding writes there
 * would also silently amend an approved contract from a different milestone
 * (ms-3 pins `failed` as terminal with no path back and no button on that
 * screen). So this is a separate route with its own rendering, its own reads
 * (`listPendingReplyDrafts`, `src/notifications.ts`) and its own writes.
 * Nothing here imports anything `/deliveries` renders with.
 *
 * ── WHAT THIS SCREEN IS ALLOWED TO SHOW ──────────────────────────────────────
 * The inbound message verbatim and unredacted — sender address, display name,
 * subject, body, DMARC verdict. That is not a customer-safety boundary being
 * crossed: the message was addressed to this business, and an operator
 * deciding whether to approve a reply has to be able to read what it replies
 * to. Same posture `/deliveries` already established for `delivery-recipient`
 * and `delivery-last-error`.
 *
 * ── EVERY WRITE IS GUARDED ───────────────────────────────────────────────────
 * `WHERE id = ? AND approval_state = 'pending'`, on all four actions — issue
 * #166's own rule, and the convention `src/drain.ts` and `src/leads.ts`'s
 * promotion batch already hold to throughout. A double-clicked "Approve &
 * send" converges on one send; a route form replayed against a row a second
 * tab already discarded moves nothing. See `pendingDraftGuard`
 * (`src/notifications.ts`) for how the two actions that write *other* tables
 * carry the same predicate.
 *
 * ── THE FOURTH ACTION ────────────────────────────────────────────────────────
 * "Promote to a submission" is EM-7 (issue #167), not this issue. The form is
 * rendered here — the Gate-A contract pins its presence and its
 * `data-routed-kind` rule on this screen — but `POST /replies/:id/promote`
 * has no handler yet and gets the same 404 every other unsupported method on
 * this surface does, until EM-7 lands it.
 */

const REPLIES_PATH = "/replies"
const REPLY_PATH = /^\/replies\/([^/?#]+)$/
const REPLY_APPROVE_PATH = /^\/replies\/([^/?#]+)\/approve$/
const REPLY_DISCARD_PATH = /^\/replies\/([^/?#]+)\/discard$/
const REPLY_ROUTE_PATH = /^\/replies\/([^/?#]+)\/route$/
const REPLIES_PREFIX = /^\/replies(\/|$)/

/**
 * What `handlePages` needs to know about a `/replies…` URL, or `null`.
 *
 * `{ kind: "other" }` is the catch-all for every `/replies…` path this route
 * does not answer — EM-7's `/promote`, a typo, a method this surface has no
 * handler for. Owned here rather than left to fall through to
 * `env.ASSETS.fetch`, for the same reason `matchLeadsPath` claims every
 * `/leads…` path: falling through would hand an unauthenticated caller the
 * static site's own response for a path this contract says is operator-only.
 */
export function matchRepliesPath(
  pathname: string,
):
  | { kind: "index" }
  | { kind: "detail"; id: string }
  | { kind: "approve"; id: string }
  | { kind: "discard"; id: string }
  | { kind: "route"; id: string }
  | { kind: "other" }
  | null {
  if (pathname === REPLIES_PATH) return { kind: "index" }

  const approve = pathname.match(REPLY_APPROVE_PATH)
  if (approve?.[1]) return { kind: "approve", id: approve[1] }

  const discard = pathname.match(REPLY_DISCARD_PATH)
  if (discard?.[1]) return { kind: "discard", id: discard[1] }

  const route = pathname.match(REPLY_ROUTE_PATH)
  if (route?.[1]) return { kind: "route", id: route[1] }

  const detail = pathname.match(REPLY_PATH)
  if (detail?.[1]) return { kind: "detail", id: detail[1] }

  return REPLIES_PREFIX.test(pathname) ? { kind: "other" } : null
}

// ── THE READ MODEL ───────────────────────────────────────────────────────────

/**
 * One drafted reply, joined to the message it answers and to whatever the
 * router (or an operator) attached it to.
 *
 * `target` is plain display text — a project's title, or a `LEAD-XXXXXX`
 * reference — never an id and never a link. The contract is explicit about the
 * "never a link" half and gives `promotedReference`'s (`src/routes/leads.ts`)
 * own reasoning for it: an operator's Access identity is not a customer's, so
 * a link into a customer-scoped page would 404 for the person clicking it
 * about as often as it would work.
 */
interface ReplyView {
  draft: ReplyDraft
  inbound: InboundEmailRecord
  target: string | null
}

/**
 * A project this message could be re-routed onto, and the newest submission on
 * it that a re-routed draft's call to action would land on.
 *
 * Only ever the sender's own client's projects — never a free-choice picker
 * over every project in the database. Re-routing is "this match is wrong,
 * here is the right one for *this person*", not a general move tool, and
 * scoping the options to one client is the same restraint `postLeadReassign`
 * already applies to its own sibling list ("a request cannot name a project
 * outside this client").
 */
interface RoutingCandidate {
  projectId: string
  title: string
  submissionId: string
  submissionReference: string
}

/**
 * The candidate projects `/replies/:id`'s routing panel offers, and
 * `POST /replies/:id/route` validates a submitted `target` against.
 *
 * Derived from the sender's own `clients` row (direct address first, then
 * `cc_emails` — the same two lookups, in the same order, EM-3's rungs 3/4 use)
 * rather than stored anywhere: the router "writes nothing" beyond its decision
 * (`src/inboundRouter.ts`), so there is no recorded candidate list to read
 * back, and re-deriving it means an operator opening this screen tomorrow sees
 * the projects that exist tomorrow, not the ones that existed when the message
 * arrived.
 *
 * Two exclusions, both deliberate:
 *  - the project this row is *already* attached to, so the panel only ever
 *    offers a genuine change (mock 03's "no other project on file" note is
 *    exactly this list coming back empty for a single-project client);
 *  - a project with no submission at all, which has no thread for a re-routed
 *    draft's call to action to land on. Same skip `candidatesFromProjects`
 *    (`src/inboundRouter.ts`) already makes for the same reason.
 *
 * A sender with no `clients` row gets an empty list — including EM-3's rung-5
 * case (wrote in before, never backfilled a client). They keep the "become a
 * lead instead" option, which is the one re-route that needs no candidate at
 * all. Widening this to that sender's own historical projects would mean
 * reaching into `candidatesFromHistory`, which `src/inboundRouter.ts` keeps
 * private to its own ladder; it is a legitimate later refinement, not
 * something this issue's own text or the contract asks for.
 */
async function routingCandidates(env: Env, inbound: InboundEmailRecord): Promise<RoutingCandidate[]> {
  if (inbound.routedKind === "lead") return []

  const client =
    (await getClientRecordByEmail(env, inbound.fromEmail)) ??
    (await getClientRecordByCcEmail(env, inbound.fromEmail))
  if (client === null) return []

  const candidates: RoutingCandidate[] = []
  for (const project of await listProjectsForClient(env, client.id)) {
    if (project.id === inbound.routedProjectId) continue
    const newest = await getNewestSubmissionForProject(env, project.id)
    if (newest === null) continue
    candidates.push({
      projectId: project.id,
      title: projectTitleFromNewest(project, newest),
      submissionId: newest.id,
      submissionReference: newest.reference,
    })
  }
  return candidates
}

/**
 * The plain-text name of whatever this row is attached to — `reply-route-target`
 * and the badge both read it.
 *
 * `null` for an `unrouted` row, which is the whole point of that outcome:
 * nothing was decided confidently enough to name. A `message` row prefers its
 * project's title and falls back to the `SUB-XXXXXX` reference for a one-off
 * request with no project (EM-3's rungs 1 and 2 can both land there). A `lead`
 * row names the `LEAD-XXXXXX` reference the sender was told to quote back —
 * the same string rung 2 reads out of a follow-up email.
 */
async function targetOf(env: Env, inbound: InboundEmailRecord): Promise<string | null> {
  if (inbound.routedKind === "lead") {
    if (inbound.routedLeadId === null) return null
    const lead = await getLead(env, inbound.routedLeadId)
    return lead?.reference ?? null
  }
  if (inbound.routedKind !== "message") return null
  if (inbound.routedProjectId !== null) {
    const project = await getProject(env, inbound.routedProjectId)
    if (project !== null) {
      const newest = await getNewestSubmissionForProject(env, project.id)
      return projectTitleFromNewest(project, newest)
    }
  }
  return inbound.routedSubmissionId
}

// ── GET /replies ─────────────────────────────────────────────────────────────

/**
 * Every pending draft, newest first — the queue.
 *
 * Pending-only, and a row disappears the moment it is approved or discarded
 * (Gate-A contract § Notes item 2: EM-6's own "pending row" framing). Where a
 * sent one ends up afterwards is `/deliveries`' question, not this screen's.
 */
export async function repliesInbox(request: Request, env: Env): Promise<Response> {
  const operator = await readOperator(request, env)
  if (!operator) return leadsNotFound()

  const drafts = await listPendingReplyDrafts(env)
  const inbounds = await getInboundEmailsByOutboxIds(env, drafts.map((draft) => draft.id))

  const views: ReplyView[] = []
  for (const draft of drafts) {
    const inbound = inbounds.get(draft.id)
    if (inbound === undefined) continue
    views.push({ draft, inbound, target: await targetOf(env, inbound) })
  }

  return html(page("Replies — coord-portal", repliesPage(operator, views)))
}

function repliesPage(operator: Operator, views: ReplyView[]): string {
  return `${operatorTopbar(operator.email, "replies")}
<main>
  <div class="page-head">
    <h1>Replies</h1>
  </div>
  <p class="lede">Every drafted reply the inbound mailbox has produced, waiting on you before it sends. Nothing here goes out until you approve it.</p>
  ${views.length > 0 ? repliesList(views) : emptyReplies()}
</main>`
}

function repliesList(views: ReplyView[]): string {
  return `<ul class="replies-list" data-testid="replies-list">
${views.map(replyRow).join("\n")}
  </ul>`
}

/**
 * Present INSTEAD of `replies-list`, never alongside it — the `/leads`
 * convention (`leads-list` / `leads-list-empty`), not `/outbox`'s
 * always-present container. Reachable whenever the queue is genuinely empty,
 * which unlike `/deliveries`' own empty state is an ordinary steady state: a
 * portal whose operator keeps up with their intake sits here most of the time.
 */
function emptyReplies(): string {
  return `<p class="lede" data-testid="replies-list-empty">Nothing waiting for approval. Every drafted reply has been sent or discarded.</p>`
}

function replyRow(view: ReplyView): string {
  const { draft, inbound } = view
  return `    <li>
      <div class="reply-row" data-testid="reply-row" data-rung="${rungOf(inbound)}" data-routed-kind="${escapeHtml(kindOf(inbound))}">
        <div class="row-top">
          <div class="row-main">
            <span class="subject" data-testid="reply-subject">${escapeHtml(inbound.subject)}</span>
            <span class="meta">
              <span data-testid="reply-sender-email">${escapeHtml(inbound.fromEmail)}</span>${senderName(inbound)} &middot;
              <span data-testid="reply-received-at">${escapeHtml(receivedAt(inbound))}</span>
            </span>${attachmentsNote(inbound, "span")}
          </div>
          <div class="row-side">
            ${routeBadge(view)}
            <span class="auth-result" data-testid="reply-auth-result">${escapeHtml(inbound.authResult)}</span>
            <a class="button secondary" href="/replies/${encodeURIComponent(draft.id)}" data-testid="review-reply">Review</a>
          </div>
        </div>
      </div>
    </li>`
}

// ── GET /replies/:id ─────────────────────────────────────────────────────────

/** One draft: the message as received, what the router decided, and the four actions. */
export async function replyDetail(request: Request, env: Env, id: string): Promise<Response> {
  const operator = await readOperator(request, env)
  if (!operator) return leadsNotFound()

  const context = await replyContext(env, id)
  // Same 404 whether the draft does not exist, was already approved or
  // discarded, or the caller is not an operator — see `src/operators.ts`. A
  // distinct "already handled" response would both confirm the surface exists
  // and tell one operator what another just did, in a body nobody reads.
  if (context === null) return leadsNotFound()

  const candidates = await routingCandidates(env, context.inbound)
  return html(
    page(
      `${replyHeadline(context.inbound)} — coord-portal`,
      replyDetailPage(operator, context, candidates),
    ),
  )
}

/** The draft plus its inbound row, or `null` if either half is missing or the draft is no longer pending. */
async function replyContext(env: Env, id: string): Promise<ReplyView | null> {
  const draft = await getPendingReplyDraft(env, id)
  if (draft === null) return null
  const inbound = await getInboundEmailByOutboxId(env, draft.id)
  if (inbound === null) return null
  return { draft, inbound, target: await targetOf(env, inbound) }
}

function replyDetailPage(operator: Operator, view: ReplyView, candidates: RoutingCandidate[]): string {
  const { draft, inbound } = view
  const action = `/replies/${encodeURIComponent(draft.id)}`
  return `${operatorTopbar(operator.email, "replies")}
<main data-testid="reply-detail" data-rung="${rungOf(inbound)}" data-routed-kind="${escapeHtml(kindOf(inbound))}">
  <a class="back-link" href="/replies" data-testid="back-to-replies">&larr; Replies</a>

  ${routeBadge(view)}
  <h1 data-testid="reply-subject">${escapeHtml(inbound.subject)}</h1>
  <p class="meta">from <span data-testid="reply-sender-email">${escapeHtml(inbound.fromEmail)}</span>${senderName(inbound)} &middot;
    <span data-testid="reply-received-at">${escapeHtml(receivedAt(inbound))}</span></p>
  ${attachmentsNote(inbound, "p")}
  <section class="card">
    <h2>The message as received</h2>
    <dl class="received">
      <dt>Authenticated</dt>
      <dd data-testid="reply-auth-result">${escapeHtml(inbound.authResult)}</dd>
      <dt>Message</dt>
      <dd data-testid="reply-original-body">${escapeHtml(inbound.bodyText)}</dd>
    </dl>
  </section>

  <section class="card">
    <h2>Why it landed here</h2>
    ${routeDecision(view)}
    <p class="route-reason" data-testid="reply-route-reason">${escapeHtml(routeReason(inbound))}</p>${runnerUp(inbound)}${routingPanel(view, candidates, action)}
  </section>

  <section class="card">
    <h2>Drafted reply</h2>
    <form method="POST" action="${action}/approve" data-testid="reply-approve-form">
      <div class="field">
        <label for="reply-subject">Subject</label>
        <input type="text" id="reply-subject" name="subject" value="${escapeHtml(draft.subject)}" data-testid="reply-subject-field">
      </div>
      <div class="field">
        <label for="reply-body">Body</label>
        <textarea id="reply-body" name="body" rows="10" data-testid="reply-body-field">${escapeHtml(draft.body)}</textarea>
      </div>
      <div class="actions">
        <button type="submit" class="primary" data-testid="reply-approve-button">Approve &amp; send</button>
      </div>
    </form>
    <form method="POST" action="${action}/discard" data-testid="reply-discard-form">
      <div class="actions">
        <button type="submit" class="ghost" data-testid="reply-discard-button">Discard</button>
      </div>
    </form>${promoteForm(inbound, action)}
  </section>
</main>`
}

/**
 * `reply-route-decision` — one sentence saying what happened, carrying
 * `data-routed-kind` of its own so a test that wants to query a single node
 * can. `reply-route-target` sits inside it when there is something to name;
 * see `targetOf` for when there is not.
 */
function routeDecision(view: ReplyView): string {
  const { inbound, target } = view
  const kind = kindOf(inbound)
  const named = target === null ? "" : ` <span class="route-target" data-testid="reply-route-target">${escapeHtml(target)}</span>`

  // The wording stays neutral about *who* decided — the rung is the router's
  // own record and survives an operator's override (see `InboundRetarget`),
  // so a sentence like "nobody on file matches this address" would be a lie on
  // a row a person re-routed by hand. `reply-route-reason` below is where the
  // actual justification lives, router-authored or operator-authored.
  if (kind === "message") {
    return `<p class="route-reason" data-testid="reply-route-decision" data-routed-kind="message">Rung ${rungOf(inbound)} — this reply is attached to${named || " an existing thread"}.</p>`
  }
  if (kind === "lead") {
    return `<p class="route-reason" data-testid="reply-route-decision" data-routed-kind="lead">Rung ${rungOf(inbound)} — this message is recorded as${named || " a new lead"}, the same inert row <code>/start</code> would have written.</p>`
  }
  return `<p class="route-reason" data-testid="reply-route-decision" data-routed-kind="unrouted">Rung ${rungOf(inbound)} — not attached to anything. The router had something to go on but would not guess between the options.</p>`
}

/**
 * The router's own reason, verbatim (`inbound_emails.routed_reason`, written
 * by `src/inboundRouter.ts` — or overwritten by an operator's own re-route,
 * see `retargetInboundEmailStatement`). "An operator who cannot see why a
 * match was made cannot sensibly disagree with it" — issue #166.
 *
 * The fallback is defensive only: every routed row has a reason, because the
 * ladder always reaches an answer and records one. A row with none would still
 * have to render a non-empty explanation rather than an empty element that
 * reads as "no reason given" when the truth is "this data is older than the
 * column".
 */
function routeReason(inbound: InboundEmailRecord): string {
  return inbound.routedReason ?? "No reason was recorded for this decision."
}

/**
 * `reply-route-runner-up` — present iff the router actually scored a second
 * candidate and declined it (rung 4's scoring case and the tie that falls to
 * unrouted). Absent on an exact match or a stranger: there is nothing to be a
 * runner-up to, and inventing one would tell an operator the router weighed
 * options it never saw (`describeRunnerUp`, `src/inboundRouter.ts`, makes the
 * same argument from the other side).
 */
function runnerUp(inbound: InboundEmailRecord): string {
  if (inbound.routedRunnerUp === null) return ""
  return `
    <p class="runner-up" data-testid="reply-route-runner-up">${escapeHtml(inbound.routedRunnerUp)}</p>`
}

/**
 * The "Change routing" disclosure — absent entirely on the stranger case
 * (`routed_kind = 'lead'`): there is no known sender for a routing decision to
 * be wrong *about*, and the lead this message already became has its own
 * triage screen.
 *
 * No JavaScript: `reply-routing-toggle` is a real, focusable checkbox and both
 * `reply-routing-open-button` and `reply-routing-cancel` are `<label
 * for=…>`s pointing at it — the exact mechanism `reassignPanel`
 * (`src/routes/leads.ts`) already uses, under this screen's own class names so
 * neither panel depends on the other's markup being present.
 *
 * Open by default on an `unrouted` row and closed on a match: an ambiguous row
 * is the one case where resolving the routing is the *first* thing an operator
 * is here to do, not an override they might want.
 *
 * NEITHER candidate is ever pre-selected. "Guessing never" (#163) applies to
 * this panel as much as to the router: a pre-checked radio on an unrouted row
 * would put the router's refusal to choose behind an operator's single
 * distracted click.
 */
function routingPanel(view: ReplyView, candidates: RoutingCandidate[], action: string): string {
  if (kindOf(view.inbound) === "lead") return ""
  const open = kindOf(view.inbound) === "unrouted" ? " checked" : ""
  const note =
    candidates.length === 0
      ? `
        <p class="routing-note">There is no other project on file for this sender — but if this match is wrong, you can still park it as a lead instead.</p>`
      : ""

  return `

    <input class="routing-toggle" type="checkbox" id="routing-toggle" data-testid="reply-routing-toggle"${open} aria-label="Change routing">
    <div class="routing-panel">
      <label class="secondary routing-open-button" role="button" for="routing-toggle" data-testid="reply-routing-open-button">Change routing</label>
      <form class="routing-form" method="POST" action="${action}/route" data-testid="reply-routing-form" aria-label="Change routing">${note}
        <fieldset class="routing-project-list">
          <legend class="visually-hidden">Attach this to</legend>
          ${candidates.map(routingOption).join("\n          ")}
          <label class="routing-project-option" data-testid="reply-routing-option-lead">
            <input type="radio" name="target" value="lead">
            Not any of these — record it as a lead instead
          </label>
        </fieldset>
        <div class="actions">
          <label class="ghost" role="button" for="routing-toggle" data-testid="reply-routing-cancel">Cancel</label>
          <button type="submit" class="primary" data-testid="reply-routing-submit">Route here</button>
        </div>
      </form>
    </div>`
}

function routingOption(candidate: RoutingCandidate): string {
  return `<label class="routing-project-option" data-testid="reply-routing-option" data-target-id="${escapeHtml(candidate.projectId)}">
            <input type="radio" name="target" value="${escapeHtml(candidate.projectId)}">
            ${escapeHtml(candidate.title)}
          </label>`
}

/**
 * `reply-promote-form` — EM-7's own action (issue #167), rendered here because
 * the Gate-A contract pins its presence on this screen and its
 * `data-routed-kind` rule with it. Absent on `lead`: a stranger's inbound
 * email already has a promotion path, `promote-lead-form` on `/leads/:id`, and
 * two buttons for one act with no way to tell which is authoritative is worse
 * than one button in the other place.
 *
 * `POST /replies/:id/promote` is deliberately not implemented by this issue —
 * see this module's own "THE FOURTH ACTION" note. Until EM-7 lands it, the
 * POST gets the same 404 every other unsupported method on this surface does.
 */
function promoteForm(inbound: InboundEmailRecord, action: string): string {
  if (kindOf(inbound) === "lead") return ""
  return `
    <form method="POST" action="${action}/promote" data-testid="reply-promote-form">
      <div class="actions">
        <button type="submit" class="secondary" data-testid="reply-promote-button">Promote to a submission</button>
      </div>
    </form>`
}

// ── POST /replies/:id/approve ────────────────────────────────────────────────

/**
 * **Approve & send.** Writes whatever the operator has in the two fields — not
 * whatever the template originally produced — and opens the gate in the same
 * statement (`approveReplyDraft`, `src/notifications.ts`, whose own doc
 * explains why those cannot be two writes). The next cron tick (≤5 minutes,
 * `wrangler.toml`) carries it; nothing here sends anything itself, which is
 * the whole reason `src/drain.ts` exists.
 *
 * A missing or unparseable field is not an error: a form posted with no
 * `subject` at all keeps the drafted subject rather than sending an email with
 * an empty one. "Absent beats broken" — the same rule this codebase applies at
 * the provider seam.
 *
 * Answers 303 back to `/replies` either way — see `alreadyHandled` for why the
 * losing half of a double-click is a redirect rather than a 404. A successful
 * approve has nowhere else to go: its own detail page stops rendering the
 * moment the row leaves `pending`, and sending an operator there would make a
 * perfectly successful action look like it broke something.
 */
export async function postReplyApprove(request: Request, env: Env, id: string): Promise<Response> {
  const operator = await readOperator(request, env)
  if (!operator) return leadsNotFound()

  const draft = await getPendingReplyDraft(env, id)
  if (draft === null) return alreadyHandled()

  const form = await readForm(request)
  if (form === null) return leadsNotFound()

  const subject = fieldOr(form, "subject", draft.subject)
  const body = fieldOr(form, "body", draft.body)

  await approveReplyDraft(env, draft.id, subject, body, operator.email)
  return seeOther(REPLIES_PATH)
}

// ── POST /replies/:id/discard ────────────────────────────────────────────────

/**
 * **Discard.** `approval_state = 'rejected'`, terminal, never sends — however
 * many drain ticks run afterwards (`src/drain.ts` sends only from
 * `not_required` and `approved`, and a `rejected` row is not even a retry
 * candidate because it never matches that WHERE clause at all).
 *
 * No form body is read, and none is required: the discard form carries nothing
 * but its button. A missing content type is still refused, for the same reason
 * every other POST on this surface refuses one — a bare replayed POST with no
 * body is not an operator's click.
 */
export async function postReplyDiscard(request: Request, env: Env, id: string): Promise<Response> {
  const operator = await readOperator(request, env)
  if (!operator) return leadsNotFound()

  const draft = await getPendingReplyDraft(env, id)
  if (draft === null) return alreadyHandled()

  if ((await readForm(request)) === null) return leadsNotFound()

  await discardReplyDraft(env, draft.id, operator.email)
  return seeOther(REPLIES_PATH)
}

// ── POST /replies/:id/route ──────────────────────────────────────────────────

/**
 * **Change route** — "re-run against an operator-chosen client / project /
 * lead, re-render the draft from the template, stay `pending`" (issue #166's
 * own table, row 3).
 *
 * `target` is either the id of a project the panel offered (validated against
 * `routingCandidates` re-derived here, so a request cannot name a project
 * outside this sender's own client — the same scoping `postLeadReassign`
 * refuses to relax) or the literal `lead`. Anything else — a stale id, a
 * hand-rolled POST, a replayed form — is a no-op that still redirects: "a
 * malformed or replayed choice should never look like an error to an operator
 * who did nothing wrong, but nothing moves."
 *
 * ── WHAT THIS DOES NOT DO: MOVE THE THREAD MESSAGE ───────────────────────────
 * When EM-5 routed this message to a submission it appended a `messages` row
 * to that thread. Re-routing here does NOT move, delete or duplicate it.
 * `migrations/0014_messages.sql` pins that table as append-only — the record
 * of what was actually said — and "moving" a message is not a representable
 * operation in it. Neither issue #166 nor the Gate-A contract asks for one;
 * both describe this action purely as re-targeting the row and re-rendering
 * the draft. Inventing a delete-and-reinsert here would quietly make a
 * customer's own words a thing an operator's mis-click can relocate, which is
 * a bigger decision than this issue's scope. Flagged, not silently resolved:
 * the visible consequence is that a message re-routed away from a thread
 * leaves its original entry there.
 */
export async function postReplyRoute(request: Request, env: Env, id: string): Promise<Response> {
  const operator = await readOperator(request, env)
  if (!operator) return leadsNotFound()

  const context = await replyContext(env, id)
  if (context === null) return alreadyHandled()

  const form = await readForm(request)
  if (form === null) return leadsNotFound()

  const raw = form.get("target")
  const target = typeof raw === "string" ? raw.trim() : ""
  const back = seeOther(`/replies/${encodeURIComponent(context.draft.id)}`)

  // The stranger case has no routing panel to submit from at all — see
  // `routingPanel`. A POST that reached here anyway moves nothing.
  if (kindOf(context.inbound) === "lead") return back

  if (target === "lead") {
    await routeToLead(env, context)
    return back
  }

  const candidates = await routingCandidates(env, context.inbound)
  const picked = candidates.find((candidate) => candidate.projectId === target)
  if (picked !== undefined) await routeToProject(env, context, picked)
  return back
}

/**
 * Re-target onto one of the sender's own projects: the draft becomes EM-5's
 * routed acknowledgement pointed at that project's newest submission, and the
 * `inbound_emails` row records the project and submission a person chose.
 *
 * One `DB.batch()` — D1 runs it as a single transaction — for the reason
 * `writeInboundEmail` (`src/inboundEmail.ts`) gives for its own: a draft whose
 * call to action names a thread the row is not recorded as belonging to is not
 * a partial success, it is two screens disagreeing about the same fact. Both
 * statements carry the same `pending` guard, so a re-route racing an approve
 * lands entirely or not at all.
 */
async function routeToProject(env: Env, view: ReplyView, picked: RoutingCandidate): Promise<void> {
  const content = routedReplyContent(`/submissions/${picked.submissionId}`)
  const retarget: InboundRetarget = {
    kind: "message",
    reason: `An operator attached this to "${picked.title}" (${picked.submissionReference}) by hand — the router's own rung ${rungOf(view.inbound)} decision did not stand.`,
    projectId: picked.projectId,
    submissionReference: picked.submissionReference,
    leadId: null,
  }

  await env.DB.batch([
    redraftReplyStatement(env, view.draft.id, content),
    retargetInboundEmailStatement(
      env,
      view.inbound.id,
      retarget,
      pendingDraftGuard(view.draft.id, "AND"),
    ),
  ])
}

/**
 * Re-target to "not any of these — record it as a lead instead": the draft
 * becomes EM-4's stranger acknowledgement (the one that names a
 * `LEAD-XXXXXX` reference and no URL), and the message is recorded as having
 * produced a lead.
 *
 * The `leads` row is minted here through the *same* `mintLead` /
 * `leadCreationStatement` pair `POST /start` and `src/inboundEmail.ts` both
 * use — "not a copy of it, not a variant" (issue #164) — so an operator-routed
 * lead is indistinguishable on `/leads` from one a stranger's own email or web
 * form produced, and is promotable by the same button.
 *
 * A row that already has a `routed_lead_id` re-uses it rather than minting a
 * second: re-routing to "lead" twice (a double-click, a back-button re-submit)
 * must converge on one lead, the same idempotency EM-4's own `ON CONFLICT`
 * gives the first one. The draft is still re-rendered, harmlessly, to the same
 * text.
 */
async function routeToLead(env: Env, view: ReplyView): Promise<void> {
  const { draft, inbound } = view
  const existing = inbound.routedLeadId === null ? null : await getLead(env, inbound.routedLeadId)

  const lead =
    existing ??
    mintLead({ summary: inbound.bodyText, email: inbound.fromEmail, name: inbound.fromName })

  const retarget: InboundRetarget = {
    kind: "lead",
    reason: `An operator recorded this as a new lead (${lead.reference}) by hand rather than attaching it to a project — the router's own rung ${rungOf(inbound)} decision did not stand.`,
    projectId: null,
    submissionReference: null,
    leadId: lead.id,
  }

  const statements = [
    redraftReplyStatement(env, draft.id, intakeReplyContent(lead.reference)),
    retargetInboundEmailStatement(env, inbound.id, retarget, pendingDraftGuard(draft.id, "AND")),
  ]
  if (existing === null) statements.push(leadCreationStatement(env, lead, pendingDraftGuard(draft.id)))

  await env.DB.batch(statements)
}

// ── SHARED BITS ──────────────────────────────────────────────────────────────

/**
 * `request.formData()`, refusing a request that carries no parseable form at
 * all — `null` here becomes the same 404 every other refusal on this surface
 * answers with. See `src/formData.ts` for why the parse is wrapped at all
 * (issue #46/#71: an unguarded `formData()` is a 500 on a bare replayed POST).
 */
async function readForm(request: Request): Promise<FormData | null> {
  if (!isFormContentType(request.headers.get("content-type") ?? "")) return null
  return parseFormData(request)
}

/** One form field, falling back to what the draft already says rather than to `""`. */
function fieldOr(form: FormData, name: string, fallback: string): string {
  const raw = form.get(name)
  return typeof raw === "string" ? raw : fallback
}

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location } })
}

/**
 * The answer to a POST against a row that is no longer `pending` — already
 * approved, already discarded, or an id that names nothing at all.
 *
 * A redirect, deliberately NOT `leadsNotFound()`. The Gate-A contract is
 * explicit that a POST to any of EM-6's four actions on a non-`pending` row is
 * "a guarded no-op ... not an error response", and the reason is the case this
 * exists for: the losing half of a double-click, or an operator's second tab
 * submitting a form the first tab already acted on. Neither of those is a
 * person who did anything wrong, and answering the second click with a
 * not-found page would make a converged, correct outcome look like a failure.
 * The queue is where they were going anyway.
 *
 * This is reached only *after* the `readOperator` gate, so it tells a stranger
 * nothing — a non-operator never gets here at all; they get the same
 * indistinguishable 404 every other refusal on this surface answers with.
 *
 * The GET routes keep answering 404 for the same rows: a screen for a draft
 * that no longer exists has nothing to render, and 404 is what this surface
 * says about every "no such thing" (`src/operators.ts`).
 */
function alreadyHandled(): Response {
  return seeOther(REPLIES_PATH)
}

/** `data-routed-kind`. Every drafted reply has one — a row that was never routed never got a draft. */
function kindOf(inbound: InboundEmailRecord): string {
  return inbound.routedKind ?? "unrouted"
}

/**
 * `data-rung`, a bare integer string. Defaults to rung 6 for the same reason
 * `kindOf` defaults to `unrouted`: an unroutable row is what "we could not
 * place this" has always meant here, and a blank attribute would be a third
 * state nothing else in this milestone knows how to read.
 */
function rungOf(inbound: InboundEmailRecord): string {
  return String(inbound.routedRung ?? 6)
}

/** Present iff the message carried a display name — same optionality `nameBlock` gives a lead's. */
function senderName(inbound: InboundEmailRecord): string {
  if (!inbound.fromName) return ""
  return ` &middot;
              <span data-testid="reply-sender-name">${escapeHtml(inbound.fromName)}</span>`
}

/**
 * Present iff the message actually carried attachments. EM-1 records the count
 * and drops the payload — this portal's mailbox has nowhere to put a file —
 * so an operator reading a message that references "the screenshot attached"
 * needs to know why they cannot see one.
 *
 * The count is rendered as a base-10 integer, which is what a test may assert
 * on; the wording around it is not pinned. Absent entirely at zero, the same
 * present-iff convention `delivery-attempts` (`/deliveries`) uses.
 */
function attachmentsNote(inbound: InboundEmailRecord, tag: "span" | "p"): string {
  if (inbound.attachmentCount <= 0) return ""
  const plural = inbound.attachmentCount === 1 ? "attachment" : "attachments"
  return `<${tag} class="attachments-note" data-testid="reply-attachments-dropped">${inbound.attachmentCount} ${plural} — received, not saved</${tag}>`
}

/**
 * `received_at` to the second. Stored at millisecond precision because it is
 * also the sort key, displayed without them for the same reason
 * `submittedAt` (`src/routes/leads.ts`) trims a lead's: the extra digits are
 * noise to an operator scanning a queue.
 */
function receivedAt(inbound: InboundEmailRecord): string {
  const parsed = new Date(inbound.receivedAt)
  return Number.isNaN(parsed.getTime()) ? inbound.receivedAt : `${parsed.toISOString().slice(0, 19)}Z`
}

/** The `<title>`, from the sender's own subject — clamped so one runaway subject line is not the whole tab. */
function replyHeadline(inbound: InboundEmailRecord): string {
  const subject = inbound.subject.trim() || "Reply"
  return subject.length > 60 ? `${subject.slice(0, 59)}…` : subject
}

/**
 * `reply-route-badge` — the one-glance summary, carrying `data-routed-kind`.
 * For a `message` or a `lead` the badge names what it routed to, because that
 * is the fact an operator scans the list for; an `unrouted` row has nothing to
 * name and says so instead.
 */
function routeBadge(view: ReplyView): string {
  const kind = kindOf(view.inbound)
  const text =
    kind === "message"
      ? `Matched: ${view.target ?? "an existing thread"}`
      : kind === "lead"
        ? `New lead ${view.target ?? ""}`.trim()
        : "Unrouted — needs a decision"
  return `<span class="route-badge" data-testid="reply-route-badge" data-routed-kind="${escapeHtml(kind)}">${escapeHtml(text)}</span>`
}
