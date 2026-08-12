import { generateOutboxId } from "./ids"
import { getCurrentRound } from "./rounds"
import { titleOf, type Submission } from "./submissions"
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

/** Contract § `data-testid` hooks, Emails (11-13): the pinned `data-email-type`s. */
export const SENDING_TYPES = ["signoff-ready", "needs-input", "shipped"] as const

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
 */
const DEFAULT_EMAIL_FROM = "coord-portal <notify@mail.heurontech.com>"

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
 * The copy for each of the three sending states — illustrative, not pinned:
 * the Gate-A contract pins the email's `data-testid` hooks (§ Emails 11-13)
 * but, per its own note on `verdict-pill`-style copy elsewhere, not the exact
 * subject or call-to-action wording. What *is* load-bearing is the call to
 * action's destination (every type routes back to this submission — issue
 * #14's whole premise, "the async loop only works if 'come back later'
 * actually reaches the customer") and that no engineer-side identifier ever
 * rides in the body: `title` comes from `titleOf`, the customer's own words
 * from the intake form, never coord-authored text.
 */
export async function emailContent(env: Env, submission: Submission, type: SendType): Promise<EmailContent> {
  const title = titleOf(submission)
  const ctaHref = `/submissions/${submission.id}`

  if (type === "signoff-ready") {
    const round = await getCurrentRound(env, submission.reference)
    return {
      subject: "Your design is ready for sign-off",
      preheader: round ? `${title} — Round ${round.round}` : title,
      body: `We've put together a design for "${title}." Take a look and either approve it or tell us what to change.`,
      ctaText: "Review the design",
      ctaHref,
    }
  }

  if (type === "needs-input") {
    return {
      subject: "We have a question for you",
      preheader: title,
      body: `Work on "${title}" is paused until you answer one question.`,
      ctaText: "Answer the question",
      ctaHref,
    }
  }

  return {
    subject: "Your work has shipped",
    preheader: title,
    body: `"${title}" is live.`,
    ctaText: "View the result",
    ctaHref,
  }
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
