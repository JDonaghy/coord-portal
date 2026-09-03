import PostalMime, { type Email, type Address } from "postal-mime"
import { chunkForBinding } from "./d1"
import { generateInboundEmailId } from "./ids"
import {
  routeInboundMessage,
  type RoutedKind,
  type RoutingDecision,
  type RoutingRung,
  type RoutingTarget,
} from "./inboundRouter"
import { leadCreationStatement, mintLead, type Lead } from "./leads"
import { messageCreationStatement, mintMessage, type Message } from "./messages"
import { intakeReplyStatement, routedReplyStatement, type DraftedIntakeReply } from "./notifications"
import { isInboundDraftRateLimited } from "./rateLimit"
import type { CreateGuard } from "./submissions"
import type { Env } from "./types"

/**
 * The inbound seam — issue #161 (EM-1 of milestone #5).
 *
 * One real message in, one `inbound_emails` row out. This module's own scope
 * sentence used to be "routes nothing and replies to nothing" — #161's,
 * before EM-3 (routing, issue #163), EM-4 (drafting rung 6's stranger case,
 * issue #164), EM-5 (a known thread, issue #165) and EM-9 (rate limits and
 * attachment disclosure, issue #169) all landed here.
 *
 * ── EM-9: RATE-LIMITING DRAFTS, WITHOUT ERASING THE EVIDENCE (ISSUE #169) ───
 * "The abuse controls a mailbox needs and a form already has." `POST /start`
 * has Turnstile plus a coarse per-IP cap; a mailbox cannot have Turnstile —
 * there is no connection here to challenge, only a message Cloudflare Email
 * Routing has already accepted — so the cap `isInboundDraftRateLimited`
 * (`src/rateLimit.ts`) enforces, per sender and in total over a shared
 * sliding window, is the whole defense. It runs *after* `detectSuppression`
 * below, never before: a message the suppression rules already refuse was
 * never going to draft anything regardless of this cap, and unlike
 * `POST /start`'s own `siteverify` call there is no external cost here a
 * suppressed message could still be inflating.
 *
 * A rate-limited message is recorded exactly like an ordinary one — subject,
 * body, attachment count, everything EM-1 already captures — with
 * `disposition = 'rate_limited'` and `decision` left `null`, the same "never
 * routed at all" treatment a `suppressed` row gets. The distinction from
 * `suppressed` is why: a `rate_limited` row was refused for a reason about
 * *volume*, not about *this message*, and #169's own words are the test —
 * "a flood should fill a queue we can inspect, not an inbox we cannot
 * recall, and it should not erase the evidence of itself."
 *
 * ── EM-9: ATTACHMENTS, DROPPED AND DISCLOSED (ISSUE #169) ───────────────────
 * Storing a customer's file is a real feature with its own decisions — R2
 * layout, retention, size caps, scanning — out of scope here. What ships
 * instead: `attachmentCount` below (from `parsed.attachments.length`, the
 * same count EM-1 always computed, now actually used) travels to
 * `draftFor` and from there into `intakeReplyContent`/`routedReplyContent`
 * (`src/notifications.ts`), which append a sentence saying the attachment
 * did not come through — never that it was kept, saved, or is retrievable.
 * The same count is what `reply-attachments-dropped` (`src/routes/replies.ts`,
 * landed ahead of this issue in EM-6) shows an operator.
 *
 * ── EM-5: A KNOWN SENDER'S MESSAGE JOINS ITS OWN THREAD (ISSUE #165) ────────
 * When the router's decision is `"message"` (rungs 1-5 — a plus-addressed
 * reply, a quoted reference, or an identity match), `recordInboundEmail`
 * mints a `messages` row (`src/messages.ts`) on the matched submission,
 * `author_role = 'customer'`, and drafts a routed acknowledgement into
 * `outbox` the same way EM-4 drafts a stranger's — `pending`, for an operator
 * to approve. When the decision is `"unrouted"` (rung 6's ambiguous case: a
 * tie among a known client's projects, or a known address that failed DMARC)
 * nothing is appended anywhere and no lead is minted either — the row parks
 * with the candidates the router considered, for EM-6's screen — but a
 * neutral acknowledgement is still drafted, because the sender should still
 * hear back even though nobody has decided where this belongs yet. Every one
 * of these writes lands in the same guarded `env.DB.batch()` as the
 * `inbound_emails` row itself, for the identical reason EM-4 gives: no window
 * in which a message exists whose `inbound_emails` row does not, or a
 * drafted reply nobody's message justifies.
 *
 * ── EM-4: RUNG 6 CREATES A LEAD AND DRAFTS AN ACKNOWLEDGEMENT (ISSUE #164) ──
 * `recordInboundEmail` below parses, suppresses-or-routes, and then writes —
 * and when the router's own decision was rung 6, `"lead"`, that write is three
 * rows across three tables rather than one: the `inbound_emails` row, the
 * `leads` row minted by `mintLead`/`leadCreationStatement` (`src/leads.ts`) —
 * "not a copy of it, not a variant: the *same* statement `POST /start` writes"
 * — and the drafted acknowledgement from `intakeReplyStatement`
 * (`src/notifications.ts`). All three go down **in one `env.DB.batch()`**, with
 * the `inbound_emails` row already carrying `routed_lead_id` and `outbox_id`,
 * so there is no window in which a message is recorded as routed to a lead
 * that does not exist, or a lead exists that nobody ever acknowledged. That is
 * this repo's own convention for a multi-row write that must land together
 * (`promoteLead`, `src/leads.ts`), and the alternative — three sequential
 * round trips — fails in the one way that is invisible and unrecoverable: the
 * redelivery guard would treat the half-written row as "already handled" and
 * swallow every retry, leaving a stranger who wrote in with silence.
 *
 * ── ONE ROW PER Message-ID ─────────────────────────────────────────────────
 * The guard against writing a message twice is `WHERE NOT EXISTS (… WHERE
 * message_id = ?)` on the insert itself — the *message's own* identity, which
 * is exactly what RFC 5322 says a `Message-ID` is ("globally unique"), not the
 * (`message_id`, `to_email`) pair `migrations/0020_inbound_emails.sql`'s
 * partial unique index enforces. The index stays exactly as #161 shipped it
 * and is still the hard backstop for the race two identical deliveries to the
 * *same* recipient can lose; this guard is deliberately the wider of the two,
 * because one message that Cloudflare delivers to two of our addresses (a
 * customer who writes to `intake@` and copies `intake+SUB-…@`, or an SMTP
 * retry that lands on a different alias) is still **one message**, and
 * answering it twice would send that stranger two acknowledgements and give an
 * operator two leads to triage for one enquiry. When a message carries no
 * `Message-ID` at all there is no identity to deduplicate on and the guard
 * matches nothing, which is the same thing #161's index says by being partial.
 *
 * A sender does control its own `Message-ID`, so a sender can in principle
 * suppress *its own* later message by reusing one — the same (self-inflicted)
 * exposure #161's composite key already had, since the recipient half is not
 * sender-controlled in a way that helps.
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
  /**
   * ── EM-4'S OWN LINK (ISSUE #164) ──────────────────────────────────────────
   * The `leads.id` this row produced, set exactly when `routedKind === "lead"`
   * — rung 6, "nobody we know". `null` for every other row: a `message` row
   * links nowhere here (EM-5 owns `routedProjectId`/`routedSubmissionId`
   * below), an `unrouted` row is deliberately never given a lead ("inventing
   * a fresh lead for someone who may already be a customer is exactly the
   * split-brain CLAUDE.md's ownership rule warns about" — `src/inboundRouter.ts`'s
   * own words), and a `suppressed`/`rate_limited` row was never routed at all.
   */
  routedLeadId: string | null
  /**
   * ── EM-5'S OWN LINK (ISSUE #165) ───────────────────────────────────────────
   * Which project and submission a `"message"` decision (rungs 1-5) actually
   * attached to — set together, exactly when `routedKind === "message"`.
   * `routedProjectId` mirrors `RoutingTarget.projectId` (`src/inboundRouter.ts`)
   * verbatim, including `null` for a one-off request with no project.
   * `routedSubmissionId` stores the `SUB-XXXXXX` **reference**, not the
   * internal row id — the same convention every other portal-owned
   * per-submission table in this schema uses for its own `submission_id`
   * column (`design_rounds`, `signoffs`, `question_answers`, and `messages`
   * itself — see `migrations/0014_messages.sql`), and exactly the value
   * `postMessage` (`src/messages.ts`) was called with. `null` for every other
   * row: a `"lead"` row has no submission (it has `routedLeadId` instead), and
   * an `"unrouted"` row is deliberately left unattached — nothing was decided
   * confidently enough to attach to, which is the whole reason it parks for a
   * human on `/replies` (EM-6) rather than picking one.
   */
  routedProjectId: string | null
  routedSubmissionId: string | null
  /**
   * The `outbox.id` of the drafted acknowledgement this row produced. Set for
   * every routed outcome — `"lead"` (EM-4's stranger draft), `"message"`
   * (EM-5's routed draft) and `"unrouted"` (EM-5's neutral draft) alike — and
   * `null` only for a row that was never routed at all (`suppressed`,
   * `rate_limited`).
   */
  outboxId: string | null
  /**
   * ── EM-7'S OWN LINK (ISSUE #167) ───────────────────────────────────────────
   * When an operator promoted this message to a submission — the escape hatch
   * for a reply that turned out to be a new ask. `null` until promoted; see
   * `src/inboundPromotion.ts`'s `promoteInboundEmail`, the only writer.
   * `promotedAt IS NULL` is the whole lifecycle, exactly as `leads.promoted_at`
   * is for a lead (`migrations/0007_lead_promotion.sql`) — there is no
   * separate status column to disagree with it.
   */
  promotedAt: string | null
  /** The `sub_…` URL id of what promotion produced, or `null`. */
  promotedSubmissionId: string | null
  /** The `SUB-XXXXXX` reference of what promotion produced, or `null`. */
  promotedSubmissionReference: string | null
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
  const attachmentCount = parsed.attachments.length

  // EM-9 (#169): spent only by a message that would otherwise earn a draft —
  // never by one `detectSuppression` already refused. See this module's own
  // doc, "RATE-LIMITING DRAFTS", for why the ordering (after suppression,
  // before routing) is deliberate.
  const rateLimited =
    suppressionReason === null ? await isInboundDraftRateLimited(env, fromEmail) : false

  // Suppressed mail is recorded but never routed — #161's own rule, and the
  // reason the router runs *here* rather than unconditionally inside
  // `insertInboundEmail`: a machine's auto-reply must not be resolved to a
  // person, given a draft, or shown to an operator as a routing decision that
  // was never really made. A rate-limited message gets the identical
  // treatment, for the identical reason: #169's own words, "it just does not
  // earn a reply".
  const decision =
    suppressionReason === null && !rateLimited
      ? await routeInboundMessage(env, { fromEmail, toEmail, subject, bodyText: body.text, authResult })
      : null

  // EM-4 (#164) and EM-5 (#165): every row this write can produce beside
  // `inbound_emails` itself — a lead, a customer message, a drafted
  // acknowledgement — is minted *before* the write, not after it, so every id
  // can be recorded on the `inbound_emails` row in the very statement that
  // creates it and every row lands in one batch. Nothing is written here —
  // `mintLead`/`mintMessage` only generate ids, `intakeReplyStatement`/
  // `routedReplyStatement` only prepare SQL — and each is reached only for
  // the decision it belongs to.
  const id = generateInboundEmailId()
  const guard = insertedRowGuard(id)

  const lead =
    decision?.kind === "lead"
      ? mintLead({ summary: body.text, email: fromEmail, name: fromName })
      : null

  const target: RoutingTarget | null = decision?.kind === "message" ? decision.target : null
  const inboundMessage: Message | null =
    target === null
      ? null
      : mintMessage({
          submissionId: target.submissionReference,
          authorRole: "customer",
          authorEmail: fromEmail,
          body: body.text,
        })

  const draft = draftFor(env, id, fromEmail, decision, lead, target, attachmentCount, guard)

  const record: InboundEmailRecord = {
    id,
    messageId: normaliseMessageId(parsed.messageId),
    fromEmail,
    fromName,
    toEmail,
    subject,
    bodyText: body.text,
    receivedAt: new Date().toISOString(),
    authResult,
    disposition: suppressionReason !== null ? "suppressed" : rateLimited ? "rate_limited" : "received",
    suppressionReason,
    attachmentCount,
    bodyTruncated: body.truncated,
    routedKind: decision?.kind ?? null,
    routedRung: decision?.rung ?? null,
    routedReason: decision?.reason ?? null,
    routedRunnerUp: decision?.runnerUp?.reason ?? null,
    // Rung 6 only, and known before the write — see `writeInboundEmail`.
    routedLeadId: lead?.id ?? null,
    // Rung 1-5 ("message") only, and known before the write — see `writeInboundEmail`.
    routedProjectId: target?.projectId ?? null,
    routedSubmissionId: target?.submissionReference ?? null,
    outboxId: draft?.id ?? null,
    // Nothing promotes a message the instant it arrives — EM-7's action is an
    // operator's later, deliberate click. Every freshly-recorded row starts
    // unpromoted, the same way a freshly-minted lead starts unpromoted too.
    promotedAt: null,
    promotedSubmissionId: null,
    promotedSubmissionReference: null,
  }

  return writeInboundEmail(env, record, lead, inboundMessage, draft)
}

/**
 * The acknowledgement drafted for whichever outcome the router reached —
 * EM-4's stranger template for `"lead"` (issue #164), EM-5's routed template
 * for `"message"` (linked to the submission `postMessage` is about to append
 * to) and EM-5's neutral template for `"unrouted"` (issue #165's own words:
 * "Draft a neutral acknowledgement anyway: the sender should still hear
 * back"). `null` only when `decision` itself is `null` — a suppressed
 * message, never routed and never answered at all.
 */
function draftFor(
  env: Env,
  inboundEmailId: string,
  toEmail: string,
  decision: RoutingDecision | null,
  lead: Lead | null,
  target: RoutingTarget | null,
  attachmentCount: number,
  guard: CreateGuard,
): DraftedIntakeReply | null {
  if (decision === null) return null
  if (decision.kind === "lead" && lead !== null) {
    return intakeReplyStatement(env, inboundEmailId, toEmail, lead.reference, guard, attachmentCount)
  }
  if (decision.kind === "message" && target !== null) {
    return routedReplyStatement(
      env,
      inboundEmailId,
      toEmail,
      `/submissions/${target.submissionId}`,
      // Issue #196 (EM-8's own follow-up): the `SUB-XXXXXX` reference this
      // draft's own Reply-To should plus-address to, distinct from the
      // internal `target.submissionId` the CTA link above resolves against.
      target.submissionReference,
      guard,
      attachmentCount,
    )
  }
  // `"unrouted"` — rung 6's ambiguous case. No submission was confidently
  // attached to, so there is nothing behind Access to send this sender to
  // yet, and no reference to thread a reply to either.
  return routedReplyStatement(env, inboundEmailId, toEmail, null, null, guard, attachmentCount)
}

/**
 * The guard every row EM-4/EM-5 write beside an `inbound_emails` row carries:
 * *this* insert only happens if the row it belongs to actually landed, in this
 * same batch.
 *
 * It reads the id back out of the database rather than trusting the caller's
 * own "I think I won", which is the whole point: inside one `DB.batch()` the
 * `inbound_emails` insert runs first, and by the time these statements are
 * evaluated the answer to "did it insert?" is a plain fact SQLite can see. A
 * redelivery, whose insert did nothing, leaves this `EXISTS` false and so mints
 * neither a lead nor a draft — with no second guard in TypeScript to keep in
 * step with this one.
 */
function insertedRowGuard(inboundEmailId: string): CreateGuard {
  return {
    clause: "WHERE EXISTS (SELECT 1 FROM inbound_emails WHERE id = ?)",
    bindings: [inboundEmailId],
  }
}

/**
 * One `DB.batch()` — the `inbound_emails` row, and whichever of a `leads` row
 * (rung 6, stranger), a `messages` row (rungs 1-5, a known thread), or neither
 * belongs to this decision, plus the drafted acknowledgement every routed
 * outcome gets — then a read back when the insert found the message already
 * recorded.
 *
 * ── WHY A BATCH ────────────────────────────────────────────────────────────
 * D1 runs a batch as a single transaction: all three rows land, or none does.
 * Three sequential round trips instead would let a transient failure between
 * them record a message as `routed_kind = 'lead'` whose `routed_lead_id` is
 * `NULL` forever — and because the redelivery guard reads "the row exists" as
 * "this message was handled", every SMTP retry of that message would then be
 * swallowed and the stranger would never be acknowledged. `promoteLead`
 * (`src/leads.ts`) batches its own client/project/submission writes against
 * exactly this failure, and this is the same shape.
 *
 * ── WHY THE READ-BACK ──────────────────────────────────────────────────────
 * Not an optimisation, a correctness argument: two concurrent redeliveries can
 * both see no row and both attempt the insert, and exactly one wins. The loser
 * must return the winner's row rather than the record it built and threw away,
 * or the same message would report two different ids to two callers.
 *
 * The insert keeps `ON CONFLICT DO NOTHING` **as well as** its `NOT EXISTS`
 * guard, and the difference matters in exactly that race: `NOT EXISTS` is
 * evaluated before the concurrent writer commits, so the losing insert still
 * reaches 0020's partial unique index, and `DO NOTHING` is what turns that into
 * `changes = 0` (a redelivery, resolved by the read-back) instead of a thrown
 * constraint error that would roll the whole batch back and 500 the delivery.
 * No conflict target is named because any uniqueness in 0020 — the index, or
 * the (impossible in practice, free to survive) case of a minted id colliding —
 * should resolve the same way.
 */
async function writeInboundEmail(
  env: Env,
  record: InboundEmailRecord,
  lead: Lead | null,
  inboundMessage: Message | null,
  draft: DraftedIntakeReply | null,
): Promise<RecordInboundEmailResult> {
  const statements = [inboundEmailInsert(env, record)]
  if (lead !== null) statements.push(leadCreationStatement(env, lead, insertedRowGuard(record.id)))
  if (inboundMessage !== null) {
    statements.push(messageCreationStatement(env, inboundMessage, insertedRowGuard(record.id)))
  }
  if (draft !== null) statements.push(draft.statement)

  const results = await env.DB.batch(statements)

  if ((results[0]?.meta?.changes ?? 0) > 0) {
    return { record, duplicate: false }
  }

  const existing = record.messageId === null ? null : await findByMessageId(env, record.messageId)
  return { record: existing ?? record, duplicate: existing !== null }
}

/**
 * The `inbound_emails` insert, guarded on the message's own `Message-ID` — see
 * the module doc's "one row per Message-ID" section for why that, and not
 * 0020's composite index, is where the app draws the line.
 *
 * `message_id` is bound twice (columns, then guard) rather than referenced as
 * a numbered parameter, because every other statement in this repo binds
 * positional `?` and one file quietly using `?2` is a trap for whoever edits
 * the column list next. A `NULL` `message_id` makes the subquery's `= ?` match
 * nothing, so a message with no id of its own is always inserted — the same
 * thing 0020's index says by being partial.
 */
function inboundEmailInsert(env: Env, record: InboundEmailRecord): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO inbound_emails (
       id, message_id, from_email, from_name, to_email, subject, body_text,
       received_at, auth_result, disposition, suppression_reason,
       attachment_count, body_truncated,
       routed_kind, routed_rung, routed_reason, routed_runner_up,
       routed_lead_id, routed_project_id, routed_submission_id, outbox_id
     )
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM inbound_emails WHERE message_id = ?)
     ON CONFLICT DO NOTHING`,
  ).bind(
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
    record.routedLeadId,
    record.routedProjectId,
    record.routedSubmissionId,
    record.outboxId,
    record.messageId,
  )
}

/**
 * The row this message was already recorded as, by `Message-ID` alone.
 *
 * `ORDER BY received_at, rowid` picks the *earliest* recording when more than
 * one exists. Going forward the guard above makes that at most one row, but a
 * database migrated from before this issue can hold two rows for one
 * `Message-ID` delivered to two of our addresses, and "the first time we saw
 * this message" is the stable answer to give both callers — never "whichever
 * one SQLite happened to return".
 */
async function findByMessageId(
  env: Env,
  messageId: string,
): Promise<InboundEmailRecord | null> {
  const row = await env.DB.prepare(
    `${SELECT_COLUMNS} WHERE message_id = ? ORDER BY received_at ASC, rowid ASC LIMIT 1`,
  )
    .bind(messageId)
    .first<InboundEmailRow>()
  return row === null ? null : fromRow(row)
}

const SELECT_COLUMNS = `SELECT id, message_id, from_email, from_name, to_email, subject,
         body_text, received_at, auth_result, disposition, suppression_reason,
         attachment_count, body_truncated,
         routed_kind, routed_rung, routed_reason, routed_runner_up,
         routed_lead_id, routed_project_id, routed_submission_id, outbox_id,
         promoted_at, promoted_submission_id, promoted_submission_reference
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

/**
 * The inbound row one drafted reply answers — the read behind `/replies/:id`
 * (issue #166, EM-6).
 *
 * Keyed on `outbox_id` rather than on `outbox.submission_id`'s mirror of this
 * table's own id, even though EM-4/EM-5 write both and either would resolve
 * the same row today. `outbox_id` is the direction that says what the caller
 * actually has in hand ("I am looking at this draft; what is it about?"), and
 * it is the column that stays correct if a future issue ever drafts a second
 * reply for one message: two `outbox` rows would each name their own inbound
 * row, whereas `submission_id` would resolve one message to whichever draft
 * SQLite happened to return.
 */
export async function getInboundEmailByOutboxId(
  env: Env,
  outboxId: string,
): Promise<InboundEmailRecord | null> {
  const row = await env.DB.prepare(`${SELECT_COLUMNS} WHERE outbox_id = ? LIMIT 1`)
    .bind(outboxId)
    .first<InboundEmailRow>()
  return row === null ? null : fromRow(row)
}

/**
 * The same read for a whole screenful of drafts — `GET /replies` renders one
 * row per pending draft and needs each one's sender, subject and routing
 * decision. One query rather than one per row: the list is unbounded in
 * principle (every draft nobody has acted on yet) and D1 charges per round
 * trip, so a per-row lookup is the kind of thing that is invisible with three
 * drafts and painful with three hundred.
 *
 * Returned keyed by `outbox_id` so the caller can keep the draft list's own
 * ordering rather than re-deriving it here. An id with no row simply does not
 * appear — a draft whose `inbound_emails` row is missing cannot be rendered
 * (there is no sender, subject or routing decision to show) and the list drops
 * it, the same posture `fromRow` (`src/notifications.ts`) takes for a row of a
 * type it does not recognise. EM-4/EM-5 write both rows in one `DB.batch()`,
 * so this is unreachable in practice.
 *
 * Split with `chunkForBinding` (`src/d1.ts`) for the reason `getProjectsByIds`
 * already is: the pending queue is unbounded, and one `IN (…)` over more than
 * `D1_MAX_BOUND_PARAMS` ids is `D1_ERROR: too many SQL variables` — a screen
 * that works until the day nobody clears their queue is worse than one that
 * never worked.
 */
export async function getInboundEmailsByOutboxIds(
  env: Env,
  outboxIds: string[],
): Promise<Map<string, InboundEmailRecord>> {
  const found = new Map<string, InboundEmailRecord>()
  if (outboxIds.length === 0) return found

  const batches = await Promise.all(
    chunkForBinding(outboxIds).map(async (chunk) => {
      const placeholders = chunk.map(() => "?").join(", ")
      const { results } = await env.DB.prepare(`${SELECT_COLUMNS} WHERE outbox_id IN (${placeholders})`)
        .bind(...chunk)
        .all<InboundEmailRow>()
      return results ?? []
    }),
  )

  for (const row of batches.flat()) {
    const record = fromRow(row)
    if (record.outboxId !== null) found.set(record.outboxId, record)
  }
  return found
}

/**
 * The email a lead came in on, if it came in on one at all — `null` for every
 * lead `POST /start`'s web form wrote.
 *
 * The back-reference EM-4's own text asks for ("so `/replies` and future
 * triage can get from one to the other"), landed here by EM-6 (issue #166)
 * because the Gate-A contract pins where it renders: as plain text on the
 * lead's own `/leads/:id` screen, not as a cross-link either direction. The
 * stranger case is the only one that has both a lead and a drafted reply, and
 * `/replies`' own row disappears the moment the draft is approved — so the
 * lead's screen is the surface that has to remember how it arrived.
 *
 * `ORDER BY received_at ASC, rowid ASC` picks the earliest, for the same
 * reason `findByMessageId` does: at most one row can name a given lead today
 * (`routed_lead_id` is written once, in the same batch that mints the lead),
 * and "the first one we recorded" is the stable answer if that ever stops
 * being true, rather than "whichever one SQLite happened to return".
 */
export async function getInboundEmailByLeadId(
  env: Env,
  leadId: string,
): Promise<InboundEmailRecord | null> {
  const row = await env.DB.prepare(
    `${SELECT_COLUMNS} WHERE routed_lead_id = ? ORDER BY received_at ASC, rowid ASC LIMIT 1`,
  )
    .bind(leadId)
    .first<InboundEmailRow>()
  return row === null ? null : fromRow(row)
}

/**
 * Where an operator re-routed one inbound message to — issue #166's own third
 * action, "Change route: re-run against an operator-chosen client / project /
 * lead."
 *
 * The same five columns EM-3/EM-4/EM-5 fill at delivery time, restated by a
 * human. `routedRung` is deliberately NOT in this shape: the rung records
 * *which rung of the router's ladder decided this*, and after a hand-route the
 * honest answer to that is still "rung N, and a person disagreed" — overwriting
 * it would erase the very decision `/replies` exists to let an operator argue
 * with. `routedReason` carries the disagreement instead.
 */
export interface InboundRetarget {
  kind: RoutedKind
  /** Human-readable, and now operator-authored — `reply-route-reason`'s source. */
  reason: string
  projectId: string | null
  /** The `SUB-XXXXXX` **reference**, matching `routedSubmissionId`'s own convention above. */
  submissionReference: string | null
  leadId: string | null
}

/**
 * Applies one `InboundRetarget` to one row — returned rather than executed, so
 * it lands in the same `DB.batch()` as the redrafted `outbox` row (and, for
 * the "become a lead" branch, the `leads` row) it belongs with. A message
 * re-routed to a project whose draft still points at the old thread, or a
 * lead-shaped decision with no lead behind it, is not a partial success; it is
 * a screen that lies to the next operator who opens it.
 *
 * `routed_runner_up` is cleared unconditionally. It records the candidate *the
 * router* scored and declined; once a person has overridden the whole
 * decision, leaving it would attribute a second-place finish to a contest that
 * no longer decided anything.
 *
 * `guard` is required, not optional, for the same reason `intakeReplyStatement`
 * (`src/notifications.ts`) makes it required: the only caller has one
 * (`pendingDraftGuard` — every EM-6 write is guarded on its draft still being
 * `pending`), and a bare re-target would let a double-clicked route form move
 * a row whose draft another tab already approved and sent.
 */
export function retargetInboundEmailStatement(
  env: Env,
  inboundEmailId: string,
  retarget: InboundRetarget,
  guard: CreateGuard,
): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE inbound_emails
        SET routed_kind = ?, routed_reason = ?, routed_runner_up = NULL,
            routed_project_id = ?, routed_submission_id = ?, routed_lead_id = ?
      WHERE id = ?
        ${guard.clause}`,
  ).bind(
    retarget.kind,
    retarget.reason,
    retarget.projectId,
    retarget.submissionReference,
    retarget.leadId,
    inboundEmailId,
    ...guard.bindings,
  )
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
  routed_lead_id: string | null
  routed_project_id: string | null
  routed_submission_id: string | null
  outbox_id: string | null
  promoted_at: string | null
  promoted_submission_id: string | null
  promoted_submission_reference: string | null
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
    routedLeadId: row.routed_lead_id,
    routedProjectId: row.routed_project_id,
    routedSubmissionId: row.routed_submission_id,
    outboxId: row.outbox_id,
    promotedAt: row.promoted_at,
    promotedSubmissionId: row.promoted_submission_id,
    promotedSubmissionReference: row.promoted_submission_reference,
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
