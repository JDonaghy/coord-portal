import { createLead } from "../leads"
import { escapeHtml, html, page, publicHeader } from "../render"
import type { Env } from "../types"

/**
 * `GET /start` and `POST /start` — issue #31's whole public surface: "A
 * stranger can describe what they want and hear back, without creating an
 * account." `GET /start` renders the form; `POST /start` records a **lead**
 * and shows a receipt with a reference the person can quote in an email.
 *
 * Deliberately never calls `readAccessIdentity` (or anything else
 * Access-related): "Access stays exactly as it is for the authenticated
 * portal; this route simply never authenticates." An Access identity that
 * happens to be present on the request changes nothing about what renders —
 * see the sealed acceptance slice's "an Access identity changes nothing on
 * the public route".
 *
 * No Turnstile widget and no rate limit here — issue #31's own "Out of scope"
 * names both as #32's issue and says "do not build ahead into them." The one
 * failure mode this route owns is a missing required field, handled the same
 * way `POST /intake` handles it (`src/routes/intake.ts`, `submitIntake`):
 * re-checked server-side, redisplaying the form on a request that skips the
 * browser's own `required` attributes.
 *
 * A lead is inert: `createLead` writes exactly one row (see `src/leads.ts`)
 * — no submission, no bridge event, nothing dispatched. Promotion is a
 * deliberate operator act that is a different issue (#33) entirely.
 */
export function startForm(_request: Request, _env: Env): Response {
  return html(page("Get in touch — coord-portal", renderForm()))
}

interface DraftValues {
  summary: string
  email: string
  name: string
}

const EMPTY_DRAFT: DraftValues = { summary: "", email: "", name: "" }

function renderForm(draft: DraftValues = EMPTY_DRAFT, error?: string): string {
  const errorBlock = error
    ? `<p class="lead-error" data-testid="lead-error" role="alert">${escapeHtml(error)}</p>`
    : ""

  return `${publicHeader()}
<main>
  <h1>Tell us what you need</h1>
  <p class="lede">No account, no login — just say what you're trying to get done and how to
    reach you. A person reads every one of these.</p>

  <p class="async-note" data-testid="async-note">
    This isn't live chat. Send it and you're done — replies come by email, not right away,
    and there's nothing to check back on.
  </p>
  ${errorBlock}

  <form class="lead" method="POST" action="/start" data-testid="lead-form" aria-label="Get in touch">
    <div class="field">
      <label for="summary">What are you trying to get done?</label>
      <textarea id="summary" name="summary" rows="4" required
        data-testid="field-lead-summary"
        placeholder="Plain language is fine — what do you want built or fixed?">${escapeHtml(draft.summary)}</textarea>
    </div>

    <div class="field">
      <label for="email">Best email to reach you</label>
      <input id="email" name="email" type="email" required
        data-testid="field-lead-email"
        value="${escapeHtml(draft.email)}"
        placeholder="you@example.com">
    </div>

    <div class="field">
      <label for="name">Name <span class="optional-tag">optional</span></label>
      <input id="name" name="name" type="text"
        data-testid="field-lead-name"
        value="${escapeHtml(draft.name)}"
        placeholder="So we know what to call you">
    </div>

    <div class="actions">
      <button type="submit" class="primary" data-testid="submit-lead">Send</button>
    </div>
  </form>
</main>`
}

/**
 * `POST /start` renders the receipt directly, at 200 — never a redirect.
 * Issue #31's Scope names exactly two routes ("that is the whole surface"),
 * so there is no `GET /start/:id` for a stranger to land on.
 */
export async function submitStart(request: Request, env: Env): Promise<Response> {
  const form = await request.formData()
  const draft: DraftValues = {
    summary: stringField(form, "summary"),
    email: stringField(form, "email"),
    name: stringField(form, "name"),
  }

  if (!draft.summary || !draft.email) {
    return html(
      page("Get in touch — coord-portal", renderForm(draft, "Please fill in every required field.")),
      { status: 400 },
    )
  }

  const lead = await createLead(env, {
    summary: draft.summary,
    email: draft.email,
    name: draft.name || null,
  })

  return html(page("Thanks — coord-portal", receipt(lead.reference)))
}

function receipt(reference: string): string {
  return `${publicHeader()}
<main>
  <section class="receipt" data-testid="lead-receipt">
    <h1>Got it — thanks for reaching out</h1>
    <p class="ref" data-testid="lead-reference">Reference ${escapeHtml(reference)}</p>
    <p class="lede">
      There's no account to check and nothing to log into. If you want to follow up,
      just quote <strong>${escapeHtml(reference)}</strong> in an email and it'll find its way back to this.
    </p>
    <div class="actions">
      <a class="button secondary" href="/" data-testid="back-home">Back home</a>
    </div>
  </section>
</main>`
}

function stringField(form: FormData, name: string): string {
  const value = form.get(name)
  return typeof value === "string" ? value.trim() : ""
}
