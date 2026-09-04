import { generateOperatorReadId } from "./ids"
import type { Env } from "./types"

/**
 * The audit trail for an operator reading a customer's own design-round
 * material — issue #304's "an operator reading customer material should be
 * recorded... it should leave a trace rather than being silent."
 *
 * Before this issue, every operator surface (`/leads`, `/deliveries`,
 * `/requests`) read facts the portal itself already hands an operator by
 * design. This is the first one where an operator reads something authored
 * *for the customer, by the customer* — the round history's verdict and
 * comment, and the exact published bundle the customer was shown — which is
 * why it is the first thing in this portal that leaves a trace of having been
 * read, rather than just of having been written.
 *
 * See `migrations/0026_operator_reads.sql` for why this is its own table
 * rather than `bridge_events` (records what the coordinator pushed, keyed by
 * a `coord_revision` this write has none of), `lifecycle_events` (same
 * shape, same reason), or `messages` (a message is rendered back to both
 * parties; a read has no author-facing rendering at all — nobody ever reads
 * this table back on screen).
 *
 * Called from exactly two places, both already gated by `readOperator` before
 * this ever runs — this function does not check who is asking, only records
 * that someone did:
 *
 *   `routes/requests.ts`'s `requestRounds`   — `round: null`, a read of the
 *                                              whole round history.
 *   `routes/mocks.ts`'s `operatorMockBundle` — `round` set, a read of one
 *                                              round's published bundle.
 *
 * Never called from the customer's own `isOwnedBy`-gated routes
 * (`routes/submission.ts`'s `submissionRounds`, `routes/mocks.ts`'s
 * `mockBundle`) — an owner reading their own submission is not the event this
 * table exists to record.
 *
 * Awaited by both callers, on the same D1 binding the rest of the route
 * already depends on: a failure here is not a distinct failure mode this
 * route needs to degrade gracefully from — if `env.DB` cannot take a write,
 * the surrounding read has already failed on the same binding, and this
 * surfaces through the router's ordinary 500 handling exactly like any other
 * unexpected D1 error would.
 */
export async function recordOperatorRead(
  env: Env,
  operatorEmail: string,
  submissionReference: string,
  round: number | null,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO operator_reads (id, operator_email, submission_id, round, occurred_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(generateOperatorReadId(), operatorEmail, submissionReference, round, new Date().toISOString())
    .run()
}
