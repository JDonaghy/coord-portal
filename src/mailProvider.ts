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
        // the customer no reply target at all.
        body: JSON.stringify({
          from: email.from,
          to: email.to,
          subject: email.subject,
          text: email.body,
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
