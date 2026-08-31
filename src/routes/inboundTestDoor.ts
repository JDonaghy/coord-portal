import { listInboundEmails, recordInboundEmail, type InboundEmailRecord } from "../inboundEmail"
import { json } from "../router"
import type { Env } from "../types"

/**
 * `POST /__email` — the dev/acceptance door onto the Worker's `email()` export
 * (issue #161).
 *
 * ── WHY THIS SHIPS WITH THE SEAM AND NOT LATER ─────────────────────────────
 * An `email()` handler is no more reachable from a browser than `scheduled()`
 * is: Cloudflare Email Routing invokes it directly, with no HTTP request behind
 * it. Without this door the sealed acceptance suite has no way to drive inbound
 * mail at all, so milestone #5 would have no acceptance bar for the one thing
 * every later issue in it is built on.
 *
 * This repo has solved this exact shape twice — `GET /__scheduled` for the cron
 * (`wrangler dev --test-scheduled`) and `GET /__outbound` for the recording
 * fake (`src/routes/outbound.ts`). This is the third instance of that
 * convention, not a fourth convention: same `__` prefix, same "404 in
 * production, unconditionally" gate, same `json()` helper.
 *
 * ── THE GATE ───────────────────────────────────────────────────────────────
 * `env.MAIL_PROVIDER === "fake"`, byte-identical to `outboundRecordings`'s own
 * gate and chosen for the same reason: it is the flag `serve:acceptance` and
 * `serve:test` already pass (`--var MAIL_PROVIDER:fake`, package.json), and
 * production never sets it — `wrangler.toml` has no named environments, so
 * there is no `[vars]` entry that could leak it into a deploy (see
 * `Env.MAIL_PROVIDER`'s own doc in `src/types.ts`). Anything else gets the same
 * `{"error":"not_found"}` 404 this repo uses everywhere to answer "not for you"
 * and "does not exist" identically, so an unauthenticated prober learns nothing
 * about whether the route exists.
 *
 * A door that could write `inbound_emails` rows in production would be a way to
 * forge a customer's message; the gate is the whole safety argument, and it is
 * checked before the body is read, before the DB is touched, and before
 * anything is parsed.
 *
 * ── THE ENVELOPE IS NOT IN THE BLOB ────────────────────────────────────────
 * Cloudflare hands `email()` the envelope `to`/`from` *separately* from the
 * message's own `To:`/`From:` MIME headers, and that separation is load-bearing
 * for EM-3: `inbound_emails.to_email` must be the address the message was
 * actually delivered to, because that is what carries the
 * `intake+SUB-XXXXXX@…` plus-address token rung 1 resolves a thread from. A
 * raw blob has nowhere to put an envelope recipient that differs from its own
 * `To:` header, so this door takes them out of band:
 *
 *   POST /__email?to=intake%2BSUB-ABC123@mail.example&from=her@example.test
 *
 * `X-Envelope-To` / `X-Envelope-From` request headers are accepted as an
 * equivalent (a query string is awkward to read in a curl transcript). With
 * neither, the blob's own `To:`/`From:` headers are used — convenient for the
 * ordinary case, and never how a plus-address test should be written.
 *
 * `?from=` present-but-empty is meaningful and is NOT the same as omitting it:
 * an empty envelope sender is an SMTP `<>`, i.e. a bounce, which
 * `detectSuppression` refuses to answer. Omitting the parameter falls back to
 * the `From:` header instead.
 *
 * `GET /__email` reads the recorded rows back, the same read-back role
 * `GET /__outbound` plays for the outbound side — without it, "a redelivery
 * produces no second row" is not observable from outside the app at all, since
 * nothing in this milestone renders an `inbound_emails` row until EM-6 ships
 * `/replies`.
 */
export async function inboundTestDoor(request: Request, env: Env): Promise<Response> {
  if (env.MAIL_PROVIDER !== "fake") {
    return json({ error: "not_found" }, { status: 404 })
  }

  if (request.method === "GET") {
    const emails = await listInboundEmails(env)
    return json({ emails: emails.map(asJson) })
  }

  if (request.method !== "POST") {
    return json({ error: "method_not_allowed", allowed: ["GET", "POST"] }, {
      status: 405,
      headers: { allow: "GET, POST" },
    })
  }

  const raw = await request.text()
  if (raw.trim() === "") {
    return json({ error: "empty_message" }, { status: 400 })
  }

  const url = new URL(request.url)
  const to = envelopeValue(url, request, "to") ?? rawHeader(raw, "to") ?? ""
  const from = envelopeValue(url, request, "from") ?? rawHeader(raw, "from") ?? ""

  // Deliberately NOT wrapped in a try/catch that swallows: a malformed blob is
  // a broken fixture, and `handleApi`'s own error boundary does not cover this
  // path (it lives beside `/__outbound`, ahead of the API router in
  // `src/index.ts`). Letting it throw surfaces the parse error in the
  // `wrangler dev` log where whoever wrote the fixture can read it.
  const { record, duplicate } = await recordInboundEmail(env, { from, to, raw })

  return json({ ...asJson(record), duplicate })
}

/**
 * The wire shape. Snake_case keys mirror the `inbound_emails` column names
 * exactly (those are what `ms-5/contract.md` pins), with camelCase aliases
 * alongside for the two multi-word fields, so a caller reading either
 * convention finds what it is looking for. `id` and `disposition` are the two
 * fields the contract pins by name.
 */
function asJson(record: InboundEmailRecord): Record<string, unknown> {
  return {
    id: record.id,
    disposition: record.disposition,
    message_id: record.messageId,
    from_email: record.fromEmail,
    from_name: record.fromName,
    to_email: record.toEmail,
    subject: record.subject,
    body_text: record.bodyText,
    received_at: record.receivedAt,
    auth_result: record.authResult,
    suppression_reason: record.suppressionReason,
    reason: record.suppressionReason,
    attachment_count: record.attachmentCount,
    attachmentCount: record.attachmentCount,
    body_truncated: record.bodyTruncated,
    bodyTruncated: record.bodyTruncated,
    truncated: record.bodyTruncated,
    // EM-3's routing decision (issue #163). `null` on all four for a
    // `suppressed` row, which is never routed at all.
    routed_kind: record.routedKind,
    routedKind: record.routedKind,
    routed_rung: record.routedRung,
    routedRung: record.routedRung,
    routed_reason: record.routedReason,
    routedReason: record.routedReason,
    routed_runner_up: record.routedRunnerUp,
    routedRunnerUp: record.routedRunnerUp,
  }
}

/** `?to=` / `?from=`, or the `X-Envelope-To` / `X-Envelope-From` header. `null` when neither is present. */
function envelopeValue(url: URL, request: Request, field: "to" | "from"): string | null {
  const query = url.searchParams.get(field)
  if (query !== null) return query
  return request.headers.get(`x-envelope-${field}`)
}

/**
 * Pull one header out of the raw blob, for the fallback path only.
 *
 * Deliberately naive — it reads the header block, unfolds continuation lines,
 * and stops at the blank line. It is not a MIME parser and must never be used
 * for anything the recorded row depends on; `postal-mime` does that job inside
 * `recordInboundEmail`. This exists so a fixture that does not care about the
 * envelope can omit it.
 */
function rawHeader(raw: string, name: string): string | null {
  const headerBlock = raw.replace(/\r\n/g, "\n").split(/\n\n/, 1)[0] ?? ""
  const unfolded = headerBlock.replace(/\n[ \t]+/g, " ")
  for (const line of unfolded.split("\n")) {
    const colon = line.indexOf(":")
    if (colon < 0) continue
    if (line.slice(0, colon).trim().toLowerCase() !== name) continue
    const value = line.slice(colon + 1).trim()
    const angled = /<([^>]*)>/.exec(value)
    return (angled?.[1] ?? value).trim()
  }
  return null
}
