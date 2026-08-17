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
import { escapeHtml, html, operatorTopbar, page } from "../render"
import type { Env } from "../types"
import { isFormContentType, messageThreadSection, type ThreadContext } from "./submission"

/**
 * The operator's triage surface (issue #33) — "the operator act that turns a
 * stranger into a customer. This is the human gate the whole design leans on:
 * nothing crosses from the public surface into the pipeline without it."
 *
 * Four routes:
 *
 *   GET  /leads              every lead, newest first
 *   GET  /leads/:id          one lead, pre- or post-promotion
 *   POST /leads/:id/promote  the gate itself; idempotent; 303 back to the lead
 *   POST /leads/:id/message  the operator's half of issue #110's chat thread
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
 */

const LEADS_PATH = "/leads"
const LEAD_PATH = /^\/leads\/([^/?#]+)$/
const LEAD_PROMOTE_PATH = /^\/leads\/([^/?#]+)\/promote$/
const LEAD_MESSAGE_PATH = /^\/leads\/([^/?#]+)\/message$/

/** What `handlePages` needs to know about a `/leads…` URL, or `null`. */
export function matchLeadsPath(
  pathname: string,
):
  | { kind: "index" }
  | { kind: "detail"; id: string }
  | { kind: "promote"; id: string }
  | { kind: "message"; id: string }
  | null {
  if (pathname === LEADS_PATH) return { kind: "index" }

  const promote = pathname.match(LEAD_PROMOTE_PATH)
  if (promote?.[1]) return { kind: "promote", id: promote[1] }

  const message = pathname.match(LEAD_MESSAGE_PATH)
  if (message?.[1]) return { kind: "message", id: message[1] }

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
  return html(page(`${lead.reference} — coord-portal`, detail(operator, lead, thread)))
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

/**
 * POST /leads/:id/promote — the gate.
 *
 * Idempotent in the database (`promoteLead`), and a 303 back to the lead so a
 * reload never re-posts. The UI stops offering the button once a lead is
 * promoted, but that is not what makes this safe: the backend's guard is, and
 * it has to be, because a double-click races the render.
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

  await promoteLead(env, lead)

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
    return html(page(`${lead.reference} — coord-portal`, detail(operator, lead, thread)), { status: 400 })
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

function detail(operator: Operator, lead: Lead, thread: ThreadContext | null): string {
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

  ${promoted ? "" : promoteForm(lead)}

  ${thread ? messageThreadSection(`/leads/${encodeURIComponent(lead.id)}/message`, thread, "operator") : ""}
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
  return `<form class="promote" method="POST" action="/leads/${encodeURIComponent(lead.id)}/promote" data-testid="promote-lead-form">
    <button type="submit" class="primary" data-testid="promote-button">Promote to submission</button>
  </form>`
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
