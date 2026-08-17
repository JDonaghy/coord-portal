import { generateMessageId } from "./ids"
import type { Env } from "./types"

/**
 * The async chat thread — issue #110's "customers can only answer one
 * question or leave one signoff comment" gap.
 *
 * Portal-owned, submission-scoped (see `migrations/0013_messages.sql` for why
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
 * `messages.author_role` (`migrations/0013_messages.sql`) backstops that
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
  const id = generateMessageId()
  const createdAt = new Date().toISOString()

  await env.DB.prepare(
    `INSERT INTO messages (id, submission_id, author_role, author_email, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, submissionReference, authorRole, authorEmail, body, createdAt)
    .run()

  return { id, submissionId: submissionReference, authorRole, authorEmail, body, createdAt }
}
