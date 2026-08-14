import { parseFormData } from "../formData"
import { readAccessIdentity } from "../identity"
import { escapeHtml, html, page, topbar } from "../render"
import { createSubmission } from "../submissions"
import type { Env } from "../types"

/**
 * GET /intake — the new-submission form.
 *
 * Issue #9 was re-scoped from a live requirements chat to an asynchronous
 * form: "It is now asynchronous — a form, not a conversation." One write, no
 * back-and-forth — see the contract's mock `01-intake-form.html`, which this
 * mirrors field-for-field.
 */
export function intakeForm(request: Request, _env: Env): Response {
  return html(page("New request — coord-portal", renderForm(request)))
}

interface DraftValues {
  outcome: string
  audience: string
  doneDefinition: string
  constraints: string
  projectScope: string
}

const EMPTY_DRAFT: DraftValues = {
  outcome: "",
  audience: "",
  doneDefinition: "",
  constraints: "",
  projectScope: "",
}

function renderForm(request: Request, draft: DraftValues = EMPTY_DRAFT, error?: string): string {
  const identity = readAccessIdentity(request)
  const errorBlock = error
    ? `<p class="async-note" data-testid="intake-error" role="alert">${escapeHtml(error)}</p>`
    : ""

  return `${topbar(identity.email, "new")}
<main>
  <h1>Describe what you want done</h1>
  <p class="lede">No live chat, no back-and-forth right now — write it once, and the team will follow up.</p>

  <p class="async-note" data-testid="async-note">
    This is a form, not a conversation. Submit it and go — you'll get an email
    the moment there's a design ready for you to look at.
  </p>
  ${errorBlock}

  <form class="intake" method="POST" action="/intake" data-testid="intake-form" aria-label="New request">
    <div class="field">
      <label for="outcome">What do you want done?</label>
      <textarea id="outcome" name="outcome" rows="4" required
        data-testid="field-outcome"
        placeholder="Describe the outcome in plain language — not a spec, just what you need.">${escapeHtml(draft.outcome)}</textarea>
    </div>

    <div class="field">
      <label for="audience">Who is this for?</label>
      <input id="audience" name="audience" type="text" required
        data-testid="field-audience"
        value="${escapeHtml(draft.audience)}"
        placeholder="e.g. our support team, our end customers, just me">
    </div>

    <div class="field">
      <label for="doneDefinition">What does &ldquo;done&rdquo; look like?</label>
      <textarea id="doneDefinition" name="doneDefinition" rows="3" required
        data-testid="field-done-definition"
        placeholder="How will you know this is finished?">${escapeHtml(draft.doneDefinition)}</textarea>
    </div>

    <div class="field">
      <label for="constraints">Constraints <span class="optional-tag">optional</span></label>
      <textarea id="constraints" name="constraints" rows="2"
        data-testid="field-constraints"
        placeholder="Budget, deadline, tools you already use, anything off-limits.">${escapeHtml(draft.constraints)}</textarea>
    </div>

    <div class="field">
      <label for="projectScope">Project area <span class="optional-tag">optional</span></label>
      <input id="projectScope" name="projectScope" type="text"
        data-testid="field-project-scope"
        value="${escapeHtml(draft.projectScope)}"
        placeholder="If you know which product or area this touches">
    </div>

    <div class="actions">
      <button type="submit" class="primary" data-testid="submit-intake">Send to the team</button>
    </div>
  </form>
</main>`
}

/**
 * POST /intake — creates a submission and redirects to its detail route.
 *
 * Transport-agnostic per contract note 3 (no JSON field schema is pinned): a
 * plain HTML form post, so the round trip works with no client-side script at
 * all — "a form, not a conversation" all the way down. A 303 turns the
 * follow-up into a GET, so a reload of the receipt never resubmits the form.
 *
 * Required-field enforcement mirrors the mock's `required` attributes so a
 * browser blocks an empty submission before it is ever sent; this handler
 * re-checks server-side (a client is never trusted) and, on a request that
 * skips validation entirely, redisplays the form instead of creating a
 * half-empty submission.
 */
export async function submitIntake(request: Request, env: Env): Promise<Response> {
  // Issue #71: the identical unguarded `request.formData()` throws a raw
  // `TypeError` on a malformed body. This route already has a
  // malformed-request shape — the required-field message below — so a parse
  // failure is not a distinct message, "do not invent a new one": it's
  // treated exactly like a submission that skipped every required field.
  const form = await parseFormData(request)
  if (!form) {
    return html(
      page(
        "New request — coord-portal",
        renderForm(request, EMPTY_DRAFT, "Please fill in every required field."),
      ),
      { status: 400 },
    )
  }

  const draft: DraftValues = {
    outcome: stringField(form, "outcome"),
    audience: stringField(form, "audience"),
    doneDefinition: stringField(form, "doneDefinition"),
    constraints: stringField(form, "constraints"),
    projectScope: stringField(form, "projectScope"),
  }

  if (!draft.outcome || !draft.audience || !draft.doneDefinition) {
    return html(
      page("New request — coord-portal", renderForm(request, draft, "Please fill in every required field.")),
      { status: 400 },
    )
  }

  const identity = readAccessIdentity(request)
  const submission = await createSubmission(env, {
    customerEmail: identity.email,
    outcome: draft.outcome,
    audience: draft.audience,
    doneDefinition: draft.doneDefinition,
    constraints: draft.constraints || null,
    projectScope: draft.projectScope || null,
  })

  return new Response(null, {
    status: 303,
    headers: { location: `/submissions/${submission.id}` },
  })
}

function stringField(form: FormData, name: string): string {
  const value = form.get(name)
  return typeof value === "string" ? value.trim() : ""
}
