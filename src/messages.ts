import { generateMessageId } from "./ids"
import type { CreateGuard } from "./submissions"
import type { Env } from "./types"

/**
 * The async chat thread — issue #110's "customers can only answer one
 * question or leave one signoff comment" gap.
 *
 * Portal-owned, submission-scoped (see `migrations/0014_messages.sql` for why
 * submission-scoped rather than project-scoped, and why there is deliberately
 * no paired `bridge_events` row the way `question_answers` and `signoffs`
 * both get one).
 *
 * ── PURELY INFORMATIONAL ─────────────────────────────────────────────────
 * A message never moves `submissions.status` and never touches a design
 * round or a signoff — issue #110's own non-goal: "not a second way to
 * approve or reject." Posting one on an `awaiting-signoff` submission changes
 * nothing about that round; the customer still approves or requests changes
 * through the existing structured composer (`src/rounds.ts`). This module has
 * no write path to either.
 *
 * ── NO IDEMPOTENCY KEY, UNLIKE recordAnswer / recordSignoff ────────────────
 * `src/questions.ts`'s `recordAnswer` and `src/rounds.ts`'s `recordSignoff`
 * are each idempotent against a doubled form submit because they are keyed to
 * something with a natural "already happened" test — one answer per question
 * revision, one verdict per round. A chat message has no such key: sending a
 * second, third or tenth message from the same screen is the normal case, not
 * a retry to guard against. A double-click before the first request's 303
 * lands can still produce two identical rows, the same accepted risk every
 * other repeatable "submit" action in this portal already carries (there is
 * no dedupe on two genuinely separate lead submissions either) — not a defect
 * particular to this feature.
 */

export type MessageAuthorRole = "customer" | "operator"

export interface Message {
  id: string
  /** The customer-visible `SUB-XXXXXX` reference this message belongs to. */
  submissionId: string
  authorRole: MessageAuthorRole
  authorEmail: string
  body: string
  createdAt: string
}

interface MessageRow {
  id: string
  submission_id: string
  author_role: string
  author_email: string
  body: string
  created_at: string
}

function isAuthorRole(value: string): value is MessageAuthorRole {
  return value === "customer" || value === "operator"
}

/**
 * A row can only ever have been written by `postMessage` below, which never
 * writes anything but `'customer'` or `'operator'` — the `CHECK` constraint on
 * `messages.author_role` (`migrations/0014_messages.sql`) backstops that
 * further. `null` here means a row this code has no business ever seeing (a
 * hand edit, a future migration widening the column); skipping it from the
 * read-back is safer than guessing at a role it was never actually posted
 * with — the same defensive shape `src/notifications.ts`'s `fromRow` uses for
 * `outbox`.
 */
function fromRow(row: MessageRow): Message | null {
  if (!isAuthorRole(row.author_role)) return null
  return {
    id: row.id,
    submissionId: row.submission_id,
    authorRole: row.author_role,
    authorEmail: row.author_email,
    body: row.body,
    createdAt: row.created_at,
  }
}

/** Every message on one submission's thread, oldest first. */
export async function listMessages(env: Env, submissionReference: string): Promise<Message[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM messages WHERE submission_id = ? ORDER BY created_at ASC, id ASC`,
  )
    .bind(submissionReference)
    .all<MessageRow>()
  return (results ?? [])
    .map(fromRow)
    .filter((message): message is Message => message !== null)
}

export interface NewMessageInput {
  submissionId: string
  authorRole: MessageAuthorRole
  authorEmail: string
  body: string
}

/**
 * Mint one message's identity — id and `created_at` — without writing it.
 *
 * Split out of `postMessage` for issue #165 (EM-5 of milestone #5), whose
 * caller (`src/inboundEmail.ts`) must know the `messages.id` *before* the
 * write so the same guarded `DB.batch()` that inserts the `inbound_emails`
 * row can carry this message's own insert alongside it — the identical shape
 * `mintLead` (`src/leads.ts`) already established for EM-4's lead. Every
 * other caller of `postMessage` keeps calling that function unchanged; this
 * split adds a second, lower-level pair of exports rather than touching the
 * ordinary "just do it" behaviour every existing route relies on.
 */
export function mintMessage(input: NewMessageInput): Message {
  return {
    id: generateMessageId(),
    submissionId: input.submissionId,
    authorRole: input.authorRole,
    authorEmail: input.authorEmail,
    body: input.body,
    createdAt: new Date().toISOString(),
  }
}

/**
 * The one `INSERT` every message in this app is written by — returned rather
 * than executed, so a caller that must write a message *atomically alongside
 * other rows* can put it in its own `DB.batch()`. `postMessage` below is the
 * ordinary wrapper every existing route uses.
 *
 * ── A SECOND CALLER (ISSUE #165, EM-5 OF MILESTONE #5) ──────────────────────
 * `src/inboundEmail.ts` mints a message for a known sender's inbound email
 * (rungs 1-5 of EM-3's router: a `"message"` decision) and must not let it
 * land unless the `inbound_emails` row it belongs to actually landed in the
 * same batch — the identical "no window where one row exists without the
 * other" argument EM-4 already makes for `leadCreationStatement`. `guard` is
 * optional because `postMessage`'s own ordinary callers
 * (`src/routes/submission.ts`, `src/routes/leads.ts`) have nothing to guard
 * against: a customer or operator posting to an existing thread needs no
 * "did some other row land first" check.
 */
export function messageCreationStatement(
  env: Env,
  message: Message,
  guard?: CreateGuard,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO messages (id, submission_id, author_role, author_email, body, created_at)
     SELECT ?, ?, ?, ?, ?, ?
     ${guard ? guard.clause : ""}`,
  ).bind(
    message.id,
    message.submissionId,
    message.authorRole,
    message.authorEmail,
    message.body,
    message.createdAt,
    ...(guard ? guard.bindings : []),
  )
}

/**
 * Appends one message. `authorEmail` is whatever `resolveSiteIdentity` (for a
 * customer) or `readOperator` (for an operator) resolved for the caller —
 * never taken from the form, same reasoning `src/routes/submission.ts`
 * already applies to every other write on this route.
 */
export async function postMessage(
  env: Env,
  submissionReference: string,
  authorRole: MessageAuthorRole,
  authorEmail: string,
  body: string,
): Promise<Message> {
  const message = mintMessage({ submissionId: submissionReference, authorRole, authorEmail, body })
  await messageCreationStatement(env, message).run()
  return message
}
