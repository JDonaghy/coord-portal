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
 *
 * #105 gave that body a visual identity. What #83 shipped was
 * `<p>body</p><p><a>label</a></p>` — correct, linkable, and completely
 * anonymous: no colour, no wordmark, nothing a recipient could recognise as
 * coming from the business she hired. See `BRAND` below.
 */

/**
 * heurontech.com's design tokens, inlined — issue #105.
 *
 * Values lifted from the site redesign (`new/index.html` in the site repo).
 * That redesign is not live yet, but it *is* the brand going forward, so an
 * email styled against it is recognisable the moment the site ships and is
 * merely tasteful before then.
 *
 * Every value is inlined into a `style` attribute at the point of use rather
 * than declared as a CSS custom property in a `<style>` block: Gmail strips
 * `<style>` from a forwarded message, Outlook has never supported `var()`, and
 * a token that resolves to nothing renders as unstyled black-on-white — which
 * is the exact anonymity this change exists to remove. Inline styles are the
 * one mechanism every mail client honours.
 *
 * NOTHING here may cause an external network request. No `<img>` pointing at a
 * logo on a CDN, no `<link>` pulling "IBM Plex Sans"/"Newsreader" from Google
 * Fonts. Both are load-bearing: a remote fetch in a message body is itself a
 * spam signal, most clients block it by default so the brand mark would simply
 * not render, and a blocked-image placeholder where a wordmark should be looks
 * *more* suspicious than no wordmark at all. The wordmark is therefore text,
 * and both font stacks degrade to something every OS already has.
 */
const BRAND = {
  /** Page background behind the card. */
  paper: "#FBF8F6",
  /** The card itself, and the CTA's own text colour against `green`. */
  card: "#FFFFFF",
  /** Body text. */
  ink: "#12181A",
  /** Secondary text — the footer's reason-for-receipt line. */
  ink2: "#464E50",
  /** The site's `.btn` fill, reused for the CTA and the wordmark. */
  green: "#0B3036",
  /** The site's accent, used once, on the domain line under the wordmark. */
  ochre: "#B37947",
  /** Hairlines: the card border and the two internal rules. */
  rule: "#E2DCD8",
} as const

/**
 * Body and UI text. "IBM Plex Sans" is the site's, and is not fetched — a
 * recipient who happens to have it installed gets it, everyone else falls
 * through to their platform's system UI face, which is what a personal message
 * looks like anyway.
 */
const SANS = "'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif"

/**
 * The wordmark only. "Newsreader" is the site's display serif and, like the
 * sans above, is never fetched; Georgia is on every Windows and macOS install
 * shipped this century, so the degradation is a serif, not a fallback to the
 * body face.
 */
const SERIF = "'Newsreader', Georgia, 'Times New Roman', serif"

/**
 * The notification body, as HTML paragraphs — issue #105.
 *
 * `emailContent` writes bodies with a blank-line-separated signature
 * (`src/notifications.ts`'s `SIGNATURE`), and #83's single
 * `<p>${escapeHtml(body)}</p>` would have collapsed that newline to a space
 * and run the signature onto the end of the sentence above it. Blank lines
 * become separate `<p>`s; a lone newline inside a paragraph becomes `<br />`.
 *
 * Every fragment of the body still goes through `escapeHtml` exactly as it did
 * before — `title` is the customer's own words off the intake form, so it is
 * untrusted input that lands in a document someone else's mail client parses.
 */
function htmlParagraphs(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .map((paragraph) => {
      const lines = paragraph.split("\n").map(escapeHtml).join("<br />")
      return `<p style="margin:0 0 16px;">${lines}</p>`
    })
    .join("")
}

export function composeHtmlBody(email: OutboundEmail): string | undefined {
  if (!email.ctaHref) return undefined
  const label = email.ctaText ?? "View this submission"

  // Table-in-table rather than nested `<div>`s: Outlook's Word rendering engine
  // ignores `max-width` on a block element, so a div-based card renders full
  // bleed across a maximised window. The `width="560"` attribute plus the
  // `max-width` style is the belt-and-braces pair that every mail client
  // honours one half of.
  return [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:0;padding:0;background:${BRAND.paper};">`,
    `<tr><td align="center" style="padding:24px 12px;">`,
    `<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;background:${BRAND.card};border:1px solid ${BRAND.rule};border-radius:10px;">`,
    `<tr><td style="padding:28px 32px;font-family:${SANS};font-size:16px;line-height:1.6;color:${BRAND.ink};">`,
    // The brand mark: text, not an image. See `BRAND`'s doc for why.
    `<p data-email-brand="heuron-technology" style="margin:0;font-family:${SERIF};font-size:20px;line-height:1.3;color:${BRAND.green};">Heuron Technology</p>`,
    // The one line tying `intake.heurontech.com` — a subdomain the recipient
    // has never seen — back to the domain she has. Deliberately not a link:
    // one destination per email keeps the CTA unambiguous, and a second
    // hostname in an anchor is a spam signal for no reader benefit.
    `<p style="margin:2px 0 20px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:${BRAND.ochre};">heurontech.com</p>`,
    `<hr style="border:0;border-top:1px solid ${BRAND.rule};margin:0 0 20px;height:1px;" />`,
    htmlParagraphs(email.body),
    // The CTA as the site's `.btn`, not a bare underlined link. `data-email-cta`
    // mirrors the `email-cta` hook ms-1's contract pins on the portal's own
    // preview of this send, so the two surfaces stay greppable together;
    // `tests/acceptance/ms-3/83-email-link.spec.ts` matches on the `href`
    // itself, which is unchanged and still the only anchor in the message.
    `<p style="margin:24px 0 0;"><a data-email-cta="submission" href="${escapeHtml(email.ctaHref)}" style="display:inline-block;background:${BRAND.green};color:${BRAND.card};font-family:${SANS};font-size:16px;font-weight:600;line-height:1.2;text-decoration:none;padding:13px 22px;border-radius:6px;">${escapeHtml(label)}</a></p>`,
    // "Why am I getting this?" — the question a recipient asks right before she
    // hits Report Spam, answered in the message rather than left to inference.
    `<p style="margin:28px 0 0;padding-top:16px;border-top:1px solid ${BRAND.rule};font-size:13px;line-height:1.5;color:${BRAND.ink2};">You are receiving this because you asked Heuron Technology to work on this project. Reply to this email and it reaches me directly.</p>`,
    `</td></tr></table>`,
    `</td></tr></table>`,
  ].join("")
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
