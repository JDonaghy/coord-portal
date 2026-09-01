import { runWrangler } from "./wrangler-cli"

/**
 * Seeds `clients` / `projects` / `submissions` rows directly against the same
 * `--local` D1 state `serve:test`'s long-lived `wrangler dev` is serving from
 * — for issue #163 (EM-3, the inbound router)'s rung 3/4 e2e coverage.
 *
 * ── WHY DIRECT SEEDING, NOT THE APP'S OWN HTTP SURFACE ───────────────────────
 * A `clients` row with a `projects` row *linked to it* (`client_id` set) is
 * only ever produced today by lead promotion (`/start` → `POST
 * /leads/:id/promote`, ms-2/ms-4's own surface) — 0016's own migration note:
 * "A project only ever gains a `client_id` going forward, when lead
 * promotion creates or matches a client." Driving that full flow just to get
 * a fixture would make rung 3/4's own coverage depend on ms-4's UI mechanics
 * staying exactly as they are, for no benefit over seeding the tables this
 * repo's schema already names by column (`clients(id, email, cc_emails,
 * created_at)`, `projects(id, customer_email, client_id, name, created_at)`,
 * `submissions(id, reference, status, customer_email, project_id, outcome,
 * audience, done_definition, created_at)` — 0016/0012/0002's own committed
 * schemas). This is the exact posture `outbox-fixtures.ts` already takes for
 * `outbox` rows, and the exact posture `tests/acceptance/ms-5/
 * 163-inbound-router.spec.ts` (the sealed slice for this same issue) takes
 * for the same three tables — this file is `e2e/`'s own copy of that
 * reasoning, not a new one.
 *
 * Shares `wrangler-cli.ts`'s retry against the live `wrangler dev` process's
 * own write lock — see that module's own note on why a contended lock is a
 * wait, not a failure.
 *
 * SYNTHETIC DATA ONLY. Every value a caller passes here must be invented on
 * the reserved `example.test` TLD — CLAUDE.md rule 1: this repo is public and
 * a real customer's words in a commit (or, transitively, in a fixture that
 * writes them into a shared local D1 file) cannot be taken back.
 */
const DATABASE = "coord-portal"

function execute(command: string): string {
  return runWrangler(["d1", "execute", DATABASE, "--local", "--json", "--command", command])
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

let counter = 0
function tag(): string {
  counter += 1
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${counter}`
}

/** Six characters of `[A-Z0-9]` — the alphabet `SUB-XXXXXX` references are pinned to (`src/inboundRouter.ts`). */
function randomToken(n = 6): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
  let s = ""
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)]
  return s
}

/** Inserts one synthetic `clients` row. Returns the id it minted. */
export function insertClientRow(email: string, ccEmails?: string): string {
  const id = `e2e-client-${tag()}`
  const now = new Date().toISOString()
  const cols = ["id", "email", "created_at"]
  const vals = [sqlString(id), sqlString(email), sqlString(now)]
  if (ccEmails !== undefined) {
    cols.push("cc_emails")
    vals.push(sqlString(ccEmails))
  }
  execute(`INSERT INTO clients (${cols.join(", ")}) VALUES (${vals.join(", ")})`)
  return id
}

/** Inserts one synthetic `projects` row, optionally linked to a client. Returns the id it minted. */
export function insertProjectRow(opts: {
  clientId?: string
  customerEmail: string
  name?: string
  createdAt?: string
}): string {
  const id = `e2e-project-${tag()}`
  const now = opts.createdAt ?? new Date().toISOString()
  const cols = ["id", "customer_email", "created_at"]
  const vals = [sqlString(id), sqlString(opts.customerEmail), sqlString(now)]
  if (opts.clientId) {
    cols.push("client_id")
    vals.push(sqlString(opts.clientId))
  }
  if (opts.name) {
    cols.push("name")
    vals.push(sqlString(opts.name))
  }
  execute(`INSERT INTO projects (${cols.join(", ")}) VALUES (${vals.join(", ")})`)
  return id
}

/** Inserts one synthetic `submissions` row. Returns the id and reference it minted. */
export function insertSubmissionRow(opts: {
  customerEmail: string
  status?: string
  projectId?: string
  createdAt?: string
}): { id: string; reference: string } {
  const id = `e2e-sub-${tag()}`
  const reference = `SUB-${randomToken()}`
  const now = opts.createdAt ?? new Date().toISOString()
  const cols = ["id", "reference", "status", "customer_email", "outcome", "audience", "done_definition", "created_at"]
  const vals = [
    id,
    reference,
    opts.status ?? "describing",
    opts.customerEmail,
    "Synthetic outcome text for the ms-5 #163 e2e fixture.",
    "Synthetic audience for the ms-5 #163 e2e fixture.",
    "Synthetic done-definition for the ms-5 #163 e2e fixture.",
    now,
  ].map(sqlString)
  if (opts.projectId) {
    cols.push("project_id")
    vals.push(sqlString(opts.projectId))
  }
  execute(`INSERT INTO submissions (${cols.join(", ")}) VALUES (${vals.join(", ")})`)
  return { id, reference }
}

/** One `messages` row, as `messageCreationStatement` (`src/messages.ts`) writes one. */
export interface StoredMessageRow {
  id: string
  submission_id: string
  author_role: string
  author_email: string
  body: string
  created_at: string
}

/**
 * Every `messages` row on one submission's thread, oldest first — read
 * directly rather than through `/submissions/:id`'s own rendering, for issue
 * #165 (EM-5)'s own e2e coverage.
 *
 * `detailFor` (`src/routes/submission.ts`) deliberately omits the whole
 * message-thread section for a submission still at `describing` — the
 * receipt screen's own copy already says "No one is chatting with you right
 * now." Several of this file's own fixtures (and #163's rung 3/4 fixtures
 * this file was written for) leave a submission at that default status, so a
 * black-box assertion that a message *landed* has no page to read it back
 * from without first pushing the submission to some other status purely to
 * make the assertion possible — the same "no HTTP route to seed this through"
 * situation `outbox-fixtures.ts`'s own module comment describes for delivery
 * state, solved the same way here.
 */
export function readMessagesForSubmission(reference: string): StoredMessageRow[] {
  const output = execute(
    `SELECT id, submission_id, author_role, author_email, body, created_at FROM messages WHERE submission_id = ${sqlString(reference)} ORDER BY created_at ASC, id ASC`,
  )
  const [{ results }] = JSON.parse(output) as [{ results: StoredMessageRow[] }]
  return results
}

/** One submission's own `status` column — read directly for the same reason `readMessagesForSubmission` is. */
export function readSubmissionStatus(reference: string): string {
  const output = execute(`SELECT status FROM submissions WHERE reference = ${sqlString(reference)}`)
  const [{ results }] = JSON.parse(output) as [{ results: Array<{ status: string }> }]
  const row = results[0]
  if (!row) throw new Error(`no submission with reference ${reference}`)
  return row.status
}

/**
 * One `submissions` row, in full — for issue #167 (EM-7)'s own e2e coverage,
 * which has to check `project_id`, `outcome`, `audience` and `done_definition`
 * together (what promotion produced) and there is no HTTP surface an operator
 * or customer reads all four back through at once.
 */
export interface StoredSubmissionRow {
  id: string
  reference: string
  status: string
  customer_email: string | null
  outcome: string
  audience: string
  done_definition: string
  project_id: string | null
}

export function readSubmissionRow(reference: string): StoredSubmissionRow {
  const output = execute(
    `SELECT id, reference, status, customer_email, outcome, audience, done_definition, project_id
       FROM submissions WHERE reference = ${sqlString(reference)}`,
  )
  const [{ results }] = JSON.parse(output) as [{ results: StoredSubmissionRow[] }]
  const row = results[0]
  if (!row) throw new Error(`no submission with reference ${reference}`)
  return row
}

/**
 * How many `submissions` rows exist for one customer email — issue #167's own
 * "promoting adds exactly one" assertion, scoped to a run's own unique
 * synthetic sender so it holds against this suite's shared, accumulating
 * database (see this file's own module comment, and `e2e/leads.spec.ts`'s
 * identical concern).
 */
export function countSubmissionsForEmail(email: string): number {
  const output = execute(`SELECT COUNT(*) as n FROM submissions WHERE customer_email = ${sqlString(email)}`)
  const [{ results }] = JSON.parse(output) as [{ results: Array<{ n: number }> }]
  return Number(results[0]?.n ?? -1)
}
