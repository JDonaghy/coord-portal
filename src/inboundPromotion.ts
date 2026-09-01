import { getClientRecordByEmail } from "./clients"
import { getInboundEmailByOutboxId, type InboundEmailRecord } from "./inboundEmail"
import { generateSubmissionId, generateSubmissionReference } from "./ids"
import { createSubmissionStatements, type CreateGuard } from "./submissions"
import type { Env } from "./types"

/**
 * The escape hatch — issue #167 (EM-7 of milestone #5, epic #160). "An inbound
 * email that is really a new ask becomes a submission, from `/replies`, in
 * one click."
 *
 * EM-5 (`src/inboundEmail.ts`) deliberately lands every matched email as a
 * thread message, because the router cannot tell "thanks, looks great" from
 * "and now can you also…". This is the operator resolving that, with the
 * context in front of them on `/replies/:id` (`src/routes/replies.ts`).
 *
 * ── WHY THIS GOES THROUGH `createSubmissionStatements`, LIKE `promoteLead` ──
 * The same function `POST /intake` and `promoteLead()` (`src/leads.ts`) both
 * use, so the `submission.created` event this produces is byte-identical in
 * shape to one an intake form produces. The daemon never learns an email was
 * involved (CLAUDE.md's outbound-only-bridge rule has nothing to do with
 * this — this is the *other* rule, "never write a field this side does not
 * own" turned into "never let the daemon see the channel a fact arrived on").
 *
 * `audience`/`done_definition` — the two fields `/intake` collects that an
 * inbound email does not — follow `promoteLead`'s own precedent exactly: a
 * plain statement that they were not captured, never a guess. See
 * `NOT_CAPTURED_OVER_EMAIL` below.
 *
 * ── IDEMPOTENCY, THE SAME SHAPE AS `promoteLead` ────────────────────────────
 * Every statement this function can produce — the submission insert and its
 * `submission.created` event — goes into one `DB.batch()` (D1 runs it as a
 * single transaction), and every one of them is guarded on the same
 * predicate: *this inbound email has not been promoted, and its drafted reply
 * is still `pending`* (`guard` below). A double-click, a retry, or two
 * concurrent promotes all match zero rows on the losing side — nothing
 * errors, nothing duplicates — and the caller reads back exactly what the
 * first promote produced, via `getInboundEmailByOutboxId` (`inbound.outboxId`
 * is stable across the whole exchange), rather than assuming it won the race.
 *
 * ── THE SECOND HALF OF THE GUARD: WHY IT ALSO CHECKS `outbox` ───────────────
 * `src/routes/replies.ts`'s own module comment states the rule for all four
 * of EM-6/EM-7's actions on this screen: "every write is guarded `WHERE id = ?
 * AND approval_state = 'pending'`". `/promote` is the fourth. A row whose
 * drafted acknowledgement an operator already discarded is a row an operator
 * has already decided needs no further action from this screen — promoting it
 * afterward would let two clicks on two different buttons disagree about
 * whether this message still matters. The `EXISTS` sub-select is what makes
 * that true without a second column: the same trick `insertedRowGuard`
 * (`src/inboundEmail.ts`) and `pendingDraftGuard` (`src/notifications.ts`)
 * already use to make a *sibling row's* state, not a caller's belief about
 * it, the thing a guarded write depends on.
 *
 * Promoting does NOT itself touch the `outbox` row — approving/sending the
 * drafted acknowledgement and promoting to a submission are two independent
 * operator acts on the same message, and nothing in issue #167's own text
 * asks for one to consume the other. An operator can still approve or discard
 * that draft, in either order, after promoting.
 *
 * ── WHAT THIS DOES NOT TOUCH ─────────────────────────────────────────────────
 * The `messages` row EM-5 already wrote for this inbound email (when routed
 * as `"message"`) is untouched — "the thread message EM-5 already wrote stays
 * ... promotion adds a submission, it does not rewrite history" (issue #167).
 * This function never reads or writes `messages` at all.
 */

/**
 * Fields `/intake` collects that an inbound email does not. Worded for this
 * channel specifically (mirrors `NOT_CAPTURED_AT_FIRST_CONTACT` in
 * `src/leads.ts`, which is worded for a lead's own `/start` origin) — an
 * invented "audience" would be indistinguishable, downstream, from one the
 * customer actually gave, and the fleet would plan against something nobody
 * said.
 */
const NOT_CAPTURED_OVER_EMAIL =
  "Not captured at first contact — this came in as an email reply, so it still needs to be agreed with the customer."

/**
 * Promotes one inbound email to a submission, owned by its sender, attached
 * to whatever the router (or an operator's own "Change route") last matched
 * it to. Idempotent — see this module's own doc comment.
 *
 * A no-op, returning `inbound` unchanged, for every row this action does not
 * apply to:
 *
 *   - already promoted (`promotedAt !== null`) — the ordinary idempotent path,
 *     not an error;
 *   - `routedKind === "lead"` — a stranger's own promotion path is
 *     `/leads/:id/promote` (issue #33), unchanged by this issue; two buttons
 *     for one act would leave no way to tell which is authoritative;
 *   - `routedKind === null` — a suppressed or rate-limited message was never
 *     routed and never drafted a reply, so there is no `outbox` row for the
 *     guard below to check and nothing on `/replies` to promote from;
 *   - `outboxId === null` — defensive only: every routed row gets a drafted
 *     acknowledgement (EM-4/EM-5), so this should be unreachable in practice.
 *
 * `routedProjectId` is passed straight through, `null` included — a
 * `"message"` decision with no project (a one-off request, EM-3's rungs 1/2)
 * or an `"unrouted"` decision (rung 6's tie, or a known address that failed
 * DMARC) both promote into a plain, project-less submission, the same shape
 * an ordinary first-time `/intake` submission already has. Ownership by the
 * sender's *address* is exactly as verified — or not — as `/intake`'s own
 * `customerEmail` field already is; this issue does not raise that bar.
 */
export async function promoteInboundEmail(
  env: Env,
  inbound: InboundEmailRecord,
): Promise<InboundEmailRecord> {
  if (inbound.promotedAt !== null) return inbound
  if (inbound.routedKind === null || inbound.routedKind === "lead") return inbound
  if (inbound.outboxId === null) return inbound

  const promotedAt = new Date().toISOString()
  const outboxId = inbound.outboxId
  const guard: CreateGuard = {
    clause: `FROM inbound_emails
      WHERE inbound_emails.id = ? AND inbound_emails.promoted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM outbox
           WHERE id = ? AND email_type = 'intake-reply' AND approval_state = 'pending'
        )`,
    bindings: [inbound.id, outboxId],
  }

  // A plain lookup of a row that already existed before this transaction
  // started — the same posture `createSubmission`'s own ordinary path takes
  // (`src/submissions.ts`), and safe for the identical reason: nothing here
  // is minting a client row that could still lose a race, so there is no
  // candidate id to resolve live the way `promoteLead`'s no-match branch
  // must.
  const client = await getClientRecordByEmail(env, inbound.fromEmail)

  const { submission, statements } = createSubmissionStatements(
    env,
    {
      customerEmail: inbound.fromEmail,
      outcome: inbound.bodyText,
      audience: NOT_CAPTURED_OVER_EMAIL,
      doneDefinition: NOT_CAPTURED_OVER_EMAIL,
      constraints: null,
      projectScope: null,
    },
    {
      id: generateSubmissionId(),
      reference: generateSubmissionReference(),
      guard,
      projectId: inbound.routedProjectId,
      clientId: client?.id ?? null,
    },
  )

  await env.DB.batch([
    ...statements,
    env.DB.prepare(
      `UPDATE inbound_emails
          SET promoted_at = ?, promoted_submission_id = ?, promoted_submission_reference = ?
        WHERE id = ? AND promoted_at IS NULL`,
    ).bind(promotedAt, submission.id, submission.reference, inbound.id),
  ])

  // Read back rather than assuming we won the race: on the losing side of a
  // double-click or a concurrent promote every statement above matched
  // nothing, and the row already names the submission the other request
  // created.
  return (await getInboundEmailByOutboxId(env, outboxId)) ?? inbound
}
