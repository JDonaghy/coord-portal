import { generateOutboxId } from "./ids"
import { getCurrentRound } from "./rounds"
import { titleOf, type CreateGuard, type Submission } from "./submissions"
import type { Env } from "./types"

/**
 * Customer notifications — issue #14. "The async loop only works if 'come
 * back later' actually reaches the customer."
 *
 * Digest-first, not instant: transactional email for exactly the three states
 * the Gate-A contract pins as sending (§ "Customer status vocabulary") —
 * `awaiting-signoff` ("a design round is ready for sign-off"), `needs-input`
 * ("a question was raised"), `shipped` ("work shipped") — and *only* those
 * three. "A customer does not need to watch the pipeline breathe": every
 * other status transition, and every coord-side heartbeat or churn push,
 * produces no row here at all. Per-recipient quiet hours are an explicit v2
 * refinement (issue #14) and are not modeled here.
 *
 * This module decides WHAT to send and records it; `migrations/0009_notifications.sql`
 * is the durable store, and `src/routes/outbox.ts` is the only reader
 * (`GET /outbox`, scoped to the caller's own sends, same as the dashboard is
 * scoped to the caller's own submissions). Actually dispatching the message —
 * which provider carries it, retries, bounces, SPF/DKIM — is out of scope for
 * this milestone; nothing black-box in this repo can observe a real inbox, so
 * what is asserted (and what this module guarantees) is what the portal
 * *decided* to send.
 */

/**
 * NOTE (issue #110, chat thread): a posted message does NOT join
 * `SENDING_TYPES` below, deliberately. Issue #110 asks "does a new message
 * trigger an email... or is it portal-only?" and flags that #83/#98's
 * CTA-link gap — a call to action built, stored and rendered on `/outbox`,
 * and dropped at the actual provider boundary, live for a whole milestone
 * before anyone noticed — is the failure mode to check against before
 * deciding. That gap does not repeat here, for two independent reasons
 * rather than one:
 *
 *   1. A message is never lost. `src/messages.ts`'s `postMessage` is a
 *      single durable INSERT with no delivery leg at all — there is no
 *      provider boundary for a message to be dropped at the way #83's CTA
 *      was, no cache, no queue with a retry policy that can silently
 *      exhaust. It is visible to both parties the moment either reloads
 *      `/submissions/:id`, which is this milestone's explicitly-scoped bar
 *      (issue #110's own non-goal: "not proposing real-time delivery... a
 *      page that shows new messages on reload/refresh is enough for v1").
 *   2. Every existing transactional email's call to action already lands on
 *      `/submissions/:id` (`emailContent` below, `ctaHref`) — the exact page
 *      the thread lives on. A customer who gets any of the three pinned
 *      emails is already one click from the thread; there is no separate
 *      "message" surface that could go unlinked the way #83's CTA did.
 *
 * A dedicated "you have a new message" email is a legitimate future
 * refinement (paired with the "digest-first, not instant" restraint this
 * module already argues for above) but is out of scope here: it would need
 * its own decision about the *operator* side (this module has no concept of
 * sending TO an operator today — every row in `outbox` is addressed to
 * `submission.customerEmail`), and about coalescing multiple messages sent in
 * one sitting, neither of which #110 asks this milestone to solve.
 *
 * #98 could not be located anywhere in this repo's history, code or tests as
 * of this change — grepping the tree for "#98" or "issue #98" turns up
 * nothing. If it names a real, resolved defect it lives in a different repo
 * (most likely the coordinator's own issue tracker) and its resolution could
 * not be checked from here; the two points above are this change's own
 * answer to "don't silently drop a customer message," reasoned from what
 * #83's actual defect and fix were (see `src/drain.ts`, `src/mailProvider.ts`,
 * `tests/acceptance/ms-3/83-email-link.spec.ts`), not from a document this
 * repo does not have.
 */

/**
 * Contract § `data-testid` hooks, Emails (11-13): the pinned `data-email-type`s,
 * plus `preview-ready` — issue #107's pre-merge approval gate, the fourth
 * sending type this portal has ever had. `quality-check` earns the same
 * "instant-ish, not a digest" treatment `awaiting-signoff` gets: it is the
 * one other status a customer must actually act on, not merely a status
 * report to skim later.
 *
 * `intake-reply` — issue #162 (EM-2, milestone #5) — is the fifth. When #162
 * landed, nothing in this repo inserted a row of this type yet; it was added
 * then only so `migrations/0021_outbox_approval.sql`'s widened
 * `outbox.email_type` CHECK and this vocabulary landed together, ahead of a
 * writer existing to need it. Issue #164 (EM-4) is that writer:
 * `intakeReplyStatement` below is the first, and so far only, code that inserts
 * one — a stranger's inbound-email acknowledgement, drafted `pending` for a
 * human to approve. Skipping this vocabulary edit while widening the column
 * would not have failed loudly — `fromRow` below just returns `null` for any
 * row of a type it does not recognise, so an intake-reply row would have
 * silently vanished from both `/outbox` and `/deliveries` the moment one was
 * ever written.
 */
export const SENDING_TYPES = [
  "signoff-ready",
  "needs-input",
  "shipped",
  "preview-ready",
  "intake-reply",
] as const

export type SendType = (typeof SENDING_TYPES)[number]

/**
 * The pinned status -> send mapping (Gate-A contract, § "Customer status
 * vocabulary"). `awaiting-signoff` and `needs-input` are the two
 * customer-actionable states; `shipped` is the terminal one. Every other slug
 * in the vocabulary maps to nothing, which is the whole restraint half of
 * issue #14.
 */
const TYPE_FOR_STATUS: Partial<Record<string, SendType>> = {
  "awaiting-signoff": "signoff-ready",
  "needs-input": "needs-input",
  shipped: "shipped",
  // Issue #107: the moment a submission reaches `quality-check` is exactly
  // the moment the customer has something new to act on — the real, live
  // preview build, not a mock. Same restraint as every other entry here: a
  // later push that merely revises `preview_url` while `status` stays at
  // `quality-check` never reaches this map at all (see
  // `src/bridge/updates.ts`'s "only a push that actually names `status`
  // counts").
  "quality-check": "preview-ready",
}

export function sendTypeForStatus(status: string): SendType | null {
  return TYPE_FOR_STATUS[status] ?? null
}

/**
 * NOTE (v2 quiet-hours refinement, issue #14): a push that re-sets `status` to
 * the *same* sending value it is already at — e.g. coord proposes design round
 * 2 with another `awaiting-signoff` push while round 1 is still awaiting
 * sign-off — reads as a fresh transition here and sends a second email. The
 * sealed acceptance suite (`tests/acceptance/ms-1/14-notifications.spec.ts`,
 * "a re-applied push does not re-send an email") deliberately leaves this
 * ambiguous: what it pins is that an `already_applied` replay (same or stale
 * revision) never re-sends, not that re-entering a sending state at a genuinely
 * newer revision is silent. Re-proposing a round or raising a second question
 * is plausibly real news, so this is left as-is rather than guessed at; a
 * future per-recipient quiet-hours pass is the right place to decide whether
 * same-state-to-same-state should coalesce.
 */

/**
 * The sending address every email carries. Matches the three pinned mocks
 * (`mocks/11-13-email-*.html`) — the contract pins `email-from` as a hook, not
 * this literal string (a test may only assert "looks like an address").
 *
 * Issue #51 moves the source of truth to `env.EMAIL_FROM` (a `wrangler.toml`
 * `[vars]` entry, not a secret) so a per-environment sending address is a
 * config change rather than this code changing. This constant survives as the
 * fallback for a checkout that has not declared the var — better to send with
 * the address this module always used than with an empty `From` — see
 * `emailFrom` below.
 *
 * #52 moved that fallback off `intake.heurontech.com`. Only
 * `mail.heurontech.com` is verified with Resend; `intake.heurontech.com` is
 * this Worker's own custom domain, has no MX, and a send from it is refused as
 * an unverified sender. A fallback nobody can send from is a latent outage
 * waiting for the first checkout that forgets the var, so the fallback now
 * names the domain that actually works. The acceptance environment still
 * overrides `EMAIL_FROM` back to the pinned historical literal (package.json),
 * so this constant is not what the sealed mocks are matched against.
 *
 * #105 changed the display name here for the same reason it changed
 * `wrangler.toml`'s: a fallback that sends as `coord-portal` names this repo's
 * internal tool rather than the business the recipient knows, which is the
 * brand mismatch that put a real send in a spam folder. A checkout that
 * forgets the var should degrade to the wrong-but-sendable ADDRESS, not to the
 * wrong NAME as well. The address is untouched.
 */
const DEFAULT_EMAIL_FROM = "Heuron Technology <notify@mail.heurontech.com>"

/** `env.EMAIL_FROM`, falling back to the historical literal if unset. */
function emailFrom(env: Env): string {
  return env.EMAIL_FROM ?? DEFAULT_EMAIL_FROM
}

/**
 * The delivery state vocabulary — issue #49, Gate-A contract § "Delivery
 * state vocabulary". `queued` (decided, not yet delivered — fresh or
 * mid-retry, indistinguishable to the customer), `sent` (the provider
 * accepted it), `failed` (every retry exhausted, terminal). A row's status
 * only ever moves `queued -> sent` or `queued -> failed`; nothing in this
 * module ever writes either of those transitions — that is #50 (the cron
 * drain) and #51 (the provider seam). This module only ever inserts a row
 * `queued` (the column's own `DEFAULT`, `migrations/0010_outbox_delivery_state.sql`).
 */
export const DELIVERY_STATUSES = ["queued", "sent", "failed"] as const
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number]

function isDeliveryStatus(value: string): value is DeliveryStatus {
  return (DELIVERY_STATUSES as readonly string[]).includes(value)
}

/**
 * The fixed `data-status` slug -> exact `delivery-status` pill text — issue
 * #49, Gate-A contract § "Delivery state vocabulary". Three slugs, three
 * strings, nothing else, ever.
 *
 * Shared by both readers of this vocabulary: `/outbox` (`src/routes/outbox.ts`,
 * issue #49, scoped to one customer) and `/deliveries`
 * (`src/routes/deliveries.ts`, issue #55, every customer). The pill text is
 * not the customer-safety-sensitive part of either screen — that is
 * `last_error`, which the two routes deliberately do NOT share a rendering
 * path for (see `src/routes/deliveries.ts`'s module comment) — so one source
 * of truth here is only avoiding copy-paste vocabulary drift, not a
 * redaction shortcut.
 */
export const DELIVERY_STATUS_TEXT: Record<DeliveryStatus, string> = {
  queued: "Queued",
  sent: "Sent",
  failed: "Delivery failed",
}

export interface OutboxEmail {
  id: string
  /** The customer-visible `SUB-XXXXXX` reference this send is about. */
  submissionId: string
  type: SendType
  to: string
  from: string
  subject: string
  preheader: string
  body: string
  ctaText: string
  ctaHref: string
  /**
   * When the portal decided to send — `migrations/0010_outbox_delivery_state.sql`
   * renamed this from the original `sent_at` (0009's decision-time column) so
   * that `sent_at` below could mean actual delivery time instead. List
   * ordering (`listOutboxForCustomer`) sorts by this, unchanged from ms-1's
   * "oldest first".
   */
  queuedAt: string
  status: DeliveryStatus
  /** Set only once `status = "sent"` — issue #49's own words. */
  providerMessageId: string | null
  attempts: number
  /**
   * The raw provider/operator string, never rendered verbatim to a customer —
   * see `src/routes/outbox.ts`'s customer-safe copy.
   */
  lastError: string | null
  /** Actual delivery time; present iff `status = "sent"`. Null otherwise. */
  sentAt: string | null
}

interface OutboxRow {
  id: string
  submission_id: string
  email_type: string
  to_email: string
  from_email: string
  subject: string
  preheader: string
  body: string
  cta_text: string
  cta_href: string
  queued_at: string
  status: string
  provider_message_id: string | null
  attempts: number
  last_error: string | null
  sent_at: string | null
}

/**
 * A row can only ever have been written by `recordNotificationForStatus`
 * below, which validates against `SENDING_TYPES` before it writes — the
 * `CHECK` constraints on `outbox.email_type` and `outbox.status`
 * (`migrations/0009_notifications.sql`, `migrations/0010_outbox_delivery_state.sql`)
 * backstop that further. `null` here means a row this code has no business
 * ever seeing (a hand edit, a future migration widening either column);
 * skipping it from the read-back is safer than fabricating a specific type or
 * status it was never actually in.
 */
function fromRow(row: OutboxRow): OutboxEmail | null {
  if (!isSendType(row.email_type)) return null
  if (!isDeliveryStatus(row.status)) return null
  return {
    id: row.id,
    submissionId: row.submission_id,
    type: row.email_type,
    to: row.to_email,
    from: row.from_email,
    subject: row.subject,
    preheader: row.preheader,
    body: row.body,
    ctaText: row.cta_text,
    ctaHref: row.cta_href,
    queuedAt: row.queued_at,
    status: row.status,
    providerMessageId: row.provider_message_id,
    attempts: row.attempts,
    lastError: row.last_error,
    sentAt: row.sent_at,
  }
}

function isSendType(value: string): value is SendType {
  return (SENDING_TYPES as readonly string[]).includes(value)
}

/**
 * Records one outbox send for a status transition, if (and only if) `status`
 * is one of the three sending states — the restraint half of issue #14,
 * stated as a black-box invariant by the Gate-A contract: "no other status
 * transition produces `email-preview` output."
 *
 * Called from `src/bridge/updates.ts` once per push that sets `status` *and*
 * whose own guarded status write actually won (see the `meta.changes` check
 * there — a push whose write lost to a concurrent newer revision must not
 * report on a status the submission never actually reached). Run after the
 * same push's own writes (the status column, and — for `awaiting-signoff` —
 * the design round it just published) have already landed, so the content
 * below can read what was just written rather than racing it, and deferred
 * via `ctx.waitUntil` so that a failure here — or the D1 round trips it costs
 * — can never fail the request whose real write already committed.
 *
 * Idempotent in two layers: the bridge's own `(submission_id, revision)`
 * watermark means a replayed push never reaches this function a second time
 * for the same revision (`src/bridge/updates.ts`'s `already_applied` branch
 * returns before any write), and `UNIQUE (submission_id, coord_revision)` on
 * `outbox` is the belt-and-braces backstop against that ever changing under
 * this function without it noticing.
 */
export async function recordNotificationForStatus(
  env: Env,
  submission: Submission,
  status: string,
  revision: number,
  now: string,
): Promise<void> {
  const type = sendTypeForStatus(status)
  if (type === null) return
  // No recorded address, nobody to tell. Should not happen in practice (the
  // intake form collects one), but a send with no recipient is worse than no
  // send at all.
  if (!submission.customerEmail) return

  const content = await emailContent(env, submission, type)

  // `status`, `attempts`, `provider_message_id` and `sent_at` are all left to
  // their column defaults — every row this function writes is born `queued`
  // (issue #49's own words: "existing rows migrate to queued", and nothing
  // makes a *new* row start anywhere else either), zero attempts, no
  // provider id, no delivery time yet.
  await env.DB.prepare(
    `INSERT INTO outbox
       (id, submission_id, email_type, to_email, from_email, subject, preheader, body, cta_text, cta_href, coord_revision, queued_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (submission_id, coord_revision) DO NOTHING`,
  )
    .bind(
      generateOutboxId(),
      submission.reference,
      type,
      submission.customerEmail,
      emailFrom(env),
      content.subject,
      content.preheader,
      content.body,
      content.ctaText,
      content.ctaHref,
      revision,
      now,
    )
    .run()
}

export interface EmailContent {
  subject: string
  preheader: string
  body: string
  ctaText: string
  ctaHref: string
}

/**
 * The signature every body closes with — issue #105. One line, first person,
 * naming a person and the business he works for.
 *
 * The defect this fixes is not a missing flourish. The three bodies below used
 * to be a single canned sentence with no sender, no business name and no
 * reason-for-receipt, which reads exactly like the boilerplate a bulk sender
 * emits — a real recipient (dogfood, SUB-C467AA) found one in her spam folder
 * and still nearly dismissed it as spam after finding it. "We" also named
 * nobody: the portal fronts a one-person shop, so the site's own plain,
 * first-person voice is both truer and more trustworthy than a corporate
 * plural. Kept as one constant so the three bodies cannot drift apart, and so
 * `composeHtmlBody`'s paragraph split (`src/mailProvider.ts`) has one shape to
 * honour rather than three.
 */
const SIGNATURE = "\n\n— John, Heuron Technology"

/**
 * The copy for each of the three sending states — illustrative, not pinned:
 * the Gate-A contract pins the email's `data-testid` hooks (§ Emails 11-13)
 * but, per its own note on `verdict-pill`-style copy elsewhere, not the exact
 * subject or call-to-action wording. What *is* load-bearing is the call to
 * action's destination (every type routes back to this submission — issue
 * #14's whole premise, "the async loop only works if 'come back later'
 * actually reaches the customer") and that no engineer-side identifier ever
 * rides in the body: `title` comes from `titleOf`, the customer's own words
 * from the intake form, never coord-authored text.
 *
 * #105 rewrote all three. Each subject now carries "— Heuron Technology" and
 * each body closes with `SIGNATURE`, so the business the recipient actually
 * knows is named in the two places she reads before deciding whether this is
 * junk: the subject line in her inbox list, and the last line of the body.
 * `preheader`, `ctaText`, `ctaHref` and the round-aware preheader below are
 * deliberately unchanged — nothing about them was part of the defect, and the
 * preheader is the one string the sealed suite reads a round number out of.
 */
export async function emailContent(env: Env, submission: Submission, type: SendType): Promise<EmailContent> {
  const title = titleOf(submission)
  const ctaHref = `/submissions/${submission.id}`

  if (type === "signoff-ready") {
    const round = await getCurrentRound(env, submission.reference)
    return {
      subject: "Design ready for review — Heuron Technology",
      preheader: round ? `${title} — Round ${round.round}` : title,
      body: `Hi — I've put together a design for "${title}." Take a look and either approve it or tell me what to change.${SIGNATURE}`,
      ctaText: "Review the design",
      ctaHref,
    }
  }

  if (type === "needs-input") {
    return {
      subject: "A quick question about your project — Heuron Technology",
      preheader: title,
      body: `Work on "${title}" is paused until you answer one question.${SIGNATURE}`,
      ctaText: "Answer the question",
      ctaHref,
    }
  }

  if (type === "preview-ready") {
    // Issue #107: linked to the portal submission page, exactly like
    // `signoff-ready` above — never the raw preview URL directly. The
    // customer approves or requests changes from there, same as a design
    // round; the raw link only ever appears once they're behind Access on
    // that page (`src/routes/submission.ts`).
    return {
      subject: "A preview is ready for your review — Heuron Technology",
      preheader: title,
      body: `The real build for "${title}" is up and ready for you to look at. Take a look and either approve it or tell me what to change.${SIGNATURE}`,
      ctaText: "Review the preview",
      ctaHref,
    }
  }

  return {
    subject: "Your project has shipped — Heuron Technology",
    preheader: title,
    body: `"${title}" is live. Thanks for working with me on this.${SIGNATURE}`,
    ctaText: "View the result",
    ctaHref,
  }
}

/**
 * The fixed `coord_revision` every `intake-reply` draft is enqueued with —
 * issue #164 (EM-4 of milestone #5). `recordNotificationForStatus`'s own
 * idempotency key is `(submission_id, coord_revision)`, one real submission
 * revision per row; an intake-reply draft has no submission and no revision
 * to be about, so this reuses that exact column pair for a different purpose:
 * `submission_id` carries the `inbound_emails.id` the draft is *for* (never a
 * real `submissions.id` — there is no FK, per CLAUDE.md § Ownership, and
 * nothing downstream parses this column's shape), and `coord_revision` is
 * this fixed constant, because there is only ever one draft per inbound
 * email. See `intakeReplyStatement` below for why this is the belt-and-braces
 * layer issue #164 itself asks for, not the only thing standing between one
 * inbound email and two drafts.
 */
const INTAKE_REPLY_REVISION = 0

/**
 * The stranger-case acknowledgement — issue #164's own template. Deterministic
 * and rendered in the Worker, exactly like `emailContent`'s three states, but
 * with none of that function's inputs: a stranger's draft is not about a
 * `Submission` at all, only about the `LEAD-XXXXXX` reference `createLead`
 * just minted for them.
 *
 * ── WHY THIS NEVER TAKES THE SENDER'S OWN MESSAGE ───────────────────────────
 * #164's own words: "it never quotes submission content and never discloses
 * state." The only sender-controlled value that could possibly reach this
 * function is `leadReference` itself, and that is portal-minted text
 * (`generateLeadReference`, `src/ids.ts`), never anything the sender wrote —
 * so there is no parameter here a caller could accidentally thread the
 * message body or subject through.
 *
 * ── WHY THE COPY MIRRORS `/start`'S RECEIPT ─────────────────────────────────
 * "Mirror the copy `/start`'s receipt already uses, including the reference:
 * the lead reference is what the sender quotes back, and rung 2 reads it.
 * Same voice, same promise, different channel." `receipt` in
 * `src/routes/start.ts` is that copy; the body below restates its two load-
 * bearing promises ("nothing to sign into, nothing to check back on" and
 * "quote the reference to follow up") in first person, so a sender who saw
 * the web form's receipt and a sender who only ever emailed in read the same
 * thing.
 *
 * ── WHY THE CTA NAMES NO URL ─────────────────────────────────────────────────
 * Every other template's CTA lands on `/submissions/:id`, an Access-gated
 * page — the whole safety argument for sending unprompted mail to an address
 * nobody has verified yet ("even a reply that reaches the wrong person shows
 * them a login screen"). A stranger's own lead has no Access seat at all
 * (`/leads/:id` is an *operator* screen, gated by the operator allowlist, not
 * something this sender could ever sign into), so there is no Access-gated
 * page to send them to — the contract's own resolution of #164's cut-off
 * sentence. The reference is the only thing this draft asks the sender to
 * hold onto; `ctaHref`/`ctaText` still have to be non-empty strings (the
 * `outbox` schema's own `NOT NULL`), so they point back to the public site
 * home, exactly where `/start`'s own receipt already sends a "back home"
 * click.
 */
export function intakeReplyContent(leadReference: string): EmailContent {
  return {
    subject: "Got it — thanks for reaching out — Heuron Technology",
    preheader: `Reference ${leadReference}`,
    body:
      `Thanks for reaching out — got it, and I'll follow up soon. There's nothing to sign into and ` +
      `nothing to check back on; if you want to follow up yourself, just quote ${leadReference} in ` +
      `your reply.${SIGNATURE}`,
    ctaText: "Back home",
    ctaHref: "/",
  }
}

/**
 * Drafts one `intake-reply` acknowledgement — issue #164 (EM-4 of milestone
 * #5). A dedicated statement, deliberately not a call through
 * `recordNotificationForStatus`: that function is bound to a bridge status
 * push (it reads a `Submission`, and its idempotency key is a submission
 * revision) and neither exists for a stranger's email — there is no
 * submission yet, only the lead `recordInboundEmail`
 * (`src/inboundEmail.ts`) just created.
 *
 * Written `pending` (`approval_state`), never `not_required` — issue #162's
 * own gate: a drafted reply waits for a human on `/replies` (EM-6) before the
 * drain (`src/drain.ts`) will ever claim it. Every other column is exactly
 * what `recordNotificationForStatus` would write for an ordinary send:
 * `status` and `attempts` left to their column defaults (born `queued`, zero
 * attempts), `queued_at` stamped now.
 *
 * ── RETURNED, NOT EXECUTED ─────────────────────────────────────────────────
 * The statement comes back with the `outbox.id` it will carry, so the caller
 * can write it in the *same* `DB.batch()` as the `inbound_emails` row and the
 * `leads` row it belongs to. A stranger's message produces three rows across
 * three tables and they are one fact: an acknowledgement drafted for a lead
 * that does not exist, or a lead nobody ever acknowledged, is not a partial
 * success, it is a stranger who wrote in and got silence. `promoteLead`
 * (`src/leads.ts`) batches its own multi-table write for exactly this reason
 * and this follows it.
 *
 * `guard` is required, not optional, for the same reason: the only caller has
 * one (`WHERE EXISTS (SELECT 1 FROM inbound_emails WHERE id = ?)` — draft
 * nothing unless the row that justifies the draft actually landed), and a
 * guard is what keeps the `SELECT` from being bare, which is what makes the
 * `ON CONFLICT` tail below unambiguous to SQLite in an `INSERT … SELECT`.
 *
 * `ON CONFLICT (submission_id, coord_revision) DO NOTHING` is the
 * belt-and-braces layer #164's own text asks for ("key the draft on the
 * `inbound_emails` row id with a `UNIQUE` constraint or an `ON CONFLICT DO
 * NOTHING`") — see `INTAKE_REPLY_REVISION` above for why that existing pair,
 * not a new column, is this draft's idempotency key. It is genuinely the
 * belt to the guard's suspenders: the `inbound_emails` id this keys on is
 * minted in the same call, so no earlier draft can exist under it.
 */
export interface DraftedIntakeReply {
  /** The `outbox.id` the statement will insert — known before it runs. */
  id: string
  statement: D1PreparedStatement
}

export function intakeReplyStatement(
  env: Env,
  inboundEmailId: string,
  toEmail: string,
  leadReference: string,
  guard: CreateGuard,
): DraftedIntakeReply {
  const id = generateOutboxId()
  const now = new Date().toISOString()
  const content = intakeReplyContent(leadReference)

  const statement = env.DB.prepare(
    `INSERT INTO outbox
       (id, submission_id, email_type, to_email, from_email, subject, preheader, body, cta_text, cta_href, coord_revision, queued_at, approval_state)
     SELECT ?, ?, 'intake-reply', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending'
     ${guard.clause}
     ON CONFLICT (submission_id, coord_revision) DO NOTHING`,
  ).bind(
    id,
    inboundEmailId,
    toEmail,
    emailFrom(env),
    content.subject,
    content.preheader,
    content.body,
    content.ctaText,
    content.ctaHref,
    INTAKE_REPLY_REVISION,
    now,
    ...guard.bindings,
  )

  return { id, statement }
}

/**
 * Every email ever sent to one customer, oldest first — the read side of the
 * outbox. Scoped by `to_email`, the same shape `listSubmissionsForCustomer`
 * uses for `GET /submissions` (issue #12: "a customer can only ever see their
 * own"): a notification is the one surface where that guarantee leaves the
 * site, so `GET /outbox` (src/routes/outbox.ts) must scope it exactly as
 * tightly as every other customer-facing route.
 */
export async function listOutboxForCustomer(env: Env, email: string): Promise<OutboxEmail[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM outbox WHERE to_email = ? ORDER BY queued_at ASC, id ASC`,
  )
    .bind(email)
    .all<OutboxRow>()
  return (results ?? [])
    .map(fromRow)
    .filter((email): email is OutboxEmail => email !== null)
}

/**
 * Every outbox row, across every customer, most recent activity first — the
 * operator's counterpart to `listOutboxForCustomer` above (issue #55,
 * Gate-A contract § "The operator delivery view"). Deliberately unscoped: the
 * one caller allowed to see every customer's rows on a single screen is
 * `GET /deliveries` (`src/routes/deliveries.ts`), gated by `readOperator`
 * rather than by `to_email` the way this module's other reader is. See that
 * route's module comment for why this is a second function rather than
 * `listOutboxForCustomer` with an "every customer" flag threaded through it.
 *
 * "Most recent activity first" (issue #55's own words) is ambiguous for a
 * `sent` row: is its activity the decision (`queued_at`) or the delivery
 * (`sent_at`)? That is the same conflict this contract's Notes item 1 already
 * records for `outbox.sent_at`'s two meanings, inherited here rather than
 * resolved. This orders by whichever is later — `sent_at` once a row has one,
 * `queued_at` until then — which is also the only ordering a sealed test can
 * assert without pinning that open question (see the route's own comment on
 * the "Ordering" contract section). A `failed` row's retries never touch
 * either column, so a much-retried row still sorts by when it was first
 * decided, not by its last retry attempt — there is no column that records
 * that moment.
 */
export async function listAllOutbox(env: Env): Promise<OutboxEmail[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM outbox ORDER BY COALESCE(sent_at, queued_at) DESC, id DESC`,
  ).all<OutboxRow>()
  return (results ?? [])
    .map(fromRow)
    .filter((email): email is OutboxEmail => email !== null)
}
