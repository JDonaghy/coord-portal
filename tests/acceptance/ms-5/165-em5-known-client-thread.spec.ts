import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { expect, test, type APIRequestContext, type Browser, type BrowserContext } from "@playwright/test"

/**
 * ms-5 sealed acceptance slice — issue #165
 * "[portal] EM-5: an email from a known client lands on the matched
 *  project's thread"
 *
 * Written from `tests/acceptance/ms-5/contract.md` (§ "The router ladder —
 * full six rungs", § "Schema — inbound_emails" (`routed_kind`,
 * `routed_project_id`, `routed_submission_id`, `outbox_id`), § "Why this
 * milestone has one real screen, not several" (`message-item` /
 * `data-author-role="customer"`), § "The templated reply — pinned
 * invariants", § "Schema — outbox.approval_state", § "Ownership") and issue
 * #165's own text, without sight of any implementation.
 *
 * ── WHAT #165 OWNS, AND WHAT THIS SLICE THEREFORE COVERS ────────────────────
 *
 * #165's own Scope: "Wire EM-3's rungs 1-5 — we know this sender — and draft
 * the routed acknowledgement." Three things, quoted:
 *
 *   1. "Append a thread message via postMessage() (src/messages.ts) on the
 *      matched project's newest submission, with author_role = 'customer'."
 *   2. "Record the link on the inbound_emails row: which submission, which
 *      rung decided it, the reason, and the runner-up."
 *   3. "Draft the routed acknowledgement into outbox, intake-reply, pending
 *      — same enqueue path EM-4 built."
 *
 * Plus the "Unrouted" section, which is #165's own to wire despite reading
 * like a non-case: rung 6's *ambiguous* outcome (as opposed to its *stranger*
 * outcome, #164's own) "writes no lead and no message... Draft a neutral
 * acknowledgement anyway."
 *
 * ── WHY THIS SLICE NEVER SEEDS `inbound_emails`/`messages`/`outbox` DIRECTLY ─
 *
 * Exactly #164's own reasoning, restated for this issue: #165 IS the write
 * path under test for the matched-thread and unrouted-parking cases. Every
 * row this file inspects is produced through the real `POST /__email` door
 * (#161, already sealed and landed) and read back read-only.
 *
 * ── WHY THIS SLICE SEEDS `clients`/`projects`/`submissions` DIRECTLY ─────────
 *
 * Same posture, same justification `ms-5/163-inbound-router.spec.ts` already
 * took: the only HTTP paths that produce a linked client/project pair sit in
 * an earlier, already-shipped milestone this slice has no reason to re-drive
 * end-to-end. Seeding the tables this contract already names by column
 * (`clients`, `projects`, `submissions` — 0016/0012/0002's own committed
 * schemas) isolates this slice from ms-4's UI mechanics.
 *
 * ── WHICH RUNGS THIS SLICE EXERCISES, AND WHY NOT ALL FIVE ──────────────────
 *
 * #165's own write behaviour has exactly two shapes, not five: rung 1 (and,
 * by the same mechanism, rung 2) names a *specific submission* directly (the
 * plus-address or a quoted reference), so the append target needs no lookup
 * beyond the reference itself; rungs 3, 4 and 5 each resolve to a *client's
 * project*, and #165's own job is then "the matched project's newest
 * submission" — one lookup, shared by all three. This slice exercises one
 * test of each shape (rung 1 for "direct submission", rung 3 for "resolve
 * the newest submission of a project") rather than five near-duplicates of
 * the same write mechanics under different routing decisions — rungs 2, 4
 * and 5's own *routing* decisions are #163's, already sealed by
 * `ms-5/163-inbound-router.spec.ts`, and are not re-proven here.
 *
 * ── NOT COVERED HERE, AND WHY ────────────────────────────────────────────────
 *  - **`/replies`, `/replies/:id` and its four actions (#166).** No mock and
 *    no issue text for this milestone's own one new screen belongs to #165;
 *    every assertion below that needs to read the drafted subject/body reads
 *    it through `GET /outbox` (ms-1's own sealed customer surface) or
 *    directly from the migrated D1, never a route `/replies` itself owns.
 *  - **The router ladder's own rung/reason/runner-up values** for rungs
 *    2/4/5 (#163, already sealed by `ms-5/163-inbound-router.spec.ts`). This
 *    slice reads `routed_rung`/`routed_kind` only as a sanity check that the
 *    decision it depends on is reaching the row, not as a fresh assertion of
 *    #163's own behaviour.
 *  - **Idempotency of a redelivered message.** #161's own `UNIQUE
 *    (message_id, to_email)` (already sealed by
 *    `ms-5/161-inbound-seam.spec.ts`) means a redelivery resolves to the
 *    SAME `inbound_emails` row before #165's own logic ever runs a second
 *    time — not a #165-specific guarantee to re-prove.
 *  - **Rate limiting (#169) and attachments (#169).** Different issue,
 *    dispatched separately; not exercised here.
 *  - **The exact `cta_href`/wording of the unrouted-case neutral
 *    acknowledgement, and exactly how "both candidates" are recorded beyond
 *    `routed_runner_up`.** TODO(test-author): no mock or issue text, before
 *    or after amendment, gives a concrete shape for either — this slice
 *    checks the unrouted draft exists, is customer-safe, and is silent on
 *    submission state, but does not pin its CTA or the multi-candidate
 *    storage encoding beyond the single `routed_runner_up` column #163's own
 *    slice already exercises.
 *
 * SYNTHETIC DATA. Per CLAUDE.md rule 1 and contract § "Synthetic data", every
 * address, name, subject and body below is invented on the reserved
 * `example.test` TLD — never the real `intake@heurontech.com` /
 * `mail.heurontech.com` domains this milestone actually wires up.
 */

test.describe.configure({ timeout: 120_000 })

// ── the repository, as a schema surface (mirrors ms-5/161/162/163/164) ──────

function repoRoot(): string {
  let dir = process.cwd()
  for (let hops = 0; hops < 8; hops++) {
    if (existsSync(join(dir, "wrangler.toml")) && existsSync(join(dir, "package.json"))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(
    `could not locate the repo root (no wrangler.toml + package.json) walking up from ` +
      `${process.cwd()} — this slice seeds and reads the migrated local D1`,
  )
}

interface D1Result {
  ok: boolean
  rows: Record<string, unknown>[]
  error: string | null
}

/** Run one statement against the migrated local D1 — read or write. */
function d1(sql: string): D1Result {
  const root = repoRoot()
  const local = join(root, "node_modules", ".bin", "wrangler")
  const [cmd, lead] = existsSync(local) ? [local, [] as string[]] : ["npx", ["wrangler"]]
  const args = [...lead, "d1", "execute", "coord-portal", "--local", "--json", "--command", sql]

  let stdout: string
  try {
    stdout = execFileSync(cmd, args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    })
  } catch (err) {
    stdout = String((err as { stdout?: string }).stdout ?? "")
    if (!stdout.trim()) {
      const stderr = String((err as { stderr?: string }).stderr ?? "").trim()
      throw new Error(`wrangler d1 execute produced no output for ${sql}\n${stderr}`)
    }
  }

  const start = stdout.search(/[[{]/)
  if (start < 0) throw new Error(`could not find JSON in wrangler's output for ${sql}\n${stdout}`)
  const parsed = JSON.parse(stdout.slice(start)) as unknown

  if (Array.isArray(parsed)) {
    const first = parsed[0] as { results?: Record<string, unknown>[] } | undefined
    return { ok: true, rows: first?.results ?? [], error: null }
  }
  const failure = parsed as { error?: { text?: string } }
  return { ok: false, rows: [], error: failure.error?.text ?? JSON.stringify(parsed) }
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''")
}

let counter = 0
/** A unique, synthetic label — every row this slice writes owns its own. */
function unique(label: string): string {
  counter += 1
  return `ms5-165-${label}-${Date.now()}-${counter}`
}

function randomToken(n = 6): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
  let s = ""
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)]
  return s
}

const SEED_HINT =
  "issue #165 wires EM-3's rungs 1-5 into a message append + drafted acknowledgement, on top of the " +
  "clients/projects/submissions schema earlier, already-shipped milestones own — this slice's own " +
  "fixture-seeding write failed, which points at that schema being missing, not a #165 defect"

// ── seeding clients / projects / submissions directly (mirrors ms-5/163) ────

function insertClient(email: string, ccEmails?: string): string {
  const id = `client-${unique("client")}`
  const now = new Date().toISOString()
  const cols = ["id", "email", "created_at"]
  const vals = [`'${escapeSql(id)}'`, `'${escapeSql(email)}'`, `'${escapeSql(now)}'`]
  if (ccEmails) {
    cols.push("cc_emails")
    vals.push(`'${escapeSql(ccEmails)}'`)
  }
  const r = d1(`INSERT INTO clients (${cols.join(", ")}) VALUES (${vals.join(", ")})`)
  expect(r.ok, `seeding a synthetic client failed (${SEED_HINT}). SQLite said: ${r.error}`).toBe(true)
  return id
}

function insertProject(opts: { clientId?: string; customerEmail: string; name?: string }): string {
  const id = `project-${unique("project")}`
  const now = new Date().toISOString()
  const cols = ["id", "customer_email", "created_at"]
  const vals = [`'${escapeSql(id)}'`, `'${escapeSql(opts.customerEmail)}'`, `'${escapeSql(now)}'`]
  if (opts.clientId) {
    cols.push("client_id")
    vals.push(`'${escapeSql(opts.clientId)}'`)
  }
  if (opts.name) {
    cols.push("name")
    vals.push(`'${escapeSql(opts.name)}'`)
  }
  const r = d1(`INSERT INTO projects (${cols.join(", ")}) VALUES (${vals.join(", ")})`)
  expect(r.ok, `seeding a synthetic project failed (${SEED_HINT}). SQLite said: ${r.error}`).toBe(true)
  return id
}

function insertSubmission(opts: {
  customerEmail: string
  status?: string
  projectId?: string
  reference?: string
  createdAt?: string
}): { id: string; reference: string } {
  const id = `sub-${unique("sub")}`
  const reference = opts.reference ?? `SUB-${randomToken()}`
  const now = opts.createdAt ?? new Date().toISOString()
  const cols = ["id", "reference", "status", "customer_email", "outcome", "audience", "done_definition", "created_at"]
  const vals = [
    id,
    reference,
    opts.status ?? "in-progress",
    opts.customerEmail,
    "Synthetic outcome text for the ms-5 #165 acceptance fixture.",
    "Synthetic audience for the ms-5 #165 acceptance fixture.",
    "Synthetic done-definition for the ms-5 #165 acceptance fixture.",
    now,
  ].map((v) => `'${escapeSql(v)}'`)
  if (opts.projectId) {
    cols.push("project_id")
    vals.push(`'${escapeSql(opts.projectId)}'`)
  }
  const r = d1(`INSERT INTO submissions (${cols.join(", ")}) VALUES (${vals.join(", ")})`)
  expect(r.ok, `seeding a synthetic submission failed (${SEED_HINT}). SQLite said: ${r.error}`).toBe(true)
  return { id, reference }
}

function countWhere(table: string, column: string, value: string): number {
  const q = d1(`SELECT COUNT(*) as n FROM ${table} WHERE ${column} = '${escapeSql(value)}'`)
  if (!q.ok) return -1
  return Number((q.rows[0] as { n: unknown } | undefined)?.n ?? -1)
}

function submissionStatus(id: string): string | null {
  const q = d1(`SELECT status FROM submissions WHERE id = '${escapeSql(id)}'`)
  if (!q.ok || q.rows.length === 0) return null
  return String((q.rows[0] as { status: unknown }).status)
}

/**
 * `routed_submission_id`'s exact encoding (the submission's own `id`, or its
 * customer-facing `reference`) is not pinned by name anywhere in the
 * contract — see this file's own "NOT COVERED" note. Accept either, the same
 * restraint the contract itself takes when a field encoding is its own
 * invention rather than a discovered fact.
 */
function matchesSubmission(value: string | null, sub: { id: string; reference: string }): boolean {
  return value === sub.id || value === sub.reference
}

// ── the inbound test door (mirrors ms-5/161/163/164) ─────────────────────────

const EMAIL_DOOR = "/__email"

const DOOR_UNAVAILABLE =
  `ms-5 issue #165 cannot be observed at all: \`POST ${EMAIL_DOOR}\` did not answer with the ` +
  "pinned `{id, disposition}` JSON shape. This door is #161's own, already sealed and landed — a " +
  "failure here means the acceptance environment itself is broken, not a #165 defect."

interface RawMessageOpts {
  from: string
  subject: string
  messageId?: string | null
  body: string
  extraHeaders?: Record<string, string>
}

function buildRawMessage(opts: RawMessageOpts): string {
  const headers: string[] = []
  headers.push(`From: ${opts.from}`)
  headers.push(`To: intake@mail.example.test`) // informational only — envelope `to` carries the real target
  headers.push(`Subject: ${opts.subject}`)
  if (opts.messageId !== null) {
    headers.push(`Message-ID: ${opts.messageId ?? `<${unique("msg")}@example.test>`}`)
  }
  headers.push(`Date: ${new Date().toUTCString()}`)
  headers.push("MIME-Version: 1.0")
  headers.push("Content-Type: text/plain; charset=utf-8")
  for (const [k, v] of Object.entries(opts.extraHeaders ?? {})) {
    headers.push(`${k}: ${v}`)
  }
  return headers.join("\r\n") + "\r\n\r\n" + opts.body
}

interface DoorResponse {
  id?: unknown
  disposition?: unknown
}

interface DoorResult {
  status: number
  body: DoorResponse | null
  text: string
}

async function postEmail(
  request: APIRequestContext,
  envelopeTo: string,
  envelopeFrom: string,
  raw: string,
): Promise<DoorResult> {
  const qs = new URLSearchParams({ to: envelopeTo, from: envelopeFrom })
  const res = await request.post(`${EMAIL_DOOR}?${qs.toString()}`, {
    data: raw,
    headers: { "content-type": "message/rfc822" },
    failOnStatusCode: false,
  })
  const text = await res.text()
  let body: DoorResponse | null = null
  try {
    body = JSON.parse(text) as DoorResponse
  } catch {
    body = null
  }
  return { status: res.status(), body, text }
}

/** Drive `POST /__email` and assert it answered the pinned `{id, disposition}` shape. */
async function deliver(
  request: APIRequestContext,
  envelopeTo: string,
  envelopeFrom: string,
  raw: string,
): Promise<{ id: string; disposition: string }> {
  const result = await postEmail(request, envelopeTo, envelopeFrom, raw)
  expect(result.status, `${DOOR_UNAVAILABLE} (got HTTP ${result.status}, body: ${result.text})`).toBe(200)
  expect(result.body, `${DOOR_UNAVAILABLE} (body was not JSON: ${result.text})`).not.toBeNull()
  const body = result.body as DoorResponse
  expect(typeof body.id, "the pinned response carries a non-empty id").toBe("string")
  return { id: body.id as string, disposition: String(body.disposition) }
}

// DMARC-pass / DMARC-fail headers, shaped as Zoho's own forward would stamp
// them (contract § `reply-auth-result` topology note) — mirrors
// `ms-5/163-inbound-router.spec.ts`'s own constants.
const DMARC_PASS = "mx.zohomail.com; dmarc=pass header.from=example.test"
const DMARC_FAIL = "mx.zohomail.com; dmarc=fail header.from=example.test"

// ── reading rows back, read-only ─────────────────────────────────────────────

interface InboundRow {
  id: string
  routed_kind: string | null
  routed_rung: number | null
  routed_reason: string | null
  routed_runner_up: string | null
  routed_lead_id: string | null
  routed_project_id: string | null
  routed_submission_id: string | null
  outbox_id: string | null
}

function inboundRowById(id: string): InboundRow | null {
  const q = d1(`SELECT * FROM inbound_emails WHERE id = '${escapeSql(id)}'`)
  if (!q.ok || q.rows.length === 0) return null
  return q.rows[0] as unknown as InboundRow
}

interface MessageRow {
  id: string
  submission_id: string
  author_role: string
  author_email: string
  body: string
}

function messagesFor(submissionReference: string): MessageRow[] {
  const q = d1(`SELECT * FROM messages WHERE submission_id = '${escapeSql(submissionReference)}'`)
  if (!q.ok) return []
  return q.rows as unknown as MessageRow[]
}

interface OutboxRow {
  id: string
  email_type: string
  to_email: string
  approval_state: string
  status: string
  attempts: number
  sent_at: string | null
  cta_href: string
  body: string
  subject: string
}

function outboxRowById(id: string): OutboxRow | null {
  const q = d1(`SELECT * FROM outbox WHERE id = '${escapeSql(id)}'`)
  if (!q.ok || q.rows.length === 0) return null
  return q.rows[0] as unknown as OutboxRow
}

const MIGRATION_HINT =
  "issues #161/#162/#163 (already landed) provide the schema and routing this slice depends on; " +
  "a failure locating the expected row past `POST /__email` succeeding means #165's own message-" +
  "append + enqueue wiring (`src/inboundEmail.ts`, `src/messages.ts` call site, `src/notifications.ts`) " +
  "has not landed yet"

// ── the drain trigger (mirrors ms-5/162/164) ─────────────────────────────────

const DRAIN = "/__scheduled"

async function runDrain(request: APIRequestContext): Promise<void> {
  const res = await request.get(DRAIN)
  expect(res.ok(), `GET ${DRAIN} (ms-3 issue #50, already sealed) should answer 2xx`).toBe(true)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function tickDrain(request: APIRequestContext, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    await runDrain(request)
    await sleep(500)
  }
}

// ── operator + customer identity (mirrors ms-4/132, ms-5/164) ───────────────

const ACCESS_HEADER = "Cf-Access-Authenticated-User-Email"

function withIdentity(browser: Browser, baseURL: string | undefined, email: string): Promise<BrowserContext> {
  return browser.newContext({ baseURL, extraHTTPHeaders: { [ACCESS_HEADER]: email } })
}

// ── FORBIDDEN vocabulary (ms-1 issue #14's own list, reused verbatim) ───────

const FORBIDDEN: Array<[RegExp, string]> = [
  [/\bSTUCK:/i, "the worker's escalation vocabulary is engineer-side"],
  [/\bissue\s*#?\d+/i, "customers never see an issue number"],
  [/#\d+/, "customers never see a GitHub number"],
  [/\bepic\b/i, "the epic is an engineer-side decomposition artefact"],
  [/\bmilestone\b/i, "the milestone is an engineer-side artefact"],
  [/\bpull request\b/i, "no PR ever crosses the wall"],
  [/\bPR\b/, "no PR ever crosses the wall"],
  [/\bbranch(es)?\b/i, "customers never see a branch"],
  [/\bcommit(s|ted)?\b/i, "customers never see a commit"],
  [/\bworktree\b/i, "customers never see a worktree"],
  [/\bagent\b/i, "customers never see a live agent"],
  [/\bworker\b/i, "customers never see an engineer-side worker"],
  [/\bgithub\b/i, "the engineer side is not named"],
  [/\bdaemon\b/i, "the daemon is not a customer-facing concept"],
]

// A submission status word the drafted acknowledgement must never leak.
const STATE_DISCLOSURE = /\bin[- ]progress\b/i

// ═══════════════════════════════════════════════════════════════════════════

test.describe("ms-5 issue 165 EM-5: a known client's email lands on the matched thread", () => {
  // ── rung 3 — known client, one project: append + record the link ─────────

  test("rung 3 — a known client's message appends exactly one messages row on the project's newest submission, records the routing link, and changes no submissions.status", async ({
    request,
    browser,
    baseURL,
  }) => {
    const clientEmail = `${unique("known")}@example.test`
    const client = insertClient(clientEmail)
    const project = insertProject({ clientId: client, customerEmail: clientEmail, name: "Garden Rota Rebuild" })

    const older = insertSubmission({
      customerEmail: clientEmail,
      projectId: project,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    })
    const newest = insertSubmission({
      customerEmail: clientEmail,
      projectId: project,
      createdAt: new Date(Date.now() - 1_000).toISOString(),
    })

    const messageBody = "Quick question — can we push the launch date back a week?"
    const raw = buildRawMessage({
      from: clientEmail,
      subject: "Timing question",
      body: messageBody,
      extraHeaders: { "Authentication-Results": DMARC_PASS },
    })

    const result = await deliver(request, "intake@mail.example.test", clientEmail, raw)
    expect(result.disposition, "a known client's message is never suppressed or rate-limited").toBe("received")

    const inbound = inboundRowById(result.id)
    expect(inbound, `no inbound_emails row was found for id ${result.id}`).not.toBeNull()
    const r = inbound as InboundRow

    // Sanity check only — #163's own rung-3 decision, already sealed by
    // `ms-5/163-inbound-router.spec.ts`.
    expect(r.routed_kind, "contract § router ladder: an exact-match rung resolves to a project, kind 'message'").toBe(
      "message",
    )

    // ── issue #165 scope item 2: "record the link" ─────────────────────────
    expect(r.routed_project_id, `issue #165 scope item 2 (${MIGRATION_HINT})`).toBe(project)
    expect(
      matchesSubmission(r.routed_submission_id, newest),
      `routed_submission_id (${r.routed_submission_id}) should resolve to the NEWEST submission ` +
        `(${JSON.stringify(newest)}), not the older one (${JSON.stringify(older)}) (${MIGRATION_HINT})`,
    ).toBe(true)
    expect(r.routed_reason, "issue #165 scope item 2: \"the reason\"").not.toBeNull()
    expect(
      r.routed_runner_up,
      "rung 3 is an exact match (contract: absent on rungs 1-3) — nothing to be a runner-up to",
    ).toBeNull()

    // ── issue #165 scope item 1: "append a thread message ... on the
    //    matched project's newest submission" ──────────────────────────────
    const newestMessages = messagesFor(newest.reference)
    expect(newestMessages.length, `exactly one messages row on the newest submission (${MIGRATION_HINT})`).toBe(1)
    expect(newestMessages[0].author_role, "issue #165 scope item 1: \"author_role = 'customer'\"").toBe("customer")
    expect(newestMessages[0].author_email, "the message is authored by the actual sender").toBe(clientEmail)
    expect(newestMessages[0].body, "the message thread carries the sender's own words verbatim").toBe(messageBody)

    const olderMessages = messagesFor(older.reference)
    expect(olderMessages.length, "the OLDER submission on the same project must get no message at all").toBe(0)

    // ── "moves no status" (contract § "Why a message and not a submission") ─
    expect(submissionStatus(newest.id), "postMessage never changes submissions.status").toBe("in-progress")
    expect(submissionStatus(older.id), "postMessage never changes submissions.status").toBe("in-progress")

    // ── "costs nothing" — no lead, ever, for a matched sender ───────────────
    expect(countWhere("leads", "email", clientEmail), "a matched sender never produces a leads row").toBe(0)

    // ── rendered on the real customer thread (contract § "Why this
    //    milestone has one real screen, not several": message-item /
    //    data-author-role="customer", the *existing* component) ────────────
    const customerCtx = await withIdentity(browser, baseURL, clientEmail)
    const customer = await customerCtx.newPage()
    await customer.goto(`/submissions/${newest.id}`)
    const items = customer.getByTestId("message-item")
    await expect(items, "the newest submission's own thread shows exactly the one appended message").toHaveCount(1)
    await expect(items.first()).toHaveAttribute("data-author-role", "customer")
    await expect(customer.getByTestId("message-body").first()).toHaveText(messageBody)

    await customer.goto(`/submissions/${older.id}`)
    await expect(
      customer.getByTestId("message-item"),
      "the older submission's own thread must show no message at all",
    ).toHaveCount(0)
    await customerCtx.close()
  })

  // ── rung 1 — a plus-addressed reference beats sender-identity resolution ─

  test("rung 1 — a plus-addressed envelope recipient routes the message to the exact named submission, not the sender's own newest one", async ({
    request,
  }) => {
    const clientEmail = `${unique("plus")}@example.test`
    const client = insertClient(clientEmail)
    const project = insertProject({ clientId: client, customerEmail: clientEmail, name: "Plus-Address Project" })

    // If sender-identity resolution (rung 3) fired, this is the submission it
    // would land on: the project's only OTHER submission, and the more
    // recent of the two.
    const wouldBeNewest = insertSubmission({
      customerEmail: clientEmail,
      projectId: project,
      createdAt: new Date(Date.now() - 1_000).toISOString(),
    })
    // The plus-address names THIS older submission instead.
    const target = insertSubmission({
      customerEmail: clientEmail,
      projectId: project,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    })

    const to = `intake+${target.reference}@mail.example.test`
    const raw = buildRawMessage({
      from: clientEmail,
      subject: "Following up",
      body: "Circling back on the note I sent about this one specifically.",
      // Contract: "Rung 1 ... [is] not gated on authentication" — a DMARC
      // FAIL here must not stop rung 1, or the append, from firing.
      extraHeaders: { "Authentication-Results": DMARC_FAIL },
    })

    const result = await deliver(request, to, clientEmail, raw)
    expect(result.disposition).toBe("received")

    const inbound = inboundRowById(result.id) as InboundRow
    expect(
      inbound.routed_rung,
      "contract § router ladder, rung 1: the envelope's own plus-addressed reference wins",
    ).toBe(1)
    expect(
      matchesSubmission(inbound.routed_submission_id, target),
      `the message must land on the PLUS-ADDRESSED submission (${JSON.stringify(target)}), even though ` +
        `sender-identity resolution would have pointed at the more recent one ` +
        `(${JSON.stringify(wouldBeNewest)}) (${MIGRATION_HINT})`,
    ).toBe(true)

    const targetMessages = messagesFor(target.reference)
    expect(targetMessages.length, `exactly one messages row on the named submission (${MIGRATION_HINT})`).toBe(1)
    expect(targetMessages[0].author_role).toBe("customer")

    const wouldBeMessages = messagesFor(wouldBeNewest.reference)
    expect(
      wouldBeMessages.length,
      "the submission sender-identity resolution would have picked must get no message at all",
    ).toBe(0)
  })

  // ── the routed acknowledgement — same enqueue path EM-4 built ────────────

  test("a matched sender's message drafts exactly one intake-reply outbox row at pending, never quotes their own words, discloses no status, and links back to the thread", async ({
    request,
    browser,
    baseURL,
  }) => {
    const clientEmail = `${unique("draft")}@example.test`
    const client = insertClient(clientEmail)
    const project = insertProject({ clientId: client, customerEmail: clientEmail, name: "Draft Safety Project" })
    const sub = insertSubmission({ customerEmail: clientEmail, projectId: project })

    // A distinctive canary phrase. If it ever reappears in the drafted
    // acknowledgement, the template quoted the sender's own message back to
    // them — forbidden by the same rule #164's own template invariants pin,
    // which the contract states apply to "every drafted body this milestone
    // produces."
    const canary = "teal-marmot-invoice-9902"
    const raw = buildRawMessage({
      from: clientEmail,
      subject: "A private detail",
      body: `Please reference ${canary} when you get a chance. Also, is it still in progress?`,
      extraHeaders: { "Authentication-Results": DMARC_PASS },
    })

    const result = await deliver(request, "intake@mail.example.test", clientEmail, raw)
    expect(result.disposition).toBe("received")

    const inbound = inboundRowById(result.id) as InboundRow
    expect(inbound.outbox_id, `issue #165 scope item 3 (${MIGRATION_HINT})`).not.toBeNull()

    const draft = outboxRowById(inbound.outbox_id as string) as OutboxRow
    expect(draft, `outbox_id (${inbound.outbox_id}) did not resolve to an outbox row`).not.toBeNull()
    expect(draft.email_type, "issue #165 scope item 3: \"outbox, intake-reply, pending\"").toBe("intake-reply")
    expect(draft.approval_state, "issue #165 scope item 3: \"pending\"").toBe("pending")
    expect(draft.to_email).toBe(clientEmail)
    expect(draft.status, "a freshly-drafted row is queued, not sent").toBe("queued")
    expect(draft.sent_at).toBeNull()
    expect(
      draft.cta_href,
      "contract § \"The templated reply\": \"/submissions/:id-shaped for a matched thread\"",
    ).toMatch(/^\/submissions\//)

    expect(draft.body, "issue #165 template invariant: never quotes the sender's own message").not.toContain(canary)
    expect(draft.subject).not.toContain(canary)
    expect(draft.body, "issue #165 template invariant: never discloses a submission status").not.toMatch(
      STATE_DISCLOSURE,
    )
    for (const [pattern, why] of FORBIDDEN) {
      expect(draft.body, `the drafted acknowledgement: ${why}`).not.toMatch(pattern)
      expect(draft.subject, `the drafted acknowledgement's subject: ${why}`).not.toMatch(pattern)
    }

    // ── the customer-facing read surface (ms-1 GET /outbox, unchanged) ──────
    const customerCtx = await withIdentity(browser, baseURL, clientEmail)
    const customer = await customerCtx.newPage()
    await customer.goto("/outbox")
    const preview = customer.getByTestId("email-preview")
    await expect(preview, "GET /outbox is scoped to the caller's own to_email (ms-1 issue #14)").toHaveCount(1)
    await expect(preview).toHaveAttribute("data-email-type", "intake-reply")
    await customerCtx.close()

    // ── contract § "The drain clause" must already hold here ───────────────
    await tickDrain(request, 5)
    const afterTicks = outboxRowById(draft.id) as OutboxRow
    expect(afterTicks.status, "a pending row is never claimed by the drain, however many ticks run").toBe("queued")
    expect(afterTicks.attempts).toBe(0)
    expect(afterTicks.sent_at).toBeNull()

    // ── the thread message itself is unaffected by draft/approval state ────
    expect(messagesFor(sub.reference).length, "the appended thread message is independent of the draft's own state").toBe(
      1,
    )
  })

  // ── the ambiguous case — parks unrouted, writes nothing, still drafts ────

  test("an ambiguous two-project client parks as unrouted with the runner-up recorded, writes no message and no lead, but still drafts a neutral acknowledgement", async ({
    request,
  }) => {
    const clientEmail = `${unique("ambiguous")}@example.test`
    const client = insertClient(clientEmail)
    const tiedTime = new Date(Date.now() - 30_000).toISOString()

    // A genuine three-way tie across every scoring axis #163's own rung-4
    // scoring reads (same status, same recency, no subject overlap) —
    // mirrors `ms-5/163-inbound-router.spec.ts`'s own tie fixture.
    const projectA = insertProject({ clientId: client, customerEmail: clientEmail, name: "Zeta Program" })
    const subA = insertSubmission({ customerEmail: clientEmail, projectId: projectA, status: "in-progress", createdAt: tiedTime })

    const projectB = insertProject({ clientId: client, customerEmail: clientEmail, name: "Omega Program" })
    const subB = insertSubmission({ customerEmail: clientEmail, projectId: projectB, status: "in-progress", createdAt: tiedTime })

    const raw = buildRawMessage({
      from: clientEmail,
      subject: "Checking in on things",
      body: "Just wanted to see where this stands.",
      extraHeaders: { "Authentication-Results": DMARC_PASS },
    })

    const result = await deliver(request, "intake@mail.example.test", clientEmail, raw)
    expect(result.disposition).toBe("received")

    const inbound = inboundRowById(result.id) as InboundRow
    expect(
      inbound.routed_kind,
      "contract § router ladder, rung 4 tie: \"falls to rung 6 as unrouted\" — a KNOWN client, unlike a stranger",
    ).toBe("unrouted")
    expect(inbound.routed_rung).toBe(6)
    expect(inbound.routed_project_id, "an unrouted row must not silently pick a project").toBeNull()
    expect(inbound.routed_submission_id, "an unrouted row has no matched submission").toBeNull()
    expect(inbound.routed_lead_id, "an unrouted row is not a stranger — no leads row either").toBeNull()
    expect(
      inbound.routed_runner_up,
      "contract: runner-up recorded for \"the unrouted case\" — the candidates the router considered",
    ).not.toBeNull()

    // ── issue #165 § "Unrouted": "writes no lead and no message" ────────────
    expect(messagesFor(subA.reference).length, "an unrouted row must append no message to either candidate").toBe(0)
    expect(messagesFor(subB.reference).length, "an unrouted row must append no message to either candidate").toBe(0)
    expect(countWhere("leads", "email", clientEmail), "an unrouted row is not a stranger — no leads row").toBe(0)

    // ── issue #165 § "Unrouted": "Draft a neutral acknowledgement anyway" ───
    expect(
      inbound.outbox_id,
      `issue #165 § "Unrouted": "the sender should still hear back" (${MIGRATION_HINT})`,
    ).not.toBeNull()
    const draft = outboxRowById(inbound.outbox_id as string) as OutboxRow
    expect(draft, `outbox_id (${inbound.outbox_id}) did not resolve to an outbox row`).not.toBeNull()
    expect(draft.email_type).toBe("intake-reply")
    expect(draft.approval_state).toBe("pending")
    expect(draft.to_email).toBe(clientEmail)
    expect(draft.body, "the neutral acknowledgement must not disclose either candidate project's status").not.toMatch(
      STATE_DISCLOSURE,
    )
    for (const [pattern, why] of FORBIDDEN) {
      expect(draft.body, `the neutral acknowledgement: ${why}`).not.toMatch(pattern)
    }
  })

  // ── DMARC-fail from a known address — never reaches postMessage ─────────

  test("a DMARC-fail message from a known client's address never reaches postMessage at all", async ({ request }) => {
    const clientEmail = `${unique("dmarcfail")}@example.test`
    const client = insertClient(clientEmail)
    const project = insertProject({ clientId: client, customerEmail: clientEmail, name: "Gated Thread Project" })
    const sub = insertSubmission({ customerEmail: clientEmail, projectId: project })

    const raw = buildRawMessage({
      from: clientEmail,
      subject: "Checking in",
      body: "Any news on this? Would love an update.",
      extraHeaders: { "Authentication-Results": DMARC_FAIL },
    })

    const result = await deliver(request, "intake@mail.example.test", clientEmail, raw)
    expect(result.disposition).toBe("received")

    const inbound = inboundRowById(result.id) as InboundRow
    // Sanity check only — #163's own rung-6 DMARC-gating decision, already
    // sealed by `ms-5/163-inbound-router.spec.ts`.
    expect(
      inbound.routed_kind,
      "contract § router ladder: \"rungs 3, 4 and 5 ... only fire when EM-1 recorded a DMARC pass\" " +
        "— a DMARC FAIL from a real client's own address must fall to unrouted, not resolve via rung 3",
    ).toBe("unrouted")

    // ── this issue's own acceptance sentence, verbatim ──────────────────────
    expect(
      messagesFor(sub.reference).length,
      "issue #165 acceptance: \"a DMARC-fail message from a known address does not reach postMessage at all\"",
    ).toBe(0)
    expect(
      inbound.routed_submission_id,
      "a DMARC-fail message must never resolve to a submission at all",
    ).toBeNull()
    expect(countWhere("leads", "email", clientEmail), "a known (if unauthenticated) address is not a stranger").toBe(0)

    // ── issue #165 § "Unrouted" applies to every unrouted row, not only the
    //    ambiguous-tie flavour — this row is unrouted too (routed_kind
    //    "unrouted", asserted above), so "draft a neutral acknowledgement
    //    anyway... the sender should still hear back" holds here as well.
    //    Unlike the pure absence checks above (which a wholly-unimplemented
    //    #165 already satisfies vacuously — nothing writes a message at all
    //    yet), this is the one assertion in this test that a missing #165
    //    implementation cannot pass by doing nothing (${MIGRATION_HINT}).
    expect(inbound.outbox_id, `issue #165 § "Unrouted" (${MIGRATION_HINT})`).not.toBeNull()
    const draft = outboxRowById(inbound.outbox_id as string) as OutboxRow
    expect(draft, `outbox_id (${inbound.outbox_id}) did not resolve to an outbox row`).not.toBeNull()
    expect(draft.email_type).toBe("intake-reply")
    expect(draft.approval_state).toBe("pending")
    expect(draft.to_email).toBe(clientEmail)
  })
})
