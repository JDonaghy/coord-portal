import { isBehindCloudflareEdge } from "../deployment"
import { accessRefused, resolveSiteIdentity } from "../identity"
import { DELIVERY_STATUS_TEXT, listOutboxForCustomer, type OutboxEmail } from "../notifications"
import { readOperator } from "../operators"
import { escapeHtml, html, page, topbar } from "../render"
import type { Env } from "../types"

/**
 * `GET /outbox` — issue #14's read-back surface.
 *
 * Not a pinned route: the Gate-A contract pins the email DOM (`email-preview`
 * with `data-email-type` / `email-from` / `email-to` / `email-subject` /
 * `email-preheader` / `email-body` / `email-cta`, § `data-testid` hooks) and
 * pins that a test may assert no other status transition produces that DOM
 * (§ "Customer status vocabulary"), but pins no route that renders it — every
 * mock under `mocks/11-13` is annotated "not a portal route — rendered as an
 * inbox preview for review purposes". This route is that inbox preview:
 * black-box observability into what the portal decided to send, standing in
 * for the real inbox nothing in this repo can otherwise reach.
 *
 * Scoped to the caller's own sends, `to_email = ` the signed-in Access
 * identity — the same shape `GET /submissions` uses for issue #12's "a
 * customer can only ever see their own". A notification is the one surface
 * where that guarantee leaves the site (an address is exported to a real
 * inbox that no later fix can recall), so it is scoped at least as tightly as
 * everything else, not less.
 *
 * Scoped by `resolveSiteIdentity` (#1981), not `readAccessIdentity` — the
 * verified email behind Cloudflare's edge, since an unverified claim scoping
 * who sees which sent addresses is exactly the surface issue #108 is about.
 */
export async function outbox(request: Request, env: Env): Promise<Response> {
  const email = await resolveSiteIdentity(request, env)
  if (!email && isBehindCloudflareEdge(request)) return accessRefused()

  const emails = email ? await listOutboxForCustomer(env, email) : []
  // Additive to the ownership scoping above, never a substitute for it — see
  // `dashboard.ts`'s identical call for the full rationale (issue #103).
  const isOperator = (await readOperator(request, env)) !== null
  return html(page("Outbox — coord-portal", outboxPage(email, isOperator, emails)))
}

function outboxPage(email: string | null, isOperator: boolean, emails: OutboxEmail[]): string {
  const body =
    emails.length > 0
      ? emails.map(emailPreview).join("\n")
      : `    <p class="lede" data-testid="outbox-empty">Nothing sent yet.</p>`

  return `${topbar(email, "outbox", isOperator)}
<main>
  <h1>Sent emails</h1>
  <div data-testid="outbox-list">
${body}
  </div>
</main>`
}

/**
 * Customer-safe, generic copy for `delivery-last-error` — deliberately NOT
 * `outbox.last_error` verbatim. That column holds whatever raw string the
 * provider or an unset key produced ("Resend API returned 401",
 * "RESEND_API_KEY unset", a fetch failure) — operator-debugging material, per
 * contract § "Customer-safe error copy", not customer copy. Exact wording is
 * not pinned by that section, only that it must never name the provider, a
 * transport verb, a bare HTTP status code, "provider" or "endpoint".
 */
const CUSTOMER_SAFE_FAILURE_COPY =
  "We couldn't deliver this message and have stopped trying. You can still check your request below."

/**
 * One `email-preview`, in exactly the DOM `mocks/11-email-signoff-ready.html`,
 * `12-email-needs-input.html` and `13-email-shipped.html` pin (ms-1, issue
 * #14): `email-from`, `email-to`, `email-subject`, `email-preheader`,
 * `email-body`, `email-cta`, all inside one element carrying
 * `data-email-type` — unchanged here, still all present regardless of
 * delivery status.
 *
 * Extended by issue #49 (`tests/acceptance/ms-3/contract.md` § `data-testid`
 * hooks, mocks `01`-`04`): the article also carries `data-status`, and a new
 * `.email-delivery` block holds the `delivery-status` pill (always present)
 * plus, present if and only if the row is in that state, `delivery-sent-at`
 * (`sent`) or `delivery-attempts` + `delivery-last-error` (`failed`). A
 * `queued` row renders none of the three detail hooks — "renders identically
 * regardless of `attempts`", per the contract, because a retry in progress
 * conveys nothing actionable to a customer.
 */
function emailPreview(sent: OutboxEmail): string {
  return `    <article class="email" data-testid="email-preview" data-email-type="${escapeHtml(sent.type)}" data-status="${escapeHtml(sent.status)}">
      <div class="email-delivery">
        <span class="delivery-pill" data-testid="delivery-status" data-status="${escapeHtml(sent.status)}">${DELIVERY_STATUS_TEXT[sent.status]}</span>${deliveryDetail(sent)}
      </div>${deliveryError(sent)}
      <div class="email-meta">
        <dl>
          <dt>From</dt><dd data-testid="email-from">${escapeHtml(sent.from)}</dd>
          <dt>To</dt><dd data-testid="email-to">${escapeHtml(sent.to)}</dd>
        </dl>
      </div>
      <h2 class="email-subject" data-testid="email-subject">${escapeHtml(sent.subject)}</h2>
      <p class="email-preheader" data-testid="email-preheader">${escapeHtml(sent.preheader)}</p>
      <div class="email-body" data-testid="email-body">
        <p>${escapeHtml(sent.body)}</p>
        <a class="email-cta" href="${escapeHtml(sent.ctaHref)}" data-testid="email-cta">${escapeHtml(sent.ctaText)}</a>
      </div>
    </article>`
}

/** `delivery-sent-at` on a `sent` row, `delivery-attempts` on a `failed` one, nothing on `queued`. */
function deliveryDetail(sent: OutboxEmail): string {
  if (sent.status === "sent") {
    // `sentAt` is documented (`src/notifications.ts`'s `OutboxEmail.sentAt`) as
    // "present iff `status = \"sent\"`" — nothing in this repo today can
    // produce a `sent` row with a null `sentAt` (#49's own scope: only #50's
    // drain will ever write this transition). The `?? sent.queuedAt` fallback
    // below is defensive only, so a future drain bug that flips `status` to
    // `sent` without also setting `sent_at` renders a plausible-looking
    // decision time instead of visibly breaking — worth revisiting once #50
    // lands and that combination becomes reachable.
    return `
        <span class="delivery-detail" data-testid="delivery-sent-at">Delivered ${escapeHtml(sent.sentAt ?? sent.queuedAt)}</span>`
  }
  if (sent.status === "failed") {
    const times = sent.attempts === 1 ? "time" : "times"
    return `
        <span class="delivery-detail" data-testid="delivery-attempts">We tried ${sent.attempts} ${times}</span>`
  }
  return ""
}

/** `delivery-last-error`, present only on a `failed` row — customer-safe copy, never the raw column. */
function deliveryError(sent: OutboxEmail): string {
  if (sent.status !== "failed") return ""
  return `
      <p class="delivery-note" data-testid="delivery-last-error">${escapeHtml(CUSTOMER_SAFE_FAILURE_COPY)}</p>`
}
