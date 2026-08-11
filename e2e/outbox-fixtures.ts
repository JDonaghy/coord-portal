import { execFileSync } from "node:child_process"
import { join } from "node:path"

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
 */
const WRANGLER_BIN = join(process.cwd(), "node_modules", ".bin", "wrangler")
const DATABASE = "coord-portal"

function execute(command: string): string {
  return execFileSync(
    WRANGLER_BIN,
    ["d1", "execute", DATABASE, "--local", "--json", "--command", command],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  ).toString()
}

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
