import { readAccessIdentity } from "../identity"
import { listOutboxForCustomer, type OutboxEmail } from "../notifications"
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
 */
export async function outbox(request: Request, env: Env): Promise<Response> {
  const identity = readAccessIdentity(request)
  const emails = identity.email ? await listOutboxForCustomer(env, identity.email) : []
  return html(page("Outbox — coord-portal", outboxPage(identity.email, emails)))
}

function outboxPage(email: string | null, emails: OutboxEmail[]): string {
  const body =
    emails.length > 0
      ? emails.map(emailPreview).join("\n")
      : `    <p class="lede" data-testid="outbox-empty">Nothing sent yet.</p>`

  return `${topbar(email, "outbox")}
<main>
  <h1>Sent emails</h1>
  <div data-testid="outbox-list">
${body}
  </div>
</main>`
}

/**
 * One `email-preview`, in exactly the DOM `mocks/11-email-signoff-ready.html`,
 * `12-email-needs-input.html` and `13-email-shipped.html` pin: `email-from`,
 * `email-to`, `email-subject`, `email-preheader`, `email-body`, `email-cta`,
 * all inside one element carrying `data-email-type`.
 */
function emailPreview(sent: OutboxEmail): string {
  return `    <article class="email" data-testid="email-preview" data-email-type="${escapeHtml(sent.type)}">
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
