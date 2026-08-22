import { isBehindCloudflareEdge } from "../deployment"
import { parseFormData } from "../formData"
import { accessRefused, resolveSiteIdentity } from "../identity"
import { readOperator } from "../operators"
import { escapeHtml, html, page, topbar } from "../render"
import { createSubmission, getSubmission, type Submission } from "../submissions"
import type { Env } from "../types"
import { isOwnedBy } from "./submission"

/**
 * GET /intake — the new-submission form.
 *
 * Issue #9 was re-scoped from a live requirements chat to an asynchronous
 * form: "It is now asynchronous — a form, not a conversation." One write, no
 * back-and-forth — see the contract's mock `01-intake-form.html`, which this
 * mirrors field-for-field.
 *
 * Identity comes from `resolveSiteIdentity` (#1981): this whole hostname sits
 * behind the site Access application (docs/CLOUDFLARE.md), so a request that
 * reaches here at all behind Cloudflare's edge with no provable identity means
 * Access has already been bypassed or a token failed verification — refused,
 * not rendered with a guessed identity.
 *
 * `?from=<id>` (issue #109) is this route's one addition: "Start a follow-up"
 * on an existing submission's own detail screen (`routes/submission.ts`)
 * links here with it set, so the form the customer is about to fill in shows
 * which request it continues. Plain `/intake` — the dashboard's "New
 * request" CTA, and every link before this issue — carries no `from` at all
 * and behaves exactly as before.
 */
export async function intakeForm(request: Request, env: Env): Promise<Response> {
  const email = await resolveSiteIdentity(request, env)
  if (!email && isBehindCloudflareEdge(request)) return accessRefused()

  const followUpFrom = await resolveFollowUpTarget(request, env, email)
  // Additive to the ownership scoping above, never a substitute for it — see
  // `dashboard.ts`'s identical call for the full rationale (issue #103).
  const isOperator = (await readOperator(request, env)) !== null
  return html(
    page(
      "New request — coord-portal",
      renderForm(email, isOperator, EMPTY_DRAFT, undefined, followUpFrom),
    ),
  )
}

/**
 * Reads `?from=` and, only if it names a submission the caller actually
 * owns, returns it. Anything else — no param, an id that does not exist,
 * someone else's id, no signed-in identity at all — is treated the same as
 * no `from` at all: this route never errors or 404s on it, it just silently
 * falls back to an ordinary, standalone request. A stray or tampered `from`
 * is not the customer's fault and must not cost them the ability to file a
 * request at all.
 *
 * `isOwnedBy` is the identical check `submissionDetail` uses (imported from
 * `./submission`, not reimplemented) — a forged `from` gets no more trust
 * here than a forged submission URL gets there.
 */
async function resolveFollowUpTarget(
  request: Request,
  env: Env,
  email: string | null,
): Promise<Submission | null> {
  if (!email) return null
  const id = new URL(request.url).searchParams.get("from")
  if (!id) return null
  const origin = await getSubmission(env, id)
  return origin && isOwnedBy(origin, email) ? origin : null
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

function renderForm(
  email: string | null,
  isOperator: boolean,
  draft: DraftValues = EMPTY_DRAFT,
  error?: string,
  followUpFrom: Submission | null = null,
): string {
  const errorBlock = error
    ? `<p class="async-note" data-testid="intake-error" role="alert">${escapeHtml(error)}</p>`
    : ""
  const followUpNote = followUpFrom
    ? `<p class="async-note" data-testid="follow-up-note">Filing a follow-up to ${escapeHtml(followUpFrom.reference)} — the two will share one project history.</p>`
    : ""
  // The query string rides on the form's own `action` rather than a hidden
  // field: `from` is not user data, it is where this request came from, and
  // this way a plain page reload never loses it.
  const action = followUpFrom ? `/intake?from=${encodeURIComponent(followUpFrom.id)}` : "/intake"

  return `${topbar(email, "new", isOperator)}
<main>
  <h1>Describe what you want done</h1>
  <p class="lede">No live chat, no back-and-forth right now — write it once, and the team will follow up.</p>

  <p class="async-note" data-testid="async-note">
    This is a form, not a conversation. Submit it and go — you'll get an email
    the moment there's a design ready for you to look at.
  </p>
  ${followUpNote}
  ${errorBlock}

  <form class="intake" method="POST" action="${escapeHtml(action)}" data-testid="intake-form" aria-label="New request">
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
 *
 * `customerEmail` comes from `resolveSiteIdentity` (#1981), not
 * `readAccessIdentity`: this write attributes the new submission to whoever
 * it names, so behind Cloudflare's edge it must be the verified email, and a
 * request that cannot prove one is refused before anything is parsed or
 * written — see the module comment on `intakeForm`.
 */
export async function submitIntake(request: Request, env: Env): Promise<Response> {
  const email = await resolveSiteIdentity(request, env)
  if (!email && isBehindCloudflareEdge(request)) return accessRefused()

  const followUpFrom = await resolveFollowUpTarget(request, env, email)
  const isOperator = (await readOperator(request, env)) !== null

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
        renderForm(
          email,
          isOperator,
          EMPTY_DRAFT,
          "Please fill in every required field.",
          followUpFrom,
        ),
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
      page(
        "New request — coord-portal",
        renderForm(email, isOperator, draft, "Please fill in every required field.", followUpFrom),
      ),
      { status: 400 },
    )
  }

  const submission = await createSubmission(env, {
    customerEmail: email,
    outcome: draft.outcome,
    audience: draft.audience,
    doneDefinition: draft.doneDefinition,
    constraints: draft.constraints || null,
    projectScope: draft.projectScope || null,
    // The one deliberate trigger for issue #109's project grouping — see the
    // module comment on `resolveFollowUpTarget` and `NewSubmissionInput` in
    // `src/submissions.ts`. `null` (no `from`, or one that failed ownership)
    // is exactly today's behaviour: a fresh, standalone submission.
    followUpFrom: followUpFrom?.id ?? null,
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
