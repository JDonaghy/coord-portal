import PostalMime, { type Email, type Address } from "postal-mime"
import { generateInboundEmailId } from "./ids"
import { routeInboundMessage, type RoutedKind, type RoutingRung } from "./inboundRouter"
import type { Env } from "./types"

/**
 * The inbound seam — issue #161 (EM-1 of milestone #5).
 *
 * One real message in, one `inbound_emails` row out. This module **routes
 * nothing and replies to nothing** (#161's own scope sentence): it records what
 * arrived and refuses what should never earn an answer. EM-3 routes, EM-4/EM-5
 * draft, EM-9 rate-limits; every column those issues will fill is nullable in
 * `migrations/0020_inbound_emails.sql` and untouched here.
 *
 * ── WHY THIS IS NOT A REQUEST HANDLER ──────────────────────────────────────
 * Cloudflare Email Routing invokes the Worker's `email()` export directly.
 * There is no `Request`, no `Response`, no URL — exactly the relationship
 * `scheduled()` has to a Cron Trigger. `src/index.ts` is the only production
 * caller. `src/routes/inboundTestDoor.ts` is the dev/acceptance-only second
 * caller, and it funnels through this same `recordInboundEmail` so a test
 * exercises the production path rather than a parallel one.
 *
 * ── NEVER ANSWER A MACHINE ─────────────────────────────────────────────────
 * `detectSuppression` below is the whole reason this issue ships before
 * anything that can send. Two auto-responders talking to each other is the
 * classic way a feature like this embarrasses us, and the only reliable moment
 * to stop it is before a draft exists at all. A suppressed message is still
 * recorded — with its reason — because "we refused to answer this" is evidence
 * an operator may need, and deleting it makes the same question unanswerable
 * next time.
 *
 * ── MIME PARSING ───────────────────────────────────────────────────────────
 * `postal-mime`, pinned to an exact version in package.json. It is pure JS with
 * no Node built-ins, which is not a stylistic preference: the Workers runtime
 * has no `fs`/`Buffer`/`stream`, so a Node-only parser fails at **deploy**,
 * long after a review would have caught it.
 */

/**
 * How much of a message body is kept, in characters.
 *
 * NOT DISCOVERED — #161 says "cap the stored `body_text` and the parsed
 * summary" and pins the behaviour ("An oversized message is still recorded
 * (truncated, flagged) — never dropped silently") without naming a number, and
 * `ms-5/contract.md` flags the cap as unpinned too. 16k characters is this
 * implementation's own choice: comfortably more than any real customer reply
 * (a long one is a couple of kilobytes), small enough that a runaway
 * machine-generated body cannot bloat a D1 row, and it is the *stored* size —
 * nothing is rejected for exceeding it.
 */
export const MAX_BODY_TEXT_CHARS = 16_000

/**
 * How much of a subject line is kept. RFC 5322 caps a header line at 998
 * octets; anything past that is malformed, not merely long. Truncating here is
 * silent (no `body_truncated` equivalent) because the column that flag names is
 * `body_text` — a truncated subject is visible on its face, a truncated body is
 * not.
 */
export const MAX_SUBJECT_CHARS = 998

/** Same reasoning as `MAX_SUBJECT_CHARS`, for the display name and address. */
export const MAX_ADDRESS_CHARS = 320

/** The `disposition` vocabulary — `migrations/0020_inbound_emails.sql`'s CHECK. */
export type InboundDisposition = "received" | "suppressed" | "rate_limited"

/** The DMARC verdict recorded in `auth_result`. EM-5 gates identity matching on `pass`. */
export type AuthResult = "pass" | "fail" | "none"

/**
 * Why a message was refused an answer. A fixed slug vocabulary rather than
 * free text so EM-6 can render it and a test can assert on it; one slug per
 * rule in #161's own list, in the order that list gives them.
 */
export type SuppressionReason =
  | "auto-submitted"
  | "bulk-precedence"
  | "mailing-list"
  | "bounce"
  | "own-sending-domain"

export const SUPPRESSION_REASON_TEXT: Record<SuppressionReason, string> = {
  "auto-submitted": "The message carried an Auto-Submitted header — it is machine-generated.",
  "bulk-precedence": "The message was marked bulk, list or junk precedence.",
  "mailing-list": "The message came from a mailing list.",
  "bounce": "The message had an empty envelope sender — it is a bounce.",
  "own-sending-domain": "The sender is one of this portal's own sending addresses.",
}

/** One recorded row, as the rest of the app reads it. Mirrors the 0020 columns. */
export interface InboundEmailRecord {
  id: string
  /** The sender's `Message-ID` header verbatim, angle brackets included, or `null`. */
  messageId: string | null
  fromEmail: string
  fromName: string | null
  /** The ENVELOPE recipient — carries EM-3 rung 1's plus-address token. */
  toEmail: string
  subject: string
  bodyText: string
  receivedAt: string
  authResult: AuthResult
  disposition: InboundDisposition
  suppressionReason: SuppressionReason | null
  attachmentCount: number
  bodyTruncated: boolean
  /**
   * ── THE ROUTER'S DECISION (issue #163, EM-3) ─────────────────────────────
   * `null` on every column for a row that was never routed at all — a
   * `suppressed` message, which #161's own rule keeps out of the router
   * entirely ("recorded, with a reason; no draft, **no routing**"). For a
   * `received` row all four are populated together, because the ladder always
   * reaches an answer: rung 6 ("nobody we know, or ambiguous → a lead") is a
   * decision, not an absence of one.
   */
  routedKind: RoutedKind | null
  routedRung: RoutingRung | null
  /** Human-readable: what `/replies` (EM-6) shows an operator to justify the match. */
  routedReason: string | null
  /** The candidate the router scored but did not pick, or `null` when there was never a second one. */
  routedRunnerUp: string | null
}

export interface RecordInboundEmailResult {
  record: InboundEmailRecord
  /**
   * `true` when this exact message had already been recorded and no second row
   * was written — a redelivery, not a new message. The returned `record` is the
   * row that already existed, so a caller (and `POST /__email`) sees the same
   * `id` both times.
   */
  duplicate: boolean
}

/**
 * The subset of `ForwardableEmailMessage` this module needs.
 *
 * Narrower than Cloudflare's own type on purpose: `setReject`, `forward` and
 * `reply` are the three things #161 explicitly does not do, and a seam that
 * cannot see them cannot accidentally grow into doing them. It also lets
 * `POST /__email` hand the same shape in from a raw blob without faking a
 * whole `ForwardableEmailMessage`.
 */
export interface InboundMessage {
  /**
   * Envelope sender. `""` (an SMTP `<>`) is a bounce and is suppressed — this
   * is the envelope, deliberately, not the `From:` header, because a bounce
   * carries a perfectly ordinary-looking `From:` and only the empty envelope
   * gives it away.
   */
  from: string
  /**
   * Envelope recipient — the address the message was actually delivered to,
   * NOT the `To:` header. See `migrations/0020_inbound_emails.sql`'s note.
   */
  to: string
  /** The raw RFC 822 bytes. */
  raw: ArrayBuffer | Uint8Array | string | ReadableStream<Uint8Array>
}

/**
 * Parse one inbound message and record exactly one row for it.
 *
 * Idempotent by construction: a redelivery of the same `Message-ID` to the same
 * envelope recipient hits the partial unique index in 0020, the insert does
 * nothing, and the pre-existing row is read back and returned. "Assume every
 * request may arrive twice" (CLAUDE.md) is not hypothetical here — SMTP retries
 * are routine and Email Routing gives no delivery-once guarantee.
 */
export async function recordInboundEmail(
  env: Env,
  message: InboundMessage,
): Promise<RecordInboundEmailResult> {
  const parsed = await PostalMime.parse(message.raw)

  const toEmail = normaliseAddress(message.to)
  const headerFrom = firstMailbox(parsed.from)
  // The `From:` header address is what a DMARC verdict is *about* and what EM-5
  // matches an identity on, so it is what `from_email` records. The envelope
  // sender is the fallback for a message with no parseable `From:` at all —
  // never the other way round.
  const fromEmail = normaliseAddress(headerFrom?.address ?? message.from)
  const fromName = clamp(headerFrom?.name?.trim() ?? "", MAX_ADDRESS_CHARS).text || null

  const subject = clamp(parsed.subject ?? "", MAX_SUBJECT_CHARS).text
  const body = clamp(bodyTextOf(parsed), MAX_BODY_TEXT_CHARS)

  const authResult = parseDmarcVerdict(headerValues(parsed, "authentication-results"))
  const suppressionReason = detectSuppression(env, parsed, message, fromEmail)

  // Suppressed mail is recorded but never routed — #161's own rule, and the
  // reason the router runs *here* rather than unconditionally inside
  // `insertInboundEmail`: a machine's auto-reply must not be resolved to a
  // person, given a draft, or shown to an operator as a routing decision that
  // was never really made.
  const decision =
    suppressionReason === null
      ? await routeInboundMessage(env, { fromEmail, toEmail, subject, bodyText: body.text, authResult })
      : null

  const record: InboundEmailRecord = {
    id: generateInboundEmailId(),
    messageId: normaliseMessageId(parsed.messageId),
    fromEmail,
    fromName,
    toEmail,
    subject,
    bodyText: body.text,
    receivedAt: new Date().toISOString(),
    authResult,
    disposition: suppressionReason === null ? "received" : "suppressed",
    suppressionReason,
    attachmentCount: parsed.attachments.length,
    bodyTruncated: body.truncated,
    routedKind: decision?.kind ?? null,
    routedRung: decision?.rung ?? null,
    routedReason: decision?.reason ?? null,
    routedRunnerUp: decision?.runnerUp?.reason ?? null,
  }

  return insertInboundEmail(env, record)
}

/**
 * `INSERT … ON CONFLICT DO NOTHING`, then read back.
 *
 * No conflict target is named: the only uniqueness in 0020 beyond the primary
 * key is the partial `(message_id, to_email)` index, and SQLite's bare
 * `DO NOTHING` covers any of them — including the (impossible in practice, but
 * free to survive) case of a minted id colliding.
 *
 * The read-back is not an optimisation, it is the correctness argument: two
 * concurrent redeliveries can both find no row and both attempt an insert, and
 * exactly one wins. The loser must return the winner's row rather than the
 * record it built and threw away, or the same message would report two
 * different ids. Same "read back rather than assuming the race was won" shape
 * `promoteLead` already uses.
 */
async function insertInboundEmail(
  env: Env,
  record: InboundEmailRecord,
): Promise<RecordInboundEmailResult> {
  const result = await env.DB.prepare(
    `INSERT INTO inbound_emails (
       id, message_id, from_email, from_name, to_email, subject, body_text,
       received_at, auth_result, disposition, suppression_reason,
       attachment_count, body_truncated,
       routed_kind, routed_rung, routed_reason, routed_runner_up
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
  )
    .bind(
      record.id,
      record.messageId,
      record.fromEmail,
      record.fromName,
      record.toEmail,
      record.subject,
      record.bodyText,
      record.receivedAt,
      record.authResult,
      record.disposition,
      record.suppressionReason,
      record.attachmentCount,
      record.bodyTruncated ? 1 : 0,
      record.routedKind,
      record.routedRung,
      record.routedReason,
      record.routedRunnerUp,
    )
    .run()

  if ((result.meta?.changes ?? 0) > 0) {
    return { record, duplicate: false }
  }

  const existing = record.messageId === null ? null : await findByMessageId(env, record)
  return { record: existing ?? record, duplicate: existing !== null }
}

async function findByMessageId(
  env: Env,
  record: InboundEmailRecord,
): Promise<InboundEmailRecord | null> {
  const row = await env.DB.prepare(
    `${SELECT_COLUMNS} WHERE message_id = ? AND to_email = ? LIMIT 1`,
  )
    .bind(record.messageId, record.toEmail)
    .first<InboundEmailRow>()
  return row === null ? null : fromRow(row)
}

const SELECT_COLUMNS = `SELECT id, message_id, from_email, from_name, to_email, subject,
         body_text, received_at, auth_result, disposition, suppression_reason,
         attachment_count, body_truncated,
         routed_kind, routed_rung, routed_reason, routed_runner_up
    FROM inbound_emails`

/**
 * Every recorded row, newest first — the read-back half of the dev-only test
 * door (`src/routes/inboundTestDoor.ts`). Not reachable in production; see
 * that module for the gate and why it exists.
 */
export async function listInboundEmails(env: Env, limit = 200): Promise<InboundEmailRecord[]> {
  const { results } = await env.DB.prepare(
    `${SELECT_COLUMNS} ORDER BY received_at DESC, id DESC LIMIT ?`,
  )
    .bind(limit)
    .all<InboundEmailRow>()
  return (results ?? []).map(fromRow)
}

interface InboundEmailRow {
  id: string
  message_id: string | null
  from_email: string
  from_name: string | null
  to_email: string
  subject: string
  body_text: string
  received_at: string
  auth_result: string
  disposition: string
  suppression_reason: string | null
  attachment_count: number
  body_truncated: number
  routed_kind: string | null
  routed_rung: number | null
  routed_reason: string | null
  routed_runner_up: string | null
}

function fromRow(row: InboundEmailRow): InboundEmailRecord {
  return {
    id: row.id,
    messageId: row.message_id,
    fromEmail: row.from_email,
    fromName: row.from_name,
    toEmail: row.to_email,
    subject: row.subject,
    bodyText: row.body_text,
    receivedAt: row.received_at,
    authResult: row.auth_result as AuthResult,
    disposition: row.disposition as InboundDisposition,
    suppressionReason: row.suppression_reason as SuppressionReason | null,
    attachmentCount: row.attachment_count,
    bodyTruncated: row.body_truncated !== 0,
    routedKind: row.routed_kind as RoutedKind | null,
    routedRung: row.routed_rung as RoutingRung | null,
    routedReason: row.routed_reason,
    routedRunnerUp: row.routed_runner_up,
  }
}

/**
 * "Never answer a machine" — #161 scope item 4, one branch per bullet, in the
 * order the issue lists them. The first match wins; the reason recorded is the
 * first rule that fired, not a set, because an operator reading `/replies`
 * needs one legible answer to "why was this not drafted" rather than a list to
 * rank themselves.
 *
 * Every rule here is a *suppression*, never a rejection: the row is written
 * either way. `setReject()` would bounce the message back at the sender, which
 * for a genuine misfire means a real person's mail vanishes with an SMTP error
 * they cannot act on. Recording and declining to answer is strictly recoverable
 * — an operator can still read it.
 */
export function detectSuppression(
  env: Env,
  parsed: Email,
  message: InboundMessage,
  fromEmail: string,
): SuppressionReason | null {
  // `Auto-Submitted` present and not `no` (RFC 3834). The header's whole
  // purpose is to say "a program sent this"; `no` is the explicit opt-out that
  // means a human did.
  const autoSubmitted = headerValue(parsed, "auto-submitted")
  if (autoSubmitted !== null && firstToken(autoSubmitted) !== "no") {
    return "auto-submitted"
  }

  // `Precedence: bulk | list | junk` — the pre-RFC-3834 convention every
  // mailing list and most notification systems still set.
  const precedence = firstToken(headerValue(parsed, "precedence") ?? "")
  if (precedence === "bulk" || precedence === "list" || precedence === "junk") {
    return "bulk-precedence"
  }

  // A list, by its own declaration (RFC 2919 / RFC 8058).
  if (headerValue(parsed, "list-id") !== null || headerValue(parsed, "list-unsubscribe") !== null) {
    return "mailing-list"
  }

  // Empty envelope sender — an SMTP `<>` return path, i.e. a bounce or a
  // delivery-status notification. Replying to one is how a mail loop starts.
  // Checked on the ENVELOPE, never the `From:` header, which a bounce fills in
  // with an ordinary-looking postmaster address.
  if (normaliseAddress(message.from) === "" || normaliseAddress(message.from) === "<>") {
    return "bounce"
  }

  // Our own sending identity, coming back at us. Matched on the domain, not the
  // exact mailbox: `notify@mail.example` and `bounces@mail.example` are the same
  // sending infrastructure, and a loop through either is the same loop.
  if (isOwnSendingDomain(env, fromEmail)) {
    return "own-sending-domain"
  }

  return null
}

/**
 * The domains this portal sends from, taken from the same two vars the outbound
 * side already uses (`EMAIL_FROM`, `REPLY_TO`) rather than a second hardcoded
 * list that could drift out of step with them. Either may be a bare address or
 * a `Display Name <addr@domain>` form — `wrangler.toml` uses both today.
 *
 * Unset vars contribute nothing, which is the right degradation: with no
 * configured sending address there is no self-reply loop to break.
 */
function isOwnSendingDomain(env: Env, fromEmail: string): boolean {
  const senderDomain = domainOf(fromEmail)
  if (senderDomain === null) return false
  for (const configured of [env.EMAIL_FROM, env.REPLY_TO]) {
    const domain = domainOf(extractAddress(configured ?? ""))
    if (domain !== null && domain === senderDomain) return true
  }
  return false
}

/**
 * The DMARC verdict, from `Authentication-Results`.
 *
 * WHICH HOP, AND WHY IT IS THE LAST ONE. A message reaches this Worker via a
 * Zoho forward: the original sender talks to Zoho, Zoho forwards to Cloudflare
 * Email Routing, Cloudflare invokes `email()`. Each hop prepends its own
 * `Authentication-Results` header, so the *first* header in the message is the
 * newest — Cloudflare's, describing the **Zoho relay**, not the customer. That
 * verdict is close to useless for identity: plain forwarding breaks SPF
 * alignment as a matter of course, so it can read `fail` for a message that was
 * perfectly authentic when it left the sender.
 *
 * The header worth trusting is the one Zoho stamped, which sat closest to the
 * original sender and is therefore the *last* `dmarc=`-bearing header in the
 * stack. That is what this function returns.
 *
 * This is a judgement about our own topology, not a general rule — in a
 * deployment where mail arrives directly, the first and last header are the
 * same one and nothing changes. It is worth restating that the whole header is
 * unauthenticated text once it is inside the message; what makes it usable is
 * that every hop before ours strips or overwrites what an outside sender wrote.
 * EM-3 gates its identity-resolving rungs (3–5) on `pass` precisely because
 * "anyone can put any address in a `From:` header".
 *
 * `none` covers three genuinely different situations — no header, a header with
 * no DMARC token, and a verdict outside `pass`/`fail` (`temperror`,
 * `permerror`, `bestguesspass`, …). All three mean the same thing downstream:
 * we have no DMARC pass, so nothing may be resolved to a person on the strength
 * of the `From:` address.
 */
export function parseDmarcVerdict(headers: readonly string[]): AuthResult {
  for (let i = headers.length - 1; i >= 0; i--) {
    const match = /\bdmarc\s*=\s*([a-z]+)/i.exec(headers[i] ?? "")
    if (match === undefined || match === null) continue
    const verdict = (match[1] ?? "").toLowerCase()
    if (verdict === "pass") return "pass"
    if (verdict === "fail") return "fail"
    return "none"
  }
  return "none"
}

/**
 * The text body, capped by the caller.
 *
 * A `text/plain` part is preferred and is what almost every mail client sends
 * alongside its HTML. When a message is HTML-only, the tags are stripped rather
 * than the body being recorded as empty: an operator reading `/replies` (EM-6)
 * has to be able to see what a customer actually wrote, and "" would make an
 * HTML-only reply indistinguishable from an empty one. This is deliberately
 * crude — it is a readable summary, not a rendering, and nothing downstream
 * treats it as markup.
 */
function bodyTextOf(parsed: Email): string {
  const text = parsed.text?.trim()
  if (text !== undefined && text !== "") return text
  const html = parsed.html
  if (html === undefined || html === "") return ""
  return htmlToText(html)
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

interface Clamped {
  text: string
  truncated: boolean
}

/** Cut to `max` characters, saying whether anything was cut. Never throws, never drops. */
export function clamp(value: string, max: number): Clamped {
  return value.length <= max
    ? { text: value, truncated: false }
    : { text: value.slice(0, max), truncated: true }
}

/**
 * The sender's `Message-ID` **verbatim** — angle brackets and all, exactly as
 * #161 words it ("the sender's `Message-ID` header").
 *
 * Deliberately not unwrapped to the bare `addr-spec` inside the brackets. An
 * earlier draft of this module stripped them on the theory that a sender might
 * quote the id back inconsistently; that is the wrong trade. `<…>` is part of
 * the `msg-id` production in RFC 5322, the redelivery guard compares whole
 * strings, and a stored value that does not match what the header said makes
 * every "is this the same message" question in EM-3 onward answerable only by
 * remembering that this one column was rewritten on the way in.
 *
 * Whitespace is still trimmed (header folding routinely leaves some) and the
 * value is still capped, for the same reason every other sender-controlled
 * string here is: it is attacker-controlled text with no length bound of its
 * own. A message with no `Message-ID` at all records `NULL` — there is no
 * identity to deduplicate on, which is exactly what the partial unique index in
 * `migrations/0020_inbound_emails.sql` says.
 */
function normaliseMessageId(messageId: string | undefined): string | null {
  const trimmed = (messageId ?? "").trim()
  if (trimmed === "") return null
  return clamp(trimmed, MAX_ADDRESS_CHARS).text
}

function normaliseAddress(address: string): string {
  return clamp(address.trim().toLowerCase(), MAX_ADDRESS_CHARS).text
}

/** `Name <a@b>` or `a@b` → `a@b`, lowercased. `""` when there is nothing to extract. */
function extractAddress(value: string): string {
  const angled = /<([^>]*)>/.exec(value)
  return normaliseAddress(angled?.[1] ?? value)
}

function domainOf(address: string): string | null {
  const at = address.lastIndexOf("@")
  if (at < 0) return null
  const domain = address.slice(at + 1).trim()
  return domain === "" ? null : domain
}

/**
 * `postal-mime` models `From:` as either a single mailbox or a group; only the
 * mailbox form can carry an address, and a group `From:` is malformed enough
 * that falling back to the envelope sender is the honest answer.
 */
function firstMailbox(address: Address | undefined): { name: string; address: string } | null {
  if (address === undefined) return null
  if (address.address !== undefined) return { name: address.name, address: address.address }
  const first = address.group?.[0]
  return first === undefined ? null : { name: first.name, address: first.address }
}

/** Every value for a header name, in the order the message carries them (newest hop first). */
function headerValues(parsed: Email, name: string): string[] {
  return parsed.headers.filter((header) => header.key === name).map((header) => header.value)
}

/** The first value for a header, or `null` when the message carries none. */
function headerValue(parsed: Email, name: string): string | null {
  return headerValues(parsed, name)[0] ?? null
}

/** `bulk; something` / `auto-replied (generated)` → `bulk` / `auto-replied`. */
function firstToken(value: string): string {
  return (value.trim().toLowerCase().split(/[\s;(,]/)[0] ?? "").trim()
}
