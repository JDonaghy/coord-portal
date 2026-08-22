import { DELIVERY_STATUS_TEXT, listAllOutbox, type OutboxEmail } from "../notifications"
import { readOperator, type Operator } from "../operators"
import { escapeHtml, html, operatorTopbar, page } from "../render"
import type { Env } from "../types"
import { leadsNotFound } from "./leads"

/**
 * `GET /deliveries` — issue #55, the operator's counterpart to `/outbox`.
 *
 * #49's own motivating line was "the operator has no way to see a stuck
 * notification." `GET /outbox` (`src/routes/outbox.ts`) answers "what did
 * you get" for one signed-in customer and structurally cannot answer "what
 * is stuck" — it is scoped to `to_email = ` the caller's own Access identity.
 * This route is the other half: every `outbox` row, every customer, on one
 * screen, for the one kind of caller who is allowed to see across that
 * boundary.
 *
 * ── AUTH: NOT A NEW MECHANISM ────────────────────────────────────────────
 * #55's own text: "This is not new auth — reuse the `/leads` precedent."
 * Same `readOperator` gate `src/routes/leads.ts` already uses, same
 * indistinguishable 404 (`leadsNotFound()`) for anyone it rejects — an
 * anonymous caller, a customer who owns rows in the very list they were
 * refused, or (with no `OPERATOR_EMAILS`/`OPERATOR_EMAIL` configured, behind
 * Cloudflare's edge) literally everyone. No new environment variable, no new
 * identity concept — see `src/operators.ts`.
 *
 * ── THE ONE THING THIS SCREEN MAY SHOW THAT `/outbox` MAY NOT ───────────
 * `delivery-last-error` here is `outbox.last_error` **verbatim** — the raw
 * provider/config string ms-3's contract keeps off the customer-scoped page
 * (its FORBIDDEN vocabulary: `resend`, `api key`, `fetch`, `provider`,
 * `endpoint`, a bare 3-digit status code). `src/routes/outbox.ts` redacts
 * that column into `CUSTOMER_SAFE_FAILURE_COPY`; this route never calls that
 * redaction and never imports it. That is deliberate, not an oversight: #55
 * "Keep the two rendering paths separate. Do not parameterise one path with
 * an `isOperator` flag" — a shared function taking a boolean is a single
 * place that can pass the wrong value and leak the provider's identity onto
 * a customer's screen, and nothing in the sealed customer-facing suite would
 * necessarily catch a leak that originates from this route's own call site.
 * So the two screens each own their own rendering of the same underlying
 * `OutboxEmail`, and only the status vocabulary (`DELIVERY_STATUS_TEXT`,
 * `src/notifications.ts`) — which carries no customer-safety weight — is
 * shared between them.
 *
 * `src/render.ts`'s `topbar(email, current, isOperator)` (issue #103) is an
 * `isOperator`-flag function in that same shape, but this route does not
 * call it — it renders with `operatorTopbar()`, the unmerged operator-only
 * header, precisely because the sealed ms-3 issue #55 oracle for this screen
 * (`expectOperatorTopbar` in `tests/acceptance/ms-3/
 * 55-operator-deliveries.spec.ts`) forbids the customer nav hooks that
 * `topbar()` would carry. So the two paragraphs above stay true here: this
 * route's own rendering never takes an `isOperator` boolean.
 *
 * ── SCOPE ─────────────────────────────────────────────────────────────────
 * Read-only. No retry, no requeue, no resend button: ms-3's contract pins
 * `failed` as terminal with no path back, and a write here would silently
 * amend an approved contract from a different milestone (#55's own "Out").
 * No filtering, search or pagination either — #55 puts all three out of
 * scope until the volume exists to justify them.
 */
export async function deliveries(request: Request, env: Env): Promise<Response> {
  const operator = await readOperator(request, env)
  if (!operator) return leadsNotFound()

  const rows = await listAllOutbox(env)
  return html(page("Deliveries — coord-portal", deliveriesPage(operator, rows)))
}

function deliveriesPage(operator: Operator, rows: OutboxEmail[]): string {
  return `${operatorTopbar(operator.email, "deliveries")}
<main>
  <div class="page-head">
    <h1>Deliveries</h1>
  </div>
  <p class="lede">Every notification the portal has decided to send, across every customer, most recent activity first. This is the diagnostic view — <code>/outbox</code> is what a customer sees; this is what a stuck one looks like.</p>
  ${rows.length > 0 ? deliveriesList(rows) : emptyDeliveries()}
</main>`
}

function deliveriesList(rows: OutboxEmail[]): string {
  return `<ul class="deliveries-list" data-testid="deliveries-list">
${rows.map(deliveryRow).join("\n")}
  </ul>`
}

/**
 * Present instead of `deliveries-list`, never alongside it — mirrors
 * `src/routes/leads.ts`'s `emptyInbox()` (`leads-list` / `leads-list-empty`),
 * not `src/routes/outbox.ts`'s always-present container. Reachable only when
 * `outbox` is empty across every customer, which no sealed acceptance run can
 * exercise (the suite seeds rows before this file's own tests run) — same gap
 * `ms-2`'s lead-triage slice records for `leads-list-empty`.
 */
function emptyDeliveries(): string {
  return `<p class="lede" data-testid="deliveries-list-empty">Nothing in the outbox yet.</p>`
}

/**
 * One `delivery-row` per outbox row. Contract § "The operator delivery view",
 * "Row surface": deliberately NOT the full `email-preview` DOM `/outbox`
 * renders — no `email-body`, `email-preheader` or `email-cta`. An operator
 * triaging a stuck send needs enough to identify and diagnose the row
 * (recipient, subject, delivery state), not a rendered copy of the
 * transactional content.
 *
 * `delivery-status` is always present, same three slugs and exact text as
 * `/outbox`. `delivery-sent-at` is present iff `sent`; `delivery-attempts`
 * and `delivery-last-error` are present iff `failed` — same presence rules
 * `/outbox` uses, just read off the unscoped row instead of the scoped one.
 * `delivery-provider-id` is additive only (not contract-mandated) — shown
 * when a `sent` row actually has one, since an operator quoting a delivery
 * back to the provider needs it and #55's Scope names `provider_message_id`
 * as exactly the kind of raw diagnostic this screen exists for.
 */
function deliveryRow(row: OutboxEmail): string {
  return `    <li>
      <div class="delivery-row" data-testid="delivery-row" data-status="${escapeHtml(row.status)}">
        <div class="row-top">
          <div class="row-main">
            <span class="subject" data-testid="delivery-subject">${escapeHtml(row.subject)}</span>
            <span class="meta" data-testid="delivery-recipient">${escapeHtml(row.to)}</span>
          </div>
          <div class="row-side">
            <span class="delivery-pill" data-testid="delivery-status" data-status="${escapeHtml(row.status)}">${DELIVERY_STATUS_TEXT[row.status]}</span>${deliveryDetail(row)}
          </div>
        </div>${deliveryFooter(row)}
      </div>
    </li>`
}

/** `delivery-sent-at` on a `sent` row, `delivery-attempts` on a `failed` one, nothing on `queued`. */
function deliveryDetail(row: OutboxEmail): string {
  if (row.status === "sent") {
    // Same defensive `?? queuedAt` fallback `src/routes/outbox.ts`'s
    // `deliveryDetail` uses, and for the same reason: nothing in this repo
    // today can produce a `sent` row with a null `sentAt`, but if #50's drain
    // ever did, this renders a plausible decision time instead of visibly
    // breaking the operator's own diagnostic screen.
    return `
            <span class="delivery-detail" data-testid="delivery-sent-at">Delivered ${escapeHtml(row.sentAt ?? row.queuedAt)}</span>`
  }
  if (row.status === "failed") {
    const times = row.attempts === 1 ? "time" : "times"
    return `
            <span class="delivery-detail" data-testid="delivery-attempts">We tried ${row.attempts} ${times}</span>`
  }
  return ""
}

/**
 * The raw provider error on a `failed` row — THE pinned point of divergence
 * from `/outbox`, per the module comment above — and, additively, the
 * provider message id on a `sent` row.
 */
function deliveryFooter(row: OutboxEmail): string {
  if (row.status === "failed") {
    return `
        <p class="delivery-error" data-testid="delivery-last-error">${escapeHtml(row.lastError ?? "")}</p>`
  }
  if (row.status === "sent" && row.providerMessageId) {
    return `
        <span class="delivery-provider-id" data-testid="delivery-provider-id">provider id: ${escapeHtml(row.providerMessageId)}</span>`
  }
  return ""
}
