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

function execute(command: string): void {
  runWrangler(["d1", "execute", DATABASE, "--local", "--json", "--command", command])
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
