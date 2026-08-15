import { escapeHtml } from "./render"
import type { Env } from "./types"

/**
 * The provider seam — issue #51's own scope, built here because issue #50's
 * drain has nothing to call without it and nothing else in this repo defines
 * it yet (`tests/acceptance/ms-3/manifest.yml`'s own note to #51's future
 * author: "#50's block below already exercises the fake's pinned black-box
 * behaviour end to end... because that is the only lever #50's own
 * transitions can be driven with"). #51, when it lands, owns hardening this
 * further (fail-closed edge cases, `MAIL_PROVIDER` selection itself) — not
 * re-inventing the interface.
 *
 * `MailProvider` is deliberately the smallest interface that lets `src/drain.ts`
 * be provider-agnostic: one method, one outcome shape. Nothing about retries,
 * backoff or give-up lives here — that is entirely the drain's job, per issue
 * #50's own Scope ("retries with backoff and gives up after N attempts").
 */
export interface OutboundEmail {
  to: string
  from: string
  subject: string
  body: string
  /**
   * Where a reply should go, when that is not the `from` address (issue #52 —
   * see `Env.REPLY_TO`). Optional: a provider that receives no value must send
   * no `Reply-To` header rather than inventing one, so mail keeps working
   * unchanged wherever the var is not declared.
   */
  replyTo?: string
  /**
   * The call to action this email is about (issue #83) — the customer-visible
   * link back to the submission, and its label. `src/drain.ts` reads these off
   * `outbox.cta_text` / `outbox.cta_href` and is the only caller that ever
   * sets them.
   *
   * Both optional, and only ever present or absent together: `ctaHref` MUST
   * already be an absolute URL by the time it reaches this interface —
   * resolving `outbox.cta_href`'s root-relative form against a configured
   * base URL is `src/drain.ts`'s job (#83 scope item 2), not this seam's, and
   * a provider implementation here must never invent an origin on its own.
   * Absent when the row predates #83, or when `env.PUBLIC_BASE_URL` is unset
   * at send time — either way the email that goes out must carry no link at
   * all, not a broken one (#83, "The decision this needs").
   */
  ctaText?: string
  ctaHref?: string
}

/**
 * The plain-text body actually handed to the provider (#83 scope item 3): the
 * notification's own copy, plus — when a call to action is present — that CTA
 * rendered as visible text with its full, followable URL. Issue #83's own
 * words: "The text part must still carry the URL in full, visibly — a
 * text-only client, and every 'view original' reader, must be able to reach
 * the submission. A bare `<a>` with the URL hidden behind link text fails
 * that" — so the URL is written out here, not merely referenced.
 *
 * No CTA present ⇒ identical to `email.body`, the exact text this repo sent
 * before #83.
 */
export function composeTextBody(email: OutboundEmail): string {
  if (!email.ctaHref) return email.body
  const label = email.ctaText ?? "View this submission"
  return `${email.body}\n\n${label}: ${email.ctaHref}`
}

/**
 * The HTML body handed alongside the text one (#83 scope item 3: "Resend
 * takes `html` and `text` together" — today's `ResendMailProvider` posted
 * `text` only, which is why the CTA had nowhere to be a clickable link even
 * once carried). `undefined` when there is no CTA: an email with nothing to
 * link needs no HTML alternative, and both providers below omit `html`
 * entirely rather than send an empty one — the same "absent beats malformed"
 * choice `replyTo` already makes.
 *
 * Composed here, at the seam both `FakeMailProvider` and `ResendMailProvider`
 * share, rather than privately inside `ResendMailProvider` — #83 scope item 1
 * requires the CTA to reach "both the fake and the Resend implementation",
 * and a fake that cannot record an HTML body leaves this defect free to recur
 * behind a green suite.
 */
export function composeHtmlBody(email: OutboundEmail): string | undefined {
  if (!email.ctaHref) return undefined
  const label = email.ctaText ?? "View this submission"
  return `<p>${escapeHtml(email.body)}</p><p><a href="${escapeHtml(email.ctaHref)}">${escapeHtml(label)}</a></p>`
}

/**
 * One payload `FakeMailProvider` was handed, in the same shape a real send
 * actually carries (`to`/`from`/`subject`/`text`/`html`/`replyTo`) rather
 * than the raw `OutboundEmail` — so a caller reading these back (`GET
 * /__outbound`, `src/routes/outbound.ts`) sees what would have gone out, not
 * an internal request shape.
 */
export interface RecordedOutboundEmail {
  to: string
  from: string
  subject: string
  text: string
  html?: string
  replyTo?: string
}

/**
 * Every payload `FakeMailProvider` has ever been handed, this Worker
 * instance's lifetime — issue #51's own scope: a fake "that records the
 * payloads it was handed, so a sealed test can assert *what would have been
 * sent* without sending it." Module-level, not per-instance: `selectMailProvider`
 * constructs a fresh `FakeMailProvider` on every call, so a singleton array is
 * the only way a later `GET /__outbound` (a different request) can read what
 * an earlier drain tick recorded.
 *
 * Never cleared programmatically — `npm run serve:acceptance` restarts
 * `wrangler dev` from a wiped `.wrangler/state` before every run
 * (`playwright.acceptance.config.ts`'s own "DETERMINISM" note), which resets
 * this the same way it resets D1.
 */
const recordedOutboundEmails: RecordedOutboundEmail[] = []

/** Read-only snapshot of `recordedOutboundEmails` — see its own doc. */
export function recordedFakeEmails(): readonly RecordedOutboundEmail[] {
  return recordedOutboundEmails
}

export type MailSendOutcome =
  | { ok: true; providerMessageId: string }
  | { ok: false; error: string }

export interface MailProvider {
  send(email: OutboundEmail): Promise<MailSendOutcome>
}

/**
 * The deterministic fake — contract § "The provider seam", "Deterministic
 * fake failure hook": succeeds for every recipient except one whose
 * local-part contains the substring `mailfail` (case-insensitive), which it
 * fails on every call, forever. This is "the only black-box lever the sealed
 * suite has to drive a row all the way to `failed` without waiting on a real,
 * unpredictable provider outage."
 *
 * Never touches the network. Selected by `env.MAIL_PROVIDER === "fake"` —
 * see `selectMailProvider` below — so `serve:acceptance` / `serve:test` can
 * exercise every delivery state without a `RESEND_API_KEY`.
 */
export class FakeMailProvider implements MailProvider {
  async send(email: OutboundEmail): Promise<MailSendOutcome> {
    // Recorded regardless of outcome, success or the deterministic `mailfail`
    // rejection below — issue #51 asks the fake to record "the payloads it
    // was handed," not only the ones it accepted, and #83's sealed slice only
    // ever exercises addresses meant to succeed anyway.
    const html = composeHtmlBody(email)
    recordedOutboundEmails.push({
      to: email.to,
      from: email.from,
      subject: email.subject,
      text: composeTextBody(email),
      ...(html !== undefined ? { html } : {}),
      ...(email.replyTo ? { replyTo: email.replyTo } : {}),
    })

    const [localPart] = email.to.split("@")
    if ((localPart ?? "").toLowerCase().includes("mailfail")) {
      return { ok: false, error: `the fake mail provider deterministically rejects ${email.to}` }
    }
    // Opaque, non-empty, shaped like a real provider's tracking id — contract
    // pins "a test may assert non-emptiness, not a shape."
    return { ok: true, providerMessageId: `fake-${crypto.randomUUID()}` }
  }
}

/**
 * The real path — Resend's send-email API. Fails closed (contract's own
 * words) rather than crashing the scheduled handler: an unset key never
 * reaches `fetch` at all, and any non-2xx response or thrown error becomes a
 * `{ ok: false }` outcome with a raw, operator-facing `error` string — never
 * rendered verbatim to a customer, see `src/routes/outbox.ts`'s
 * `CUSTOMER_SAFE_FAILURE_COPY`.
 */
export class ResendMailProvider implements MailProvider {
  constructor(private readonly apiKey: string | undefined) {}

  async send(email: OutboundEmail): Promise<MailSendOutcome> {
    if (!this.apiKey) {
      return { ok: false, error: "RESEND_API_KEY unset" }
    }

    const html = composeHtmlBody(email)

    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        // `reply_to` is omitted entirely when unset rather than sent as null or
        // "": Resend treats a present-but-empty value as a header to write, and
        // a malformed `Reply-To` is worse than none — some clients then offer
        // the customer no reply target at all. `html` (#83) follows the same
        // rule: omitted, not sent empty, when there is no CTA to link.
        body: JSON.stringify({
          from: email.from,
          to: email.to,
          subject: email.subject,
          text: composeTextBody(email),
          ...(html !== undefined ? { html } : {}),
          ...(email.replyTo ? { reply_to: email.replyTo } : {}),
        }),
      })

      if (!response.ok) {
        return { ok: false, error: `Resend API returned ${response.status}` }
      }

      const result = (await response.json()) as { id?: string }
      if (!result.id) {
        return { ok: false, error: "Resend API accepted the send but returned no id" }
      }
      return { ok: true, providerMessageId: result.id }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `Resend API call failed: ${detail}` }
    }
  }
}

/** `env.MAIL_PROVIDER === "fake"` ⇒ the fake, regardless of `RESEND_API_KEY`; otherwise Resend. */
export function selectMailProvider(env: Env): MailProvider {
  if (env.MAIL_PROVIDER === "fake") return new FakeMailProvider()
  return new ResendMailProvider(env.RESEND_API_KEY)
}
