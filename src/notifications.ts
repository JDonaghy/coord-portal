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
 * This module decides WHAT to send and records it; `migrations/0007_notifications.sql`
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
 * The sending address every email carries. Matches the three pinned mocks
 * (`mocks/11-13-email-*.html`) — the contract pins `email-from` as a hook, not
 * this literal string (a test may only assert "looks like an address"), so
 * this is free to move to an env-configured value later without breaking
 * anything sealed.
 */
const EMAIL_FROM = "coord-portal <notify@intake.heurontech.com>"

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
  sentAt: string
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
  sent_at: string
}

function fromRow(row: OutboxRow): OutboxEmail {
  return {
    id: row.id,
    submissionId: row.submission_id,
    // A row can only ever have been written by `recordNotificationForStatus`
    // below, which validates against `SENDING_TYPES` before it writes — this
    // fallback exists only so a hand-edited row cannot crash the outbox page.
    type: isSendType(row.email_type) ? row.email_type : "shipped",
    to: row.to_email,
    from: row.from_email,
    subject: row.subject,
    preheader: row.preheader,
    body: row.body,
    ctaText: row.cta_text,
    ctaHref: row.cta_href,
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
 * Called from `src/bridge/updates.ts` once per applied push that sets
 * `status`, after the same push's own writes (the status column, and — for
 * `awaiting-signoff` — the design round it just published) have already
 * landed, so the content below can read what was just written rather than
 * racing it.
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

  await env.DB.prepare(
    `INSERT INTO outbox
       (id, submission_id, email_type, to_email, from_email, subject, preheader, body, cta_text, cta_href, coord_revision, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (submission_id, coord_revision) DO NOTHING`,
  )
    .bind(
      generateOutboxId(),
      submission.reference,
      type,
      submission.customerEmail,
      EMAIL_FROM,
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

interface EmailContent {
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
async function emailContent(env: Env, submission: Submission, type: SendType): Promise<EmailContent> {
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
    `SELECT * FROM outbox WHERE to_email = ? ORDER BY sent_at ASC, id ASC`,
  )
    .bind(email)
    .all<OutboxRow>()
  return (results ?? []).map(fromRow)
}
