import { createLead } from "../leads"
import { clientIp, isRateLimited } from "../rateLimit"
import { escapeHtml, html, page, publicHeader } from "../render"
import { TURNSTILE_FIELD, publicSitekey, verifySubmission } from "../turnstile"
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
 * ── THE BOT GATE AND RATE LIMIT (issue #32) ─────────────────────────────────
 * `POST /start` is checked, in order, before anything is written:
 *   1. the coarse per-IP rate limit (`src/rateLimit.ts`) — cheapest check,
 *      runs first so a sustained flood never reaches `siteverify` or a D1
 *      write for the lead itself;
 *   2. Turnstile's `siteverify` (`src/turnstile.ts`) — "verified server-side
 *      in the Worker, not merely rendered client-side," so this fires for a
 *      caller who never loaded `/start` and never ran the widget's script;
 *   3. the pre-existing #31 field validation (missing `summary`/`email`).
 * The first two share one outcome and one rendered banner, `REJECTION_BANNER`
 * below — "the response never confirms *which* check a caller tripped."
 * Validation failures keep their own, different message; that split is the
 * contract's "two failure families, one rendered shape" for (1)/(2) only.
 */
export function startForm(request: Request, env: Env): Response {
  return html(page("Get in touch — coord-portal", renderForm(request, env)))
}

interface DraftValues {
  summary: string
  email: string
  name: string
}

const EMPTY_DRAFT: DraftValues = { summary: "", email: "", name: "" }

/**
 * The one banner every bot-gate or rate-limit refusal renders — contract.md's
 * "one generic message for every one of those reasons ... specifically so the
 * response never confirms *which* check a caller tripped." Never reused for
 * the validation-failure family, which keeps its own, different wording.
 */
const REJECTION_BANNER = "We couldn't send that — please try again."

function renderForm(
  request: Request,
  env: Env,
  draft: DraftValues = EMPTY_DRAFT,
  error?: string,
): string {
  const errorBlock = error
    ? `<p class="lead-error" data-testid="lead-error" role="alert">${escapeHtml(error)}</p>`
    : ""
  const sitekey = publicSitekey(request, env)

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

    <div class="turnstile-block">
      <div class="cf-turnstile" data-testid="turnstile-widget" data-sitekey="${escapeHtml(sitekey)}"></div>
    </div>

    <div class="actions">
      <button type="submit" class="primary" data-testid="submit-lead">Send</button>
    </div>
  </form>
</main>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`
}

/**
 * `POST /start` renders the receipt directly, at 200 — never a redirect.
 * Issue #31's Scope names exactly two routes ("that is the whole surface"),
 * so there is no `GET /start/:id` for a stranger to land on.
 */
export async function submitStart(request: Request, env: Env): Promise<Response> {
  // 1. The rate limit — cheapest, coarsest check, so a flood never reaches
  // `siteverify` or a D1 write for the lead itself. Recorded and checked
  // before the body is even parsed.
  const ip = clientIp(request)
  if (await isRateLimited(env, ip)) {
    return html(
      page("Get in touch — coord-portal", renderForm(request, env, EMPTY_DRAFT, REJECTION_BANNER)),
      { status: 429 },
    )
  }

  const form = await request.formData()
  const draft: DraftValues = {
    summary: stringField(form, "summary"),
    email: stringField(form, "email"),
    name: stringField(form, "name"),
  }

  // 2. Turnstile, "before anything is written": a missing, empty, malformed,
  // reused, or unverifiable token all collapse to the same generic refusal —
  // "says so plainly without explaining what a valid token would look like."
  const token = stringField(form, TURNSTILE_FIELD)
  if (!(await verifySubmission(request, env, token))) {
    return html(
      page("Get in touch — coord-portal", renderForm(request, env, draft, REJECTION_BANNER)),
      { status: 400 },
    )
  }

  // 3. Issue #31's own field validation — a different, distinct message, so
  // this is never merged into the bot-gate banner above.
  if (!draft.summary || !draft.email) {
    return html(
      page(
        "Get in touch — coord-portal",
        renderForm(request, env, draft, "Please fill in every required field."),
      ),
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
