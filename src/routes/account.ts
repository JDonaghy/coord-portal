import { getClientByEmail, saveClientProfile, type Client } from "../clients"
import { isBehindCloudflareEdge } from "../deployment"
import { parseFormData } from "../formData"
import { accessRefused, resolveSiteIdentity } from "../identity"
import { isOperatorEmail } from "../operators"
import { escapeHtml, html, page, topbar } from "../render"
import type { Env } from "../types"

/**
 * `GET /account` and `POST /account` — issue #131's self-service client
 * profile: "a signed-in client can view and edit their own `clients` row:
 * phone, cc emails, address." No new auth code — the same
 * `resolveSiteIdentity` gate every other authenticated customer route uses
 * (`src/routes/dashboard.ts`, `submission.ts`), per CLAUDE.md and #131's own
 * wording. Email is read-only here: it *is* the Access identity, not a field
 * this form can change — there is no code path anywhere in this route that
 * writes `clients.email`.
 *
 * ── THE "NO `clients` ROW YET" GAP (Gate-A contract, ms-4) ──────────────────
 * #129 (lead promotion) is, today, the only path that ever creates a
 * `clients` row, and only on promotion. A customer who predates this
 * milestone, or who has only ever used `/intake` directly, has no row at all.
 * Per the milestone's Gate-A contract ("A gap #131 leaves open, resolved
 * here"), `GET /account` renders the form with every optional field blank
 * when no row exists, and `POST /account` creates one on first save rather
 * than 404ing — see `saveClientProfile` in `src/clients.ts` for how that first
 * save stays race-safe.
 */
export async function accountProfile(request: Request, env: Env): Promise<Response> {
  const email = await resolveSiteIdentity(request, env)
  if (!email && isBehindCloudflareEdge(request)) return accessRefused()

  const client = email ? await getClientByEmail(env, email) : null
  // Additive to the ownership scoping above, never a substitute for it — see
  // `dashboard.ts`'s identical call, and `isOperatorEmail` in
  // `src/operators.ts`, for the full rationale (issue #103).
  const isOperator = isOperatorEmail(email, request, env)
  return html(page("My profile — coord-portal", accountPage(email, isOperator, client)))
}

/**
 * `POST /account` writes phone / cc emails / address and 303s back to
 * `GET /account` — the same PRG convention every other form in this portal
 * follows (`submitSubmissionAction`, `promoteLeadAction`, `submitStart`), so a
 * reload of the result never resubmits the save.
 *
 * Unlike the GET above, a missing identity always refuses here, edge or not:
 * there is no owning row for an anonymous write to land on (`clients.email`
 * is `NOT NULL UNIQUE`), so "render an empty state" — the off-edge fallback
 * `GET /account` and `GET /submissions` both take — has no equivalent for a
 * write. `accessRefused()` is reused for exactly the shape it already
 * documents: an opaque, empty-body 401 that tells a caller nothing about
 * which check failed.
 */
export async function submitAccountProfile(request: Request, env: Env): Promise<Response> {
  const email = await resolveSiteIdentity(request, env)
  if (!email) return accessRefused()

  // `request.formData()` throws a raw `TypeError` — an unhandled 500 — on a
  // request with no parseable form body (issue #46/#71). `parseFormData`
  // turns that into `null`; this route re-renders the same page with the
  // caller's existing (unsaved) state rather than ever 500ing.
  const form = await parseFormData(request)
  if (!form) {
    const client = await getClientByEmail(env, email)
    const isOperator = isOperatorEmail(email, request, env)
    return html(page("My profile — coord-portal", accountPage(email, isOperator, client)), {
      status: 400,
    })
  }

  await saveClientProfile(env, email, {
    phone: optionalField(form, "phone"),
    ccEmails: optionalField(form, "ccEmails"),
    address: optionalField(form, "address"),
  })

  return new Response(null, { status: 303, headers: { location: "/account" } })
}

/** A blank/whitespace-only field is stored as `null`, not `""` — same convention `src/routes/start.ts` uses for a lead's optional `name`. */
function optionalField(form: FormData, name: string): string | null {
  const value = form.get(name)
  const trimmed = typeof value === "string" ? value.trim() : ""
  return trimmed === "" ? null : trimmed
}

function accountPage(email: string | null, isOperator: boolean, client: Client | null): string {
  const identity = email ?? ""
  return `${topbar(email, "account", isOperator)}
<main>
  <div class="page-head">
    <h1>My profile</h1>
  </div>
  <p class="lede">
    These details help us reach you and keep your projects organized. Nothing here is required —
    add whatever's useful.
  </p>

  <form class="account" method="POST" action="/account" data-testid="account-form">
    <div class="field">
      <label for="email">Email</label>
      <input type="email" id="email" value="${escapeHtml(identity)}" readonly data-testid="account-email">
      <span class="hint">This is your sign-in address and can't be changed here.</span>
    </div>

    <div class="field">
      <label for="phone">Phone <span class="optional-tag">Optional</span></label>
      <input type="tel" id="phone" name="phone" value="${escapeHtml(client?.phone ?? "")}"
        data-testid="account-phone-field">
    </div>

    <div class="field">
      <label for="ccEmails">CC emails <span class="optional-tag">Optional</span></label>
      <input type="text" id="ccEmails" name="ccEmails" value="${escapeHtml(client?.ccEmails ?? "")}"
        placeholder="billing@example.test, ops@example.test" data-testid="account-cc-emails-field">
      <span class="hint">Comma-separated. These addresses are copied on project emails.</span>
    </div>

    <div class="field">
      <label for="address">Address <span class="optional-tag">Optional</span></label>
      <textarea id="address" name="address" rows="3" placeholder="Mailing or billing address"
        data-testid="account-address-field">${escapeHtml(client?.address ?? "")}</textarea>
    </div>

    <div class="actions">
      <button type="submit" class="primary" data-testid="account-save-button">Save</button>
    </div>
  </form>
</main>`
}
