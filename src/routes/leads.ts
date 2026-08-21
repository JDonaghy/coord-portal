import { findOrCreateClientId, getClientByEmail, type Client } from "../clients"
import { parseFormData } from "../formData"
import {
  getLead,
  leadStatus,
  listLeads,
  promoteLead,
  LEAD_STATUS_TEXT,
  type Lead,
  type LeadStatus,
} from "../leads"
import { listMessages, postMessage } from "../messages"
import { readOperator, type Operator } from "../operators"
import {
  attachNewClientProject,
  attachSubmissionToProjectIfUnassigned,
  createClientProject,
  getProject,
  listProjectsForClient,
  type Project,
} from "../projects"
import { escapeHtml, html, operatorTopbar, page } from "../render"
import {
  getNewestSubmissionForProject,
  getSubmission,
  setSubmissionProject,
  titleOf,
  type Submission,
} from "../submissions"
import type { Env } from "../types"
import { isFormContentType, messageThreadSection, type ThreadContext } from "./submission"

/**
 * The operator's triage surface (issue #33) — "the operator act that turns a
 * stranger into a customer. This is the human gate the whole design leans on:
 * nothing crosses from the public surface into the pipeline without it."
 *
 * Five routes:
 *
 *   GET  /leads               every lead, newest first
 *   GET  /leads/:id           one lead, pre- or post-promotion
 *   POST /leads/:id/promote   the gate itself; idempotent; 303 back to the lead
 *   POST /leads/:id/message   the operator's half of issue #110's chat thread
 *   POST /leads/:id/reassign  issue #130 — move the promoted submission to a
 *                             different (or new) project of the same client
 *
 * No decline, dismiss or archive route: issue #33 puts them out of scope, and
 * "a lead that was not promoted stays inert forever" is a property of doing
 * nothing. No route that emails the customer either — that is #14's, and this
 * issue "must not grow an email path of its own".
 *
 * ── THE FOURTH ROUTE, AND WHY IT LIVES HERE (issue #110) ───────────────────
 * The customer's half of the message thread is on `/submissions/:id`
 * (`src/routes/submission.ts`), gated by `isOwnedBy` — an operator's Access
 * email is never a submission's `customer_email`, so that route 404s for an
 * operator by construction, and `tests/acceptance/ms-2/33-lead-triage-promotion.spec.ts`
 * sealed-asserts exactly that ("ms-1's ownership scoping is not reopened for
 * the operator"). Rather than carve an operator exception into a route whose
 * whole contract is "the customer's own", the operator's half of the same
 * thread lives here, on the one screen an operator already reaches a
 * promoted lead's submission from — keyed by `lead.promotedSubmissionReference`
 * (the `SUB-XXXXXX` the two sides of the thread share), never by the
 * `sub_…` id `/submissions/:id` itself uses.
 *
 * ── THE THING THIS FILE EXISTS TO SAY ──────────────────────────────────────
 * The portal cannot add anyone to a Cloudflare Access policy, and deliberately
 * does not try: "the thing that grants access to customer data should not be
 * reachable from the application that serves it." So promotion has a seam a
 * human has to close by hand, and both screens below say so — before the
 * operator acts (`access-seat-reminder`) and after (`access-seat-manual-step`).
 *
 * That is not decoration. A promoted submission the customer cannot reach is a
 * silent dead end: they were accepted, never told, and nobody finds out until
 * they ask why they heard nothing. If either warning is ever removed, this
 * feature quietly stops working in a way no test of the happy path would catch.
 *
 * ── AND WHY THE EMAIL IS SHOWN, NOT SUMMARISED ─────────────────────────────
 * Access matches on the address an identity provider returns, and this portal
 * scopes every authenticated screen by that address (#12). A mismatch fails
 * silently in two directions: denied at the edge, or admitted as a *different*
 * identity who owns nothing and sees an empty portal. Neither produces an error
 * anyone sees, and this screen would still say the lead was promoted. So the
 * exact address the seat must be issued to is rendered verbatim, in both
 * warnings and in the lead's own detail — the operator confirms an address,
 * they do not skim a field.
 *
 * ── THE FIFTH ROUTE, AND WHY IT LIVES HERE TOO (issue #130) ─────────────────
 * `/leads/:id` is, today, the only screen an operator reaches a specific
 * submission from by more than a plain-text reference
 * (`promotedReference` below never links out — see its own doc comment), so
 * it is also where a richer, operator-only view of that submission's project
 * has to live. Reassignment is scoped to "the same client's own projects"
 * (#130's own wording) — see `src/clients.ts` for where a promoted
 * submission's client-linked project comes from in the first place.
 */

const LEADS_PATH = "/leads"
const LEAD_PATH = /^\/leads\/([^/?#]+)$/
const LEAD_PROMOTE_PATH = /^\/leads\/([^/?#]+)\/promote$/
const LEAD_MESSAGE_PATH = /^\/leads\/([^/?#]+)\/message$/
const LEAD_REASSIGN_PATH = /^\/leads\/([^/?#]+)\/reassign$/

/** What `handlePages` needs to know about a `/leads…` URL, or `null`. */
export function matchLeadsPath(
  pathname: string,
):
  | { kind: "index" }
  | { kind: "detail"; id: string }
  | { kind: "promote"; id: string }
  | { kind: "message"; id: string }
  | { kind: "reassign"; id: string }
  | null {
  if (pathname === LEADS_PATH) return { kind: "index" }

  const promote = pathname.match(LEAD_PROMOTE_PATH)
  if (promote?.[1]) return { kind: "promote", id: promote[1] }

  const message = pathname.match(LEAD_MESSAGE_PATH)
  if (message?.[1]) return { kind: "message", id: message[1] }

  const reassign = pathname.match(LEAD_REASSIGN_PATH)
  if (reassign?.[1]) return { kind: "reassign", id: reassign[1] }

  const detail = pathname.match(LEAD_PATH)
  if (detail?.[1]) return { kind: "detail", id: detail[1] }

  return null
}

/**
 * GET /leads — "an operator-facing list of leads with enough of each to
 * decide" (issue #33).
 *
 * Enough, per the Gate-A contract, is: what they said, how to reach them, when
 * they sent it, and whether it has already been promoted. Not the full text —
 * that is one click away on the detail screen, and a wall of paragraphs is
 * harder to triage than a list of first lines.
 */
export async function leadsInbox(request: Request, env: Env): Promise<Response> {
  const operator = await readOperator(request, env)
  if (!operator) return leadsNotFound()

  const leads = await listLeads(env)
  return html(page("Leads — coord-portal", inbox(operator, leads)))
}

/**
 * GET /leads/:id — one lead, "a pure function of whether it's been promoted".
 *
 * The same route renders both states because they are the same record: a
 * promoted lead is not archived or moved, it just has a promotion recorded on
 * it. The trail from first contact to shipped work stays readable at one URL.
 */
export async function leadDetail(request: Request, env: Env, id: string): Promise<Response> {
  const operator = await readOperator(request, env)
  if (!operator) return leadsNotFound()

  const lead = await getLead(env, id)
  // Same 404 whether the lead does not exist or the caller is not an operator —
  // see `src/operators.ts`. A response that only fires for "someone else" would
  // itself confirm the operator surface exists to anyone who found the URL.
  if (!lead) return leadsNotFound()

  const thread = await threadFor(env, lead)
  const reassignment = await reassignmentContext(env, lead)
  const match = await clientMatch(env, lead)
  return html(
    page(`${lead.reference} — coord-portal`, detail(operator, lead, thread, reassignment, match)),
  )
}

/**
 * The message thread for a lead's promoted submission (issue #110), or
 * `null` for a lead that has not been promoted yet — there is no submission,
 * and therefore no `SUB-XXXXXX` reference, for a message to belong to.
 */
async function threadFor(env: Env, lead: Lead): Promise<ThreadContext | null> {
  if (!lead.promotedSubmissionReference) return null
  return { messages: await listMessages(env, lead.promotedSubmissionReference) }
}

/** A project and the name a screen shows it under — see `projectTitle`. */
interface TitledProject {
  project: Project
  title: string
}

/**
 * The client `lead.email` already names, and every project that client has —
 * issue #129's `client-match-card`, rendered *before* promotion so the
 * operator can say which project this request joins.
 *
 * `null` when no `clients` row matches, which is the majority case and the
 * one this screen deliberately says nothing about: the ms-4 contract pins
 * the no-match rendering as byte-identical to ms-2's, and announces a new
 * client only *after* promotion. A stranger's first lead therefore looks
 * exactly as it did before this milestone.
 */
interface ClientMatch {
  client: Client
  /** Newest first — `listProjectsForClient`'s own order, which is also the
   * order the radios render in and which one is pre-selected. */
  projects: TitledProject[]
}

async function clientMatch(env: Env, lead: Lead): Promise<ClientMatch | null> {
  if (lead.promotedAt !== null) return null
  const client = await getClientByEmail(env, lead.email)
  if (!client) return null
  return { client, projects: await titledProjects(env, await listProjectsForClient(env, client.id)) }
}

/**
 * Everything issue #130's reassignment panel needs to render, or `null` when
 * there is nothing to reassign: the lead was never promoted, or its
 * submission has vanished (it cannot — defensive only).
 *
 * `siblings` — "every **other** project belonging to the same client,
 * current project excluded" (ms-4 contract) — is empty for a client with
 * only one project, which is still a valid state the panel renders (just the
 * "start a new project instead" option).
 */
interface ReassignmentContext {
  submission: Submission
  /**
   * The submission's current project — normally the one promotion put it in
   * (#129), or wherever an operator has since moved it. `null` only for a
   * submission promoted before #129 shipped, which the panel renders as
   * "not yet in a project of its own" rather than refusing to open.
   */
  project: Project | null
  /**
   * The same client scope `client-project-list` uses before promotion —
   * from the current project's own `client_id` if it has one, otherwise
   * looked up by the lead's email (read-only: `getClientByEmail` never
   * creates a row). `null` only for a lead promoted before #129 shipped,
   * which just means "nothing to offer but a new project" — the same
   * rendering a genuinely single-project client gets.
   */
  clientId: string | null
  currentTitle: string
  siblings: TitledProject[]
}

async function reassignmentContext(env: Env, lead: Lead): Promise<ReassignmentContext | null> {
  if (!lead.promotedSubmissionId) return null

  const submission = await getSubmission(env, lead.promotedSubmissionId)
  if (!submission) return null

  const project = submission.projectId ? await getProject(env, submission.projectId) : null
  const clientId = project?.clientId ?? (await getClientByEmail(env, lead.email))?.id ?? null

  const clientProjects = clientId ? await titledProjects(env, await listProjectsForClient(env, clientId)) : []
  const siblings = clientProjects.filter((candidate) => candidate.project.id !== project?.id)

  const current = clientProjects.find((candidate) => candidate.project.id === project?.id)
  const currentTitle = project
    ? (current?.title ?? (await projectTitle(env, project, clientProjects.length + 1)))
    : "Not yet in a project of its own"

  return { submission, project, clientId, currentTitle, siblings }
}

/**
 * Names every project in a client's own list, oldest-first ordinals against a
 * newest-first list — `listProjectsForClient`'s order, which is also the
 * order the radios render in.
 */
async function titledProjects(env: Env, projects: Project[]): Promise<TitledProject[]> {
  return Promise.all(
    projects.map(async (project, index) => ({
      project,
      title: await projectTitle(env, project, projects.length - index),
    })),
  )
}

/**
 * A project's display name, per the contract's "The 'Project 1' title"
 * section: derived from its newest submission's own `titleOf` — the same
 * convention the dashboard and `/projects/:id` already use — because
 * `projects` deliberately has no title column to store one in
 * (`migrations/0012_projects.sql`).
 *
 * A project with no submissions under it has nothing to derive from, and the
 * contract pins a positional placeholder for exactly that: "Project 1",
 * "Project 2", … counting that client's projects from the oldest. It is a
 * label, never a stored string, so it silently becomes the submission's own
 * derived title the moment one lands — and a project that has been emptied by
 * a reassignment falls back to it again, keeping its original position rather
 * than reading as untitled.
 */
async function projectTitle(env: Env, project: Project, ordinal: number): Promise<string> {
  const newest = await getNewestSubmissionForProject(env, project.id)
  return newest ? titleOf(newest) : `Project ${ordinal}`
}

/**
 * POST /leads/:id/promote — the gate.
 *
 * Idempotent in the database (`promoteLead`), and a 303 back to the lead so a
 * reload never re-posts. The UI stops offering the button once a lead is
 * promoted, but that is not what makes this safe: the backend's guard is, and
 * it has to be, because a double-click races the render.
 *
 * ── WHAT #129 ADDED TO THIS ROUTE ──────────────────────────────────────────
 * Promotion now also links the lead to a `clients` row and puts the
 * submission it creates into one of that client's projects — "the rendered
 * response after promotion says the work is attached to an existing client,
 * not just 'submission created'". The optional `projectChoice` field the
 * pre-promotion `client-match-card` submits alongside the button says which:
 * `existing:<project id>` for a project the matched client already has, or
 * `"new"`. A promote with no field at all — a lead whose address names
 * nobody, which is every first contact, or a raw POST — takes the same branch
 * as `"new"`: a client and its first project are created (contract mock 03).
 *
 * Every write here is guarded on the submission not being in a project yet,
 * so a replayed or raced promote converges on the one project the first one
 * made, and never moves a submission an operator has since reassigned (#130).
 *
 * A body this cannot parse is *not* an error on this route. ms-2 pins the
 * promote gate's behaviour with an empty form and a raw POST, and neither
 * this issue nor #129 gives promotion a new way to fail — an unreadable body
 * simply carries no choice, and the lead is promoted the way it always was.
 */
export async function promoteLeadAction(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const operator = await readOperator(request, env)
  if (!operator) return leadsNotFound()

  const lead = await getLead(env, id)
  if (!lead) return leadsNotFound()

  const choice = await promotionProjectChoice(request)
  const promoted = await promoteLead(env, lead)
  await attachPromotedSubmission(env, promoted, choice)

  return new Response(null, {
    status: 303,
    headers: { location: `/leads/${lead.id}` },
  })
}

/** `projectChoice` off the promotion form, or `""` when the body carries none. */
async function promotionProjectChoice(request: Request): Promise<string> {
  if (!isFormContentType(request.headers.get("content-type") ?? "")) return ""
  const form = await parseFormData(request)
  const raw = form?.get("projectChoice")
  return typeof raw === "string" ? raw.trim() : ""
}

/**
 * Puts a just-promoted lead's submission into the project the operator
 * picked, or into a new one belonging to the (possibly brand-new) client the
 * lead's address names.
 *
 * A choice naming a project outside the matched client's own list is ignored
 * rather than honoured — the same scoping rule `postLeadReassign` enforces,
 * for the same reason: which client a submission belongs to is not something
 * a form field gets to decide.
 */
async function attachPromotedSubmission(env: Env, lead: Lead, choice: string): Promise<void> {
  const submissionId = lead.promotedSubmissionId
  if (!submissionId) return

  const clientId = await findOrCreateClientId(env, lead.email)

  const chosenProjectId = choice.startsWith("existing:") ? choice.slice("existing:".length) : ""
  if (chosenProjectId) {
    const owned = await listProjectsForClient(env, clientId)
    if (owned.some((project) => project.id === chosenProjectId)) {
      await attachSubmissionToProjectIfUnassigned(env, submissionId, chosenProjectId)
      return
    }
  }

  await attachNewClientProject(env, submissionId, clientId, lead.email)
}

/**
 * POST /leads/:id/reassign — issue #130, "moves it to a different project
 * belonging to the same client — including 'create a new project' inline,
 * without leaving the screen."
 *
 * Same guard shape as `postLeadMessage`: a lead that does not exist or is
 * not promoted gets the one operator-surface 404 (`leadsNotFound`) — never a
 * distinct error that would hint at which is true to a caller who is not an
 * operator.
 *
 * `projectChoice` names either an existing sibling project (validated
 * against `context.siblings`, so a request cannot name a project outside
 * this client — the scoping #130 is explicit is not this route's to relax)
 * or the literal `"new"`. Anything else is a no-op: still a 303 back to the
 * lead, because a malformed or replayed choice should never look like an
 * error to an operator who did nothing wrong, but nothing moves.
 *
 * `"new"` is also the one branch that can mint a `clients` row
 * (`findOrCreateClientId`) — the first time this submission is ever moved
 * anywhere, there may be no client row yet at all (see `src/clients.ts` for
 * why one is never created just by viewing or promoting a lead). Every other
 * branch only ever reads.
 */
export async function postLeadReassign(request: Request, env: Env, id: string): Promise<Response> {
  const operator = await readOperator(request, env)
  if (!operator) return leadsNotFound()

  const lead = await getLead(env, id)
  if (!lead) return leadsNotFound()

  const context = await reassignmentContext(env, lead)
  if (!context) return leadsNotFound()

  const contentType = request.headers.get("content-type") ?? ""
  if (!isFormContentType(contentType)) return leadsNotFound()

  const form = await parseFormData(request)
  if (!form) return leadsNotFound()

  const rawChoice = form.get("projectChoice")
  const choice = typeof rawChoice === "string" ? rawChoice.trim() : ""

  if (choice === "new") {
    const clientId = context.clientId ?? (await findOrCreateClientId(env, lead.email))
    const project = await createClientProject(env, clientId, lead.email)
    await setSubmissionProject(env, context.submission.id, project.id)
  } else if (choice) {
    const target = context.siblings.find((sibling) => sibling.project.id === choice)
    if (target) {
      await setSubmissionProject(env, context.submission.id, target.project.id)
    }
  }

  return new Response(null, {
    status: 303,
    headers: { location: `/leads/${lead.id}` },
  })
}

/**
 * POST /leads/:id/message — the operator's half of issue #110's chat thread.
 * See this file's module comment for why it lives here rather than on
 * `/submissions/:id`.
 *
 * A lead that has not been promoted yet has no submission and therefore no
 * `SUB-XXXXXX` for a message to belong to — the same 404 an unknown or
 * non-operator caller gets, not a 4xx that would hint a message composer
 * exists somewhere on this screen for a `new` lead (the template never
 * renders one either; see `detail`, `promoted ? messageThreadSection(...) :
 * ""`).
 *
 * `request.formData()`'s unguarded-throw failure mode (issue #46, #71) is
 * handled the same way `src/routes/submission.ts`'s `submitSubmissionAction`
 * handles it: a content-type this cannot parse gets the same 404 as every
 * other refusal on this route, never a 5xx.
 */
export async function postLeadMessage(request: Request, env: Env, id: string): Promise<Response> {
  const operator = await readOperator(request, env)
  if (!operator) return leadsNotFound()

  const lead = await getLead(env, id)
  if (!lead || !lead.promotedSubmissionReference) return leadsNotFound()

  const contentType = request.headers.get("content-type") ?? ""
  if (!isFormContentType(contentType)) return leadsNotFound()

  const form = await parseFormData(request)
  if (!form) return leadsNotFound()

  const rawBody = form.get("body")
  const body = typeof rawBody === "string" ? rawBody.trim() : ""
  if (!body) {
    const thread: ThreadContext = {
      messages: await listMessages(env, lead.promotedSubmissionReference),
      error: "Write a message before sending.",
    }
    const reassignment = await reassignmentContext(env, lead)
    // A lead with a message thread is promoted by definition, and
    // `clientMatch` is a pre-promotion rendering only — hence `null`, not
    // another round trip that could only ever return it.
    return html(
      page(`${lead.reference} — coord-portal`, detail(operator, lead, thread, reassignment, null)),
      { status: 400 },
    )
  }

  await postMessage(env, lead.promotedSubmissionReference, "operator", operator.email, body)

  return new Response(null, {
    status: 303,
    headers: { location: `/leads/${lead.id}` },
  })
}

function inbox(operator: Operator, leads: Lead[]): string {
  return `${operatorTopbar(operator.email, "leads")}
<main>
  <div class="page-head">
    <h1>Leads</h1>
  </div>
  <p class="lede">Everything a stranger has sent in through <code>/start</code>. Promote the ones worth doing.</p>
  ${leads.length > 0 ? leadList(leads) : emptyInbox()}
</main>`
}

function leadList(leads: Lead[]): string {
  return `<ul class="leads-list" data-testid="leads-list">
${leads.map(leadRow).join("\n")}
  </ul>`
}

function leadRow(lead: Lead): string {
  const status = leadStatus(lead)
  return `    <li>
      <div class="lead-row" data-testid="lead-row" data-status="${status}">
        <div class="row-main">
          <span class="summary" data-testid="lead-summary">${escapeHtml(lead.summary)}</span>
          <span class="meta">
            <span data-testid="lead-contact-email">${escapeHtml(lead.email)}</span>
            &middot; ${escapeHtml(lead.reference)} &middot;
            <span data-testid="lead-submitted-at">${escapeHtml(submittedAt(lead))}</span>
          </span>
        </div>
        <div class="row-side">
          ${statusPill(status)}
          <a class="button secondary" href="/leads/${encodeURIComponent(lead.id)}" data-testid="review-lead">Review</a>
        </div>
      </div>
    </li>`
}

function emptyInbox(): string {
  return `<p class="lede" data-testid="leads-list-empty">
    Nothing here yet — nobody has sent anything in through <code>/start</code>.
  </p>`
}

function detail(
  operator: Operator,
  lead: Lead,
  thread: ThreadContext | null,
  reassignment: ReassignmentContext | null,
  match: ClientMatch | null,
): string {
  const status = leadStatus(lead)
  const promoted = status === "promoted"

  return `${operatorTopbar(operator.email, "leads")}
<main data-testid="lead-detail" data-status="${status}">
  <a class="back-link" href="/leads" data-testid="back-to-leads">&larr; Leads</a>

  ${statusPill(status)}
  <h1>${escapeHtml(headline(lead))}</h1>
  <p class="meta" data-testid="lead-reference">${escapeHtml(lead.reference)} &middot; sent <span data-testid="lead-submitted-at">${escapeHtml(submittedAt(lead))}</span></p>

  ${promoted ? manualStep(lead) : seatReminder(lead)}
  ${promoted ? promotedReference(lead) : ""}

  <dl class="card">
    <dt>What they said</dt>
    <dd data-testid="lead-summary-full">${escapeHtml(lead.summary)}</dd>
    <dt>Contact email</dt>
    <dd data-testid="lead-contact-email">${escapeHtml(lead.email)}</dd>
    ${nameBlock(lead)}
  </dl>

  ${!promoted && match ? clientMatchCard(match) : ""}
  ${promoted ? "" : promoteForm(lead)}
  ${promoted && reassignment ? reassignSection(lead, reassignment) : ""}

  ${thread ? messageThreadSection(`/leads/${encodeURIComponent(lead.id)}/message`, thread, "operator", operator.email) : ""}
</main>`
}

/**
 * Shown BEFORE the operator commits: promoting is not the same act as granting
 * access, and this is the last moment where saying so can prevent the silent
 * failure rather than describe it. The address is spelled out because it is the
 * thing being confirmed — see the module comment.
 */
function seatReminder(lead: Lead): string {
  return `<p class="access-seat-reminder" data-testid="access-seat-reminder">
    Promoting creates a submission — it does not grant sign-in. You'll still need to add
    ${escapeHtml(lead.email)} to the Access policy by hand before they can log in and see it.
  </p>`
}

/**
 * Shown AFTER promotion, verbatim as the Gate-A contract pins it. `role="alert"`
 * because it is the one thing on this screen that is still outstanding: the
 * submission exists and the person it belongs to cannot reach it yet.
 *
 * Issue #33 calls this its one non-negotiable. Do not soften it, and do not
 * make it conditional on anything — there is no state in which a just-promoted
 * lead's customer can already sign in, because this application has no way to
 * find out and deliberately no way to change it.
 */
function manualStep(lead: Lead): string {
  return `<p class="access-seat-manual-step" data-testid="access-seat-manual-step" role="alert">This customer cannot sign in yet. Add ${escapeHtml(lead.email)} to the Access policy by hand to finish onboarding them.</p>`
}

/**
 * Plain text, never a link — and that is deliberate, not an oversight.
 *
 * `/submissions/:id` is scoped to `customer_email === the caller's Access email`
 * (#12), and the operator's address is never the customer's. A link here would
 * 404 for the only person who would ever click it.
 */
function promotedReference(lead: Lead): string {
  const reference = lead.promotedSubmissionReference ?? "—"
  return `<p class="promoted-ref" data-testid="promoted-submission-reference">Promoted to submission ${escapeHtml(reference)}</p>`
}

/**
 * Absent once the lead is promoted: promotion is a one-way transition in the
 * UI. The backend's idempotency is what makes a double-click or a retry safe
 * (see `promoteLead`), not the absence of a second button.
 */
function promoteForm(lead: Lead): string {
  return `<form id="${PROMOTE_FORM_ID}" class="promote" method="POST" action="/leads/${encodeURIComponent(lead.id)}/promote" data-testid="promote-lead-form">
    <button type="submit" class="primary" data-testid="promote-button">Promote to submission</button>
  </form>`
}

/**
 * The id `client-project-list`'s radios point their `form=` attribute at.
 *
 * The contract puts the client-match card "between the lead's own facts and
 * the seat reminder" but has its radios "submitted as part of the same
 * `promote-lead-form` — one POST, no separate confirmation step". Those two
 * cannot both be true of a nested control, so the radios sit outside the
 * form element and are associated with it by id, which HTML has supported
 * for exactly this since HTML5. No JavaScript, and `promote-button` submits
 * the operator's choice with it.
 */
const PROMOTE_FORM_ID = "promote-lead-form"

/**
 * Issue #129's client-match card — rendered only when this lead's address
 * already names a `clients` row, which is the contract's own condition
 * ("`client-match-card` simply does not render when `getClientByEmail` finds
 * nothing"). A first-time stranger's lead is byte-identical to ms-2's.
 *
 * The newest project is pre-selected, per the contract; a client whose
 * projects are all gone (or who has none yet — possible for a client row
 * minted by a promotion whose own project was later emptied by #130) falls
 * back to "start a new project", which is then the only option there is.
 */
function clientMatchCard(match: ClientMatch): string {
  const count = match.projects.length
  const newChecked = count === 0 ? " checked" : ""
  return `<section class="client-match-card" data-testid="client-match-card" data-match="existing">
    <h2>This looks like an existing client</h2>
    <p class="hint">
      <span data-testid="client-match-email">${escapeHtml(match.client.email)}</span> already has
      <span data-testid="client-match-project-count">${count}</span> ${count === 1 ? "project" : "projects"} with us.
      Pick which one this joins, or start a new one.
    </p>

    <fieldset class="client-project-list" data-testid="client-project-list">
      <legend>Attach this request to</legend>
      ${match.projects.map((entry, index) => clientProjectOption(entry, index === 0)).join("\n      ")}
      <label class="client-project-option-new" data-testid="client-project-option-new">
        <input type="radio" name="projectChoice" value="new" form="${PROMOTE_FORM_ID}"${newChecked}>
        <span class="option-title">Start a new project instead</span>
      </label>
    </fieldset>
  </section>`
}

function clientProjectOption(entry: TitledProject, selected: boolean): string {
  return `<label class="client-project-option" data-testid="client-project-option" data-project-id="${escapeHtml(entry.project.id)}">
        <input type="radio" name="projectChoice" value="existing:${escapeHtml(entry.project.id)}" form="${PROMOTE_FORM_ID}"${selected ? " checked" : ""}>
        <span class="option-title">${escapeHtml(entry.title)}</span>
      </label>`
}

/**
 * The reassignment panel (issue #130) — "present on every
 * `data-status="promoted"` rendering of `/leads/:id`, closed by default."
 *
 * No JavaScript: `reassign-toggle` is the real, focusable checkbox
 * (`.reassign-toggle` in `src/render.ts` — the same visually-hidden
 * technique `.composer-toggle` uses, its own classes so this panel never
 * depends on the design-round composer's markup existing on the same page).
 * `reassign-open-button` and `reassign-cancel` are both `<label for=
 * "reassign-toggle">`s — clicking either toggles the one checkbox they
 * share, which is what makes "cancel" close the panel without a second
 * script or a second control.
 *
 * Never consumed by use, and never gated on anything but promotion — it
 * renders identically whether this is the first time this screen has been
 * opened or the fifth reassignment of the same submission (#130: "applies
 * to any already-promoted submission, not just at promotion time").
 */
function reassignSection(lead: Lead, reassignment: ReassignmentContext): string {
  const action = `/leads/${encodeURIComponent(lead.id)}/reassign`
  const currentProjectLine = reassignment.project
    ? `Currently in <strong>${escapeHtml(reassignment.currentTitle)}</strong>`
    : escapeHtml(reassignment.currentTitle)

  return `<input class="reassign-toggle" type="checkbox" id="reassign-toggle" data-testid="reassign-toggle" aria-label="Reassign project">
  <div class="reassign-panel">
    <label class="secondary reassign-open-button" role="button" for="reassign-toggle" data-testid="reassign-open-button">Reassign project</label>

    <form class="reassign-form" method="POST" action="${action}" data-testid="reassign-form" aria-label="Reassign project">
      <p class="reassign-current-project" data-testid="reassign-current-project">${currentProjectLine}</p>

      <fieldset class="reassign-project-list" data-testid="reassign-project-list">
        <legend class="visually-hidden">Move to</legend>
        ${reassignment.siblings.map((sibling, index) => reassignOption(sibling, index === 0)).join("\n        ")}
        <label class="reassign-project-option-new" data-testid="reassign-project-option-new">
          <input type="radio" name="projectChoice" value="new"${reassignment.siblings.length === 0 ? " checked" : ""}>
          Start a new project instead
        </label>
      </fieldset>

      <div class="actions">
        <label class="ghost" role="button" for="reassign-toggle" data-testid="reassign-cancel">Cancel</label>
        <button type="submit" class="primary" data-testid="reassign-submit">Move to this project</button>
      </div>
    </form>
  </div>`
}

function reassignOption(sibling: { project: Project; title: string }, selected: boolean): string {
  return `<label class="reassign-project-option" data-testid="reassign-project-option" data-project-id="${escapeHtml(sibling.project.id)}">
          <input type="radio" name="projectChoice" value="${escapeHtml(sibling.project.id)}"${selected ? " checked" : ""}>
          ${escapeHtml(sibling.title)}
        </label>`
}

/** Only rendered when the stranger actually gave a name — it is optional on `/start`. */
function nameBlock(lead: Lead): string {
  if (!lead.name) return ""
  return `<dt>Name</dt>
    <dd data-testid="lead-name">${escapeHtml(lead.name)}</dd>`
}

function statusPill(status: LeadStatus): string {
  return `<span class="lead-status-pill" data-testid="lead-status-pill" data-status="${status}">${LEAD_STATUS_TEXT[status]}</span>`
}

/**
 * The first line of what they wrote, as a heading. Same trick `titleOf` plays
 * for a submission's outcome, and for the same reason: `/start` asks for prose,
 * not a title, and one very long paragraph should not become the page's `h1`.
 * The whole text is right below it under "What they said", never truncated.
 */
function headline(lead: Lead): string {
  const firstLine = lead.summary.split("\n")[0]?.trim() || lead.summary
  return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine
}

/**
 * `created_at` is stored at millisecond precision (it is also the sort key, and
 * ties there would shuffle the inbox), but displayed to the second: the extra
 * digits are noise to an operator scanning a list, and this matches the
 * ISO-8601 the Gate-A contract's mocks show.
 */
function submittedAt(lead: Lead): string {
  const parsed = new Date(lead.createdAt)
  return Number.isNaN(parsed.getTime())
    ? lead.createdAt
    : `${parsed.toISOString().slice(0, 19)}Z`
}

/**
 * The one response every rejection on this surface gets — not found, not an
 * operator, not signed in at all. Deliberately the customer-facing "we can't
 * find that" copy and nothing operator-shaped: a stranger who guesses the URL
 * should not learn that an operator surface exists.
 */
export function leadsNotFound(): Response {
  return html(
    page(
      "Not found — coord-portal",
      `<main>
  <h1>We can't find that</h1>
  <p class="lede">The link may be wrong, or it may have been somewhere else entirely.</p>
</main>`,
    ),
    { status: 404 },
  )
}
