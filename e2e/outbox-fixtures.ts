import { runWrangler } from "./wrangler-cli"

/**
 * Issue #49's own "Out of scope": "Actually calling a provider (#B/#C). This
 * issue only makes the state representable and visible." So nothing reachable
 * through the running app's HTTP surface can ever move an `outbox` row past
 * `queued` — that is #50's cron drain and #51's provider seam, neither of
 * which exists yet. `e2e/notifications.spec.ts` still needs to drive
 * `src/routes/outbox.ts`'s `sent`/`failed` rendering — the actual pinned DOM,
 * the pluralization branch and the customer-safe copy substitution — through
 * the real route, not a fake `DB` (that is `test/notifications.test.ts`'s
 * job, and it stops at `fromRow`/`listOutboxForCustomer`).
 *
 * Same move `e2e/r2-fixtures.ts` makes for R2, for the same reason: there is
 * no HTTP route on this side to seed a delivery outcome through (that route
 * does not exist until #50 and #51 land), so this shells out to the same CLI
 * `wrangler dev` (`serve:test`) itself uses, against the same `--local`
 * persisted state both processes already agree on without either side naming
 * it — see r2-fixtures.ts's own note on that, verified the same way here.
 *
 * Sharing that state with a live `wrangler dev` means sharing its SQLite write
 * lock; `wrangler-cli.ts` owns the retry that makes a contended lock a wait
 * rather than a failed test.
 */
const DATABASE = "coord-portal"

function execute(command: string): string {
  return runWrangler(["d1", "execute", DATABASE, "--local", "--json", "--command", command])
}

/**
 * ── WHY NO FIXTURE HERE EVER CHECKS `meta.changes` ─────────────────────────
 *
 * The obvious way to prove a seeding `UPDATE` actually touched the row it
 * named is SQLite's `changes()` — and D1 does report it as `meta.changes` on
 * a `.run()` inside a Worker (`src/drain.ts` leans on exactly that for the
 * claim). It is NOT available through this CLI seam: `wrangler d1 execute`'s
 * local path (`executeLocally`, wrangler-dist/cli.js) rebuilds the per-
 * statement result as
 *
 *     { results, success, meta: { duration: result.meta?.duration } }
 *
 * — the whole of `meta` except `duration` is discarded before the `--json`
 * output is printed, so `meta.changes` is `undefined` for every local
 * statement, read or write. Verified empirically at the repo-pinned wrangler
 * 4.120.0 and at 4.127.1 (latest, 2026-08-31): an `INSERT` that demonstrably
 * added a row still printed `"meta": { "duration": 1 }` and nothing else. It
 * is not a version we can bump past, and nothing in `src/` or `migrations/`
 * can put the field back — it is dropped CLI-side, after SQLite has answered.
 *
 * So a fixture that wants "the write landed" has to READ IT BACK, which is
 * what `setOutboxApproval` does below. A read-after-write over the same
 * `--local` state is strictly stronger anyway: `changes = 1` says one row
 * matched the WHERE, while the read says the column now holds the value the
 * test asked for.
 */

/** Inline a value into a `--command` string. Synthetic test data only — see CLAUDE.md rule 1. */
function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * The id of the most recently queued outbox row for one recipient — read back
 * so a fixture targets the exact row the app itself just inserted (minted by
 * `generateOutboxId`) rather than this file guessing or minting its own.
 */
export function latestOutboxId(toEmail: string): string {
  const output = execute(
    `SELECT id FROM outbox WHERE to_email = ${sqlString(toEmail)} ORDER BY queued_at DESC, id DESC LIMIT 1`,
  )
  const [{ results }] = JSON.parse(output) as [{ results: Array<{ id: string }> }]
  const row = results[0]
  if (!row) throw new Error(`no outbox row for ${toEmail} — seed one through the app first`)
  return row.id
}

/**
 * Drives one row to `sent` — the only way this repo can reach that state
 * before #50's drain exists. Mirrors what the drain itself will eventually
 * write on success (`migrations/0010_outbox_delivery_state.sql`: "`sent_at`...
 * only #50's drain ever populates, only when `status` becomes `sent`").
 */
export function markOutboxSent(id: string, sentAt: string, providerMessageId: string): void {
  execute(
    `UPDATE outbox SET status = 'sent', sent_at = ${sqlString(sentAt)}, provider_message_id = ${sqlString(providerMessageId)} WHERE id = ${sqlString(id)}`,
  )
}

/**
 * Drives one row to `failed` with the given attempt count and raw
 * operator-side error string — the exact value `src/routes/outbox.ts` must
 * never render verbatim to a customer (contract § "Customer-safe error
 * copy").
 */
export function markOutboxFailed(id: string, attempts: number, lastError: string): void {
  execute(
    `UPDATE outbox SET status = 'failed', attempts = ${attempts}, last_error = ${sqlString(lastError)} WHERE id = ${sqlString(id)}`,
  )
}

/** The four values `migrations/0021_outbox_approval.sql`'s CHECK admits (issue #162). */
export type ApprovalState = "not_required" | "pending" | "approved" | "rejected"

/**
 * Puts one row into an approval state — issue #162's own seeding seam, and
 * for exactly the reason the rest of this file exists: nothing reachable
 * through the running app's HTTP surface ever writes `outbox.approval_state`
 * yet. #162 is deliberately "no UI, no new sends, no new callers" — it only
 * makes "this reply is waiting for a human" representable and unsendable, so
 * the approve/reject action that will one day set this column is a later
 * milestone's. Until it exists, the only honest way to drive the drain's new
 * clause from a black-box test is to write the column the way that future
 * action will, then let the real `GET /__scheduled` decide.
 *
 * `approved_at`/`approved_by` travel with `approved` and `rejected` because
 * the migration's own note pins them as "set together the moment a `pending`
 * row moves to `approved` or `rejected`" — a fixture that left them null
 * would be seeding a state the product will never actually produce.
 */
export function setOutboxApproval(id: string, state: ApprovalState, approvedBy?: string): void {
  const decided = state === "approved" || state === "rejected"
  const bookkeeping = decided
    ? `, approved_at = ${sqlString(new Date().toISOString())}, approved_by = ${sqlString(approvedBy ?? "operator@example.test")}`
    : ", approved_at = NULL, approved_by = NULL"
  execute(
    `UPDATE outbox SET approval_state = ${sqlString(state)}${bookkeeping} WHERE id = ${sqlString(id)}`,
  )

  // Read back rather than trust the UPDATE — see the `meta.changes` note at
  // the top of this file for why the row count is not available here. A
  // silently-zero-row UPDATE (a typo'd id, a row a sibling test already
  // moved) would otherwise surface as "the drain refused to send an approved
  // row", blaming `src/drain.ts` for a fixture that never approved anything.
  const after = readOutboxRowState(id)
  if (after.approval_state !== state) {
    throw new Error(
      `approving ${id} did not take: approval_state is ${after.approval_state}, expected ${state} ` +
        `— the UPDATE matched no row, so nothing below is testing what it claims to test`,
    )
  }
}

/**
 * Inserts one outbox row that is ALREADY in its approval state — the gate and
 * the row land in the same statement.
 *
 * The obvious alternative (enqueue through the app, then `setOutboxApproval`)
 * has a window between those two calls in which the row is an ordinary
 * `queued`/`not_required` row, and `GET /__scheduled` drains the WHOLE table.
 * `e2e/drain.spec.ts` is serial *within a project*, but `playwright.config.ts`
 * runs `chromium` and `mobile` against the same `wrangler dev` and the same
 * local D1 — so the other project's drain tick lands inside that window and
 * sends the row before it is ever held. Observed exactly that way
 * (2026-08-31): "a held row stays queued" read `sent`, with the row's
 * `approval_state` correctly `pending`, because the send happened first.
 *
 * One INSERT closes the window: a row that is born `pending` or `rejected` can
 * never be sent by anyone's tick, so these tests assert on the drain's clause
 * rather than on who won a race.
 *
 * `email_type` is `intake-reply` — the fifth type `migrations/0021` widens the
 * CHECK for and `src/notifications.ts` adds to `SENDING_TYPES` — because that
 * is the thing approval exists to gate, and a row of that type must survive
 * `fromRow` to be visible on `/outbox` at all.
 *
 * Returns the id it minted. All content is synthetic (CLAUDE.md rule 1).
 */
export function seedGatedOutboxRow(
  toEmail: string,
  state: ApprovalState,
  approvedBy = "operator@example.test",
): string {
  const tag = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const id = `e2e-approval-${tag}`
  const decided = state === "approved" || state === "rejected"
  const now = new Date().toISOString()
  const approvedAt = decided ? sqlString(now) : "NULL"
  const approver = decided ? sqlString(approvedBy) : "NULL"

  execute(
    `INSERT INTO outbox
       (id, submission_id, email_type, to_email, from_email, subject, preheader, body,
        cta_text, cta_href, coord_revision, queued_at, status, attempts,
        approval_state, approved_at, approved_by)
     VALUES (
       ${sqlString(id)},
       ${sqlString(`sub_e2e_${tag}`)},
       'intake-reply',
       ${sqlString(toEmail)},
       'coord-portal <notify@intake.heurontech.com>',
       'A synthetic reply awaiting approval',
       'Synthetic preheader for e2e approval-gate coverage.',
       'A synthetic reply body. Nothing here is customer material.',
       'Open your request',
       '/submissions/sub_e2e_synthetic',
       1,
       ${sqlString(now)},
       'queued',
       0,
       ${sqlString(state)},
       ${approvedAt},
       ${approver}
     )`,
  )
  return id
}

/** The delivery/approval bookkeeping `/outbox` deliberately does not render. */
export interface OutboxRowState {
  status: string
  attempts: number
  sent_at: string | null
  claimed_at: string | null
  approval_state: string
  approved_by: string | null
}

/**
 * Reads back the columns the customer-facing `/outbox` page never shows —
 * `attempts` and `claimed_at` in particular. A held row that the drain
 * *claimed* and then failed to send would still read `queued` on the page,
 * so asserting "never claimed" needs the row itself, not its rendering.
 */
export function readOutboxRowState(id: string): OutboxRowState {
  const output = execute(
    `SELECT status, attempts, sent_at, claimed_at, approval_state, approved_by FROM outbox WHERE id = ${sqlString(id)}`,
  )
  const [{ results }] = JSON.parse(output) as [{ results: OutboxRowState[] }]
  const row = results[0]
  if (!row) throw new Error(`no outbox row with id ${id}`)
  return row
}
