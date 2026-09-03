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
 * ── ISSUE #169 (EM-9) — "SAY OUT LOUD THAT ATTACHMENTS ARE DROPPED" ─────────
 *
 * Storing customer files is a real feature with its own decisions — R2
 * layout, retention, size caps, scanning, who may read them — and out of
 * scope for this milestone. What is in scope, and what this function is, is
 * the failure mode a silent drop produces: a customer who attached a
 * screenshot and got a cheerful acknowledgement will assume the business has
 * it. `src/inboundEmail.ts` never stores the attachment payload — only the
 * count (`attachment_count`) — so this is the one place that count reaches
 * the sender at all, alongside `reply-attachments-dropped` (EM-6,
 * `src/routes/replies.ts`) putting the same count in front of the operator.
 *
 * Appended, never woven into the templates' own opening line, so both
 * `intakeReplyContent` and `routedReplyContent` below share one copy rather
 * than each inventing its own — the same "one constant, not three drifting
 * copies" reasoning `SIGNATURE` itself already gives.
 *
 * Deliberately does not claim the attachment was kept, saved, or is
 * retrievable (Gate-A contract § "Attachments") — only that it did not come
 * through, and that a person can be told directly if it matters. It also
 * never repeats anything the sender wrote (there is nothing here to repeat:
 * the only sender-controlled input is the count itself, an integer, not
 * text).
 */
function attachmentDisclosure(attachmentCount: number): string {
  if (attachmentCount <= 0) return ""
  const plural = attachmentCount === 1 ? "attachment" : "attachments"
  const pronoun = attachmentCount === 1 ? "it" : "them"
  return (
    `\n\nOne more thing — this mailbox can't take attachments yet, so the ${attachmentCount} ${plural} ` +
    `you sent didn't come through and I don't have ${pronoun}. If it matters, let me know and I'll find another way.`
  )
}

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
export function intakeReplyContent(leadReference: string, attachmentCount = 0): EmailContent {
  return {
    subject: "Got it — thanks for reaching out — Heuron Technology",
    preheader: `Reference ${leadReference}`,
    body:
      `Thanks for reaching out — got it, and I'll follow up soon. There's nothing to sign into and ` +
      `nothing to check back on; if you want to follow up yourself, just quote ${leadReference} in ` +
      `your reply.${SIGNATURE}${attachmentDisclosure(attachmentCount)}`,
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
  attachmentCount = 0,
): DraftedIntakeReply {
  // `leadReference` is a `LEAD-XXXXXX` reference, never a `SUB-XXXXXX` one —
  // there is no submission behind a stranger's draft (`intakeReplyContent`'s
  // own doc) — so this writes no `thread_reference` at all (issue #196). A
  // stranger's own reply-to still degrades to the plain configured address,
  // exactly as it did before this fix; #196 only closes the gap for the
  // routed cases below, which are the ones a real `SUB-XXXXXX` reference
  // actually exists for.
  return acknowledgementStatement(
    env,
    inboundEmailId,
    toEmail,
    intakeReplyContent(leadReference, attachmentCount),
    guard,
    null,
  )
}

/**
 * The routed-thread acknowledgement — issue #165 (EM-5 of milestone #5).
 * Deterministic and rendered in the Worker, exactly like `intakeReplyContent`
 * and `emailContent`, but for the two outcomes EM-5 owns rather than EM-4's
 * stranger case:
 *
 *   - `ctaHref` non-`null` — the router (EM-3) resolved this sender's message
 *     to a specific submission (rungs 1-5, `routed_kind = 'message'`) and
 *     `postMessage` (`src/messages.ts`) has already appended it to that
 *     thread. The CTA lands on that submission's own Access-gated page —
 *     `/submissions/:id`-shaped, the same destination every one of
 *     `emailContent`'s three templates already uses — so the sender can read
 *     the thread themselves rather than take this acknowledgement's word for
 *     anything.
 *   - `ctaHref` `null` — rung 6's ambiguous case (`routed_kind = 'unrouted'`):
 *     a known-ish sender the router could not confidently place on one
 *     project, or a known client's address that failed DMARC. Nothing was
 *     appended anywhere and no lead exists either, so — same reasoning
 *     `intakeReplyContent`'s own doc gives for the stranger case, which has
 *     no Access seat to send to — there is no page behind Access to send this
 *     sender to yet. The sender should still hear back (issue #165's own
 *     words: "Draft a neutral acknowledgement anyway"), and an operator can
 *     route the row correctly before approving it.
 *
 * Neither branch discloses a submission status, a project name, or any other
 * pipeline-state fact, and neither ever quotes the sender's own message back
 * to them — the same restrictions `intakeReplyContent`'s own doc states, and
 * for the same reason: this function's only sender-controlled input is
 * `ctaHref`, and even that is portal-derived (a submission's own internal id,
 * never anything the sender wrote).
 */
export function routedReplyContent(ctaHref: string | null, attachmentCount = 0): EmailContent {
  return {
    subject: "Got it — thanks for your message — Heuron Technology",
    preheader: "Message received",
    body:
      `Thanks for getting in touch — I've received your message and will follow up soon.${SIGNATURE}` +
      attachmentDisclosure(attachmentCount),
    ctaText: ctaHref !== null ? "View your project" : "Back home",
    ctaHref: ctaHref ?? "/",
  }
}

/**
 * Drafts one `intake-reply` acknowledgement for EM-5's own two outcomes — see
 * `routedReplyContent` above for what distinguishes them. Same shape as
 * `intakeReplyStatement`: returned rather than executed, guarded on the
 * `inbound_emails` row it belongs to, and keyed on the same
 * `(submission_id = inboundEmailId, coord_revision = INTAKE_REPLY_REVISION)`
 * pair — an inbound email produces at most one draft regardless of which of
 * EM-3's outcomes it reached, so one idempotency key serves all of them.
 *
 * `submissionReference` (issue #196, EM-8's own follow-up) is the router's
 * `SUB-XXXXXX` reference for the matched thread — `RoutingTarget.submissionReference`
 * (`src/inboundRouter.ts`), the same value `inbound_emails.routed_submission_id`
 * records — separate from `ctaHref`, which carries the *internal* submission
 * id for the link, not the customer-facing reference a plus-address is built
 * from. `null` for the unrouted case, same as `ctaHref`: rung 6 never
 * confidently attached to a submission, so there is no reference to thread a
 * reply to either.
 */
export function routedReplyStatement(
  env: Env,
  inboundEmailId: string,
  toEmail: string,
  ctaHref: string | null,
  submissionReference: string | null,
  guard: CreateGuard,
  attachmentCount = 0,
): DraftedIntakeReply {
  return acknowledgementStatement(
    env,
    inboundEmailId,
    toEmail,
    routedReplyContent(ctaHref, attachmentCount),
    guard,
    submissionReference,
  )
}

/**
 * The one `INSERT` both `intakeReplyStatement` and `routedReplyStatement`
 * write — factored out so the column list, the guard placement and the
 * `ON CONFLICT` tail exist once, not twice in step-by-hand copies. See
 * `intakeReplyStatement`'s own doc for why the statement is returned rather
 * than executed, why `guard` is required (not optional, unlike
 * `messageCreationStatement`'s), and why `(submission_id, coord_revision)`
 * is this draft's idempotency key.
 *
 * `threadReference` (issue #196) writes `outbox.thread_reference`
 * (`migrations/0025_outbox_thread_reference.sql`) — the `SUB-XXXXXX`
 * reference, if any, `src/drain.ts`'s `resolveReplyTo` should plus-address a
 * reply to this row with, carried separately from `submission_id` because
 * this INSERT already repurposes that column for `inboundEmailId`
 * (`INTAKE_REPLY_REVISION`'s own doc). `null` for a draft with nothing real
 * to thread to (a stranger's lead, or rung 6's unrouted case) — the drain's
 * existing "absent beats broken" fallback handles that exactly as it always
 * has.
 */
function acknowledgementStatement(
  env: Env,
  inboundEmailId: string,
  toEmail: string,
  content: EmailContent,
  guard: CreateGuard,
  threadReference: string | null,
): DraftedIntakeReply {
  const id = generateOutboxId()
  const now = new Date().toISOString()

  const statement = env.DB.prepare(
    `INSERT INTO outbox
       (id, submission_id, email_type, to_email, from_email, subject, preheader, body, cta_text, cta_href, coord_revision, queued_at, approval_state, thread_reference)
     SELECT ?, ?, 'intake-reply', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?
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
    threadReference,
    ...guard.bindings,
  )

  return { id, statement }
}

// ── EM-6: THE APPROVAL GATE'S OWN READS AND WRITES (ISSUE #166) ──────────────

/**
 * One `pending` intake-reply draft, as `/replies` (`src/routes/replies.ts`)
 * reads it.
 *
 * Deliberately NOT `OutboxEmail` above. That interface is the *delivery*
 * view — status, attempts, provider id, `last_error` — which is what
 * `/outbox` and `/deliveries` are about and which a draft nobody has approved
 * yet has nothing interesting to say about (it is `queued`, zero attempts,
 * never claimed, by construction: `src/drain.ts`'s own WHERE clause has never
 * looked at it). What EM-6 needs instead is the *content* an operator is
 * about to proof-read, plus the `inbound_emails` row it answers — so this is
 * its own narrow shape rather than a widening of that one.
 */
export interface ReplyDraft {
  id: string
  /**
   * The `inbound_emails.id` this draft was written for. `outbox.submission_id`
   * carries it for an `intake-reply` row and never a real `submissions.id` —
   * see `INTAKE_REPLY_REVISION` above for why that column, and not a new one,
   * is where EM-4/EM-5 put it.
   */
  inboundEmailId: string
  to: string
  subject: string
  body: string
  ctaText: string
  ctaHref: string
  /** When the portal drafted it — the list's own "newest first" sort key. */
  queuedAt: string
}

interface ReplyDraftRow {
  id: string
  submission_id: string
  to_email: string
  subject: string
  body: string
  cta_text: string
  cta_href: string
  queued_at: string
}

function toReplyDraft(row: ReplyDraftRow): ReplyDraft {
  return {
    id: row.id,
    inboundEmailId: row.submission_id,
    to: row.to_email,
    subject: row.subject,
    body: row.body,
    ctaText: row.cta_text,
    ctaHref: row.cta_href,
    queuedAt: row.queued_at,
  }
}

/**
 * The one predicate every read and every write in this section shares:
 * `email_type = 'intake-reply' AND approval_state = 'pending'`.
 *
 * Both halves matter. `approval_state = 'pending'` is what makes `/replies` a
 * queue rather than an archive (contract § Notes item 2: "the list is
 * pending-only and a row simply disappears once acted on"), and it is the same
 * predicate every write guards on, so a row an operator already approved,
 * discarded — or that a second browser tab already acted on — is invisible
 * here and unwritable there for one reason rather than two. `email_type` is
 * belt to that suspenders: nothing else in this repo writes a `pending` row
 * today, and if some future notification type ever did, it would not
 * automatically become something this screen renders (it has no
 * `inbound_emails` row behind it, so it could not render at all).
 */
const PENDING_REPLY_PREDICATE = `email_type = 'intake-reply' AND approval_state = 'pending'`

const REPLY_DRAFT_COLUMNS = `SELECT id, submission_id, to_email, subject, body, cta_text, cta_href, queued_at
    FROM outbox`

/**
 * Every drafted reply still waiting on a human, newest first — the read behind
 * `GET /replies`.
 *
 * Unscoped by recipient, exactly like `listAllOutbox` above and for the same
 * reason: the one caller allowed to see across every customer's rows is an
 * operator-gated screen (`readOperator`, `src/operators.ts`), never a
 * customer-facing one. A second function rather than a flag on
 * `listAllOutbox`, for the reason `src/routes/deliveries.ts`'s module comment
 * gives at length about that exact pair.
 */
export async function listPendingReplyDrafts(env: Env): Promise<ReplyDraft[]> {
  const { results } = await env.DB.prepare(
    `${REPLY_DRAFT_COLUMNS} WHERE ${PENDING_REPLY_PREDICATE} ORDER BY queued_at DESC, id DESC`,
  ).all<ReplyDraftRow>()
  return (results ?? []).map(toReplyDraft)
}

/**
 * One drafted reply, by its own `outbox.id` — `null` for an id that names
 * nothing, or a row that is no longer `pending`. The caller answers both with
 * the same `leadsNotFound()` 404 every other refusal on the operator surface
 * gets: "already approved" is not a distinct error an operator's second tab
 * needs told apart from "never existed".
 */
export async function getPendingReplyDraft(env: Env, id: string): Promise<ReplyDraft | null> {
  const row = await env.DB.prepare(`${REPLY_DRAFT_COLUMNS} WHERE id = ? AND ${PENDING_REPLY_PREDICATE}`)
    .bind(id)
    .first<ReplyDraftRow>()
  return row === null ? null : toReplyDraft(row)
}

/**
 * "Every write is guarded `WHERE id = ? AND approval_state = 'pending'`, so a
 * double-click converges instead of double-sending" — issue #166's own rule,
 * which the Gate-A contract confirms applies to all four of EM-6's actions,
 * not only the two that touch `outbox` directly.
 *
 * `approve` and `discard` below carry that predicate in their own `UPDATE`'s
 * `WHERE`. The other two (`/route`'s re-target, and the `leads` row a
 * re-target to "a lead" mints) write *other tables*, so they carry it as this
 * `EXISTS` sub-select instead, evaluated inside the same `DB.batch()` — the
 * same shape `insertedRowGuard` (`src/inboundEmail.ts`) uses to make a row's
 * existence, not a caller's belief about it, the thing a sibling write
 * depends on.
 *
 * `keyword` picks whether the fragment opens a `WHERE` (an `INSERT … SELECT`,
 * e.g. `leadCreationStatement`) or extends one (an `UPDATE` that already
 * matches on its own id).
 */
export function pendingDraftGuard(draftId: string, keyword: "WHERE" | "AND" = "WHERE"): CreateGuard {
  return {
    clause: `${keyword} EXISTS (SELECT 1 FROM outbox WHERE id = ? AND ${PENDING_REPLY_PREDICATE})`,
    bindings: [draftId],
  }
}

/**
 * **Approve & send** — issue #166's own table, row 1: "writes the edited
 * subject/body, `approval_state = 'approved'`, stamps `approved_at`/
 * `approved_by`, clears `claimed_at`. The next cron tick (≤5 min) carries it."
 *
 * The edited subject and body are written in the *same* statement that flips
 * the gate, not before it. That ordering is the whole acceptance case
 * ("approving sends the edited text, not the original"): a two-step
 * write — content first, gate second — has a window in which a drain tick
 * between them sends the original, and a second click that lost the guard
 * would still have overwritten the content of a row someone else already
 * approved.
 *
 * `claimed_at = NULL` is defensive rather than load-bearing: a `pending` row
 * can never have been claimed, because `src/drain.ts`'s batch SELECT *and*
 * its claim UPDATE both exclude every `approval_state` outside
 * `('not_required', 'approved')`. Clearing it anyway costs nothing and means
 * this row enters the drain's world in exactly the state a freshly enqueued
 * one does.
 *
 * Returns whether this call is the one that moved the row. A caller that
 * loses (a double-click, a replayed POST, a row a second tab already
 * discarded) gets `false` and must still answer normally — a guarded no-op is
 * this codebase's convention, not an error (`src/drain.ts`, `promoteLead`).
 */
export async function approveReplyDraft(
  env: Env,
  id: string,
  subject: string,
  body: string,
  approvedBy: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE outbox
        SET subject = ?, body = ?, approval_state = 'approved',
            approved_at = ?, approved_by = ?, claimed_at = NULL
      WHERE id = ? AND ${PENDING_REPLY_PREDICATE}`,
  )
    .bind(subject, body, new Date().toISOString(), approvedBy, id)
    .run()
  return (result.meta.changes ?? 0) === 1
}

/**
 * **Discard** — issue #166's own table, row 2: "`approval_state = 'rejected'`.
 * Terminal, never sends."
 *
 * Terminal is enforced by the drain, not here: `rejected` matches neither of
 * the two states `src/drain.ts` sends from, and unlike `failed` it is never a
 * retry candidate because it never matches that WHERE clause in the first
 * place (`migrations/0021_outbox_approval.sql`'s own vocabulary note, and the
 * Gate-A contract's "a `rejected` row must never transition to `status =
 * 'failed'`").
 *
 * `approved_at`/`approved_by` are stamped on a rejection too — 0021's own
 * words: "who signed off and when, set together the moment a `pending` row
 * moves to `approved` **or** `rejected`". Deciding not to send is a decision a
 * person made, and a discarded draft with no record of who discarded it is
 * exactly the audit hole that column pair exists to close.
 */
export async function discardReplyDraft(env: Env, id: string, decidedBy: string): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE outbox
        SET approval_state = 'rejected', approved_at = ?, approved_by = ?, claimed_at = NULL
      WHERE id = ? AND ${PENDING_REPLY_PREDICATE}`,
  )
    .bind(new Date().toISOString(), decidedBy, id)
    .run()
  return (result.meta.changes ?? 0) === 1
}

/**
 * **Change route**'s half of the write — issue #166's own table, row 3:
 * "re-render the draft from the template, stay `pending`."
 *
 * Every content column an acknowledgement template produces is rewritten
 * (`intakeReplyContent` / `routedReplyContent` above), because a re-target
 * changes which of the two templates applies and what its call to action
 * resolves to — a re-route that moved `cta_href` but left yesterday's
 * `preheader` behind would send a message that half agrees with itself.
 * `approval_state` is deliberately absent from the SET list: the row stays
 * `pending`, per the issue's own words, so the operator still has to approve
 * what they just re-routed.
 *
 * Returned rather than executed, so the caller can put it in the same
 * `DB.batch()` as the `inbound_emails` re-target (and, for the "become a
 * lead" branch, the `leads` row) it belongs with — the same reason
 * `intakeReplyStatement` above is returned rather than executed. Guarded on
 * the same `pending` predicate every other write here is.
 *
 * `threadReference` (issue #196) rewrites `thread_reference` right alongside
 * every other content column, for the same reason `cta_href` is rewritten
 * here rather than left alone: a re-route that moved the call-to-action but
 * left yesterday's Reply-To token behind would let a customer's reply thread
 * onto the *wrong* submission, or (re-routed to "lead") onto one that no
 * longer applies at all. `src/routes/replies.ts` passes the newly-picked
 * submission's own reference for a re-route to a project, and `null` for a
 * re-route to "lead" — mirroring exactly what `routedReplyStatement` /
 * `intakeReplyStatement` would have written had the draft been created fresh
 * with this same outcome.
 */
export function redraftReplyStatement(
  env: Env,
  id: string,
  content: EmailContent,
  threadReference: string | null,
): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE outbox
        SET subject = ?, preheader = ?, body = ?, cta_text = ?, cta_href = ?, thread_reference = ?
      WHERE id = ? AND ${PENDING_REPLY_PREDICATE}`,
  ).bind(
    content.subject,
    content.preheader,
    content.body,
    content.ctaText,
    content.ctaHref,
    threadReference,
    id,
  )
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
