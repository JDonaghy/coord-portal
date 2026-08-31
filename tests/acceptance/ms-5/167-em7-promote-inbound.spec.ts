import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test"

/**
 * ms-5 sealed acceptance slice — issue #167
 * "[portal] EM-7: promote an inbound email to a submission, in one click"
 *
 * Written from `tests/acceptance/ms-5/contract.md` (§ "Route surface" —
 * `POST /replies/:id/promote`, § "/replies/:id — pinned data-testid hooks" —
 * `reply-promote-form`'s presence rule, § "Promotion idempotency", § "Schema
 * — inbound_emails" — `promoted_submission_id`/`promoted_at`, § "Ownership")
 * and issue #167's own text, without sight of any implementation.
 *
 * ── WHAT #167 OWNS, AND WHAT THIS SLICE THEREFORE COVERS ────────────────────
 *
 * Issue #167's own acceptance, quoted verbatim: "promoting an inbound email
 * creates exactly one submission with one `submission.created` event;
 * promoting it twice still creates one; the submission lands in the matched
 * project; the original message row is unchanged." Plus its own Behaviour and
 * Idempotency sections: the submission is owned by the sender's address, its
 * `outcome` is the message body, `audience`/`done_definition` are filled with
 * a plain "not captured" statement rather than a guess, everything happens
 * through `createSubmissionStatements()` (the same function `/intake` and
 * `promoteLead()` use), and the whole write is one guarded `DB.batch()` that
 * a double-click, a retry, or two concurrent promotes all converge on — read
 * back rather than trusted to have won any race.
 *
 * ── WHY THIS SLICE SEEDS clients/projects/submissions DIRECTLY ─────────────
 * Same reasoning `ms-5/163`, `ms-5/165` and `ms-5/166` already give: the only
 * HTTP path that produces a `clients` row with a linked `projects` row is out
 * of this milestone's scope, so the router rungs this slice needs (rung 3 for
 * an exact match, a rung-4 tie for the unrouted case) are seeded straight
 * into D1 by column name, on schema already shipped by earlier, already-
 * landed issues (#161-#166 are all landed on this branch). Every row this
 * slice actually promotes is produced through the real `POST /__email` door
 * and the real `/replies*` routes, never inserted directly.
 *
 * ── NOT COVERED HERE, deliberately ──────────────────────────────────────────
 *  - **The router ladder's own mechanics** (#163, already sealed) and **the
 *    drafted acknowledgement's own copy / EM-6's approve-edit-discard flow**
 *    (#164/#165/#166, already sealed). `routed_kind`/`routed_rung` are read
 *    back only as a sanity check that the scenario this slice needs actually
 *    landed, and `reply-promote-form`'s own presence/absence rule is #166's
 *    own scope (asserted there, not re-asserted here) — this slice drives the
 *    form only where the contract already says it is present.
 *  - **"Change route" targeting an operator-chosen CLIENT** (as opposed to a
 *    candidate project). Same contract-flagged invention gap
 *    `166-em6-replies-review.spec.ts` already declines to test.
 *  - **Rate limiting and attachments (#169).** Different issue.
 *  - **What `approval_state` becomes on a row immediately after a
 *    *successful* promote.** TODO(test-author): the contract's route table
 *    says `/promote` is guarded on `approval_state = 'pending'` the same way
 *    the other three actions are, and pins that `/route` explicitly *keeps*
 *    it `pending` — but it never says what a successful `/promote` itself
 *    sets `approval_state` to (unlike approve -> `approved` and discard ->
 *    `rejected`, both pinned verbatim). This slice therefore asserts the
 *    idempotency guard from the *outside* only — a promote attempt on a row
 *    that has already left `pending` some other way (this slice uses discard)
 *    must not create a submission — rather than asserting a specific new
 *    `approval_state` value after promote succeeds, which is not pinned.
 *
 * SYNTHETIC DATA. Per CLAUDE.md rule 1 and contract § "Synthetic data", every
 * address, name and message body below is invented on the reserved
 * `example.test` TLD.
 */

test.describe.configure({ timeout: 120_000 })

// ── the repository, as a schema surface (mirrors ms-5/161-166) ──────────────

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
      `${process.cwd()} — this slice reads/seeds the migrated local D1, and only through it`,
  )
}

interface D1Query {
  ok: boolean
  rows: Record<string, unknown>[]
  error: string | null
}

/** Ask (or write to) the migrated local D1. Mirrors every prior ms-5 slice's own `d1()`. */
function d1(sql: string): D1Query {
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
/** A unique, synthetic local-part — every test in this slice owns its own address. */
function unique(label: string): string {
  counter += 1
  return `ms5-167-${label}-${Date.now()}-${counter}`
}

const SEED_HINT =
  "this slice seeds clients/projects/submissions directly on schema already shipped by earlier, " +
  "already-landed issues (#161-#166) — a failure here means that schema is missing, not a #167 defect"

// ── seeding clients / projects / submissions directly (mirrors ms-5/166) ────

function insertClient(email: string): string {
  const id = `client-${unique("client")}`
  const now = new Date().toISOString()
  const r = d1(
    `INSERT INTO clients (id, email, created_at) VALUES ('${escapeSql(id)}', '${escapeSql(email)}', '${escapeSql(now)}')`,
  )
  expect(r.ok, `seeding a synthetic client failed (${SEED_HINT}). SQLite said: ${r.error}`).toBe(true)
  return id
}

function insertProject(opts: { clientId: string; customerEmail: string; name: string }): string {
  const id = `project-${unique("project")}`
  const now = new Date().toISOString()
  const r = d1(
    `INSERT INTO projects (id, customer_email, client_id, name, created_at) VALUES ` +
      `('${escapeSql(id)}', '${escapeSql(opts.customerEmail)}', '${escapeSql(opts.clientId)}', ` +
      `'${escapeSql(opts.name)}', '${escapeSql(now)}')`,
  )
  expect(r.ok, `seeding a synthetic project failed (${SEED_HINT}). SQLite said: ${r.error}`).toBe(true)
  return id
}

function insertSubmission(opts: {
  customerEmail: string
  projectId: string
  status?: string
  createdAt?: string
}): { id: string; reference: string } {
  const id = `sub-${unique("sub")}`
  const reference = `SUB-${unique("ref").slice(-6).toUpperCase()}`
  const now = opts.createdAt ?? new Date().toISOString()
  const cols = [
    "id",
    "reference",
    "status",
    "customer_email",
    "outcome",
    "audience",
    "done_definition",
    "created_at",
    "project_id",
  ]
  const vals = [
    id,
    reference,
    opts.status ?? "describing",
    opts.customerEmail,
    "Synthetic outcome text for the ms-5 #167 acceptance fixture.",
    "Synthetic audience for the ms-5 #167 acceptance fixture.",
    "Synthetic done-definition for the ms-5 #167 acceptance fixture.",
    now,
    opts.projectId,
  ].map((v) => `'${escapeSql(v)}'`)
  const r = d1(`INSERT INTO submissions (${cols.join(", ")}) VALUES (${vals.join(", ")})`)
  expect(r.ok, `seeding a synthetic submission failed (${SEED_HINT}). SQLite said: ${r.error}`).toBe(true)
  return { id, reference }
}

function countWhere(table: string, column: string, value: string): number {
  const q = d1(`SELECT COUNT(*) as n FROM ${table} WHERE ${column} = '${escapeSql(value)}'`)
  if (!q.ok) return -1
  return Number((q.rows[0] as { n: unknown } | undefined)?.n ?? -1)
}

// ── the inbound test door (mirrors ms-5/161-166) ────────────────────────────

const EMAIL_DOOR = "/__email"

const DOOR_UNAVAILABLE =
  `ms-5 issue #167 cannot be observed at all: \`POST ${EMAIL_DOOR}\` did not answer with the ` +
  "pinned `{id, disposition}` JSON shape. This door is #161's own, already sealed and landed — a " +
  "failure here means the acceptance environment itself is broken, not a #167 defect."

interface RawMessageOpts {
  from: string
  subject: string
  messageId: string | null
  body: string
  extraHeaders?: Record<string, string>
}

function buildRawMessage(opts: RawMessageOpts): string {
  const headers: string[] = []
  headers.push(`From: ${opts.from}`)
  headers.push(`To: intake@mail.example.test`) // informational only — envelope `to` carries the real target
  headers.push(`Subject: ${opts.subject}`)
  if (opts.messageId) headers.push(`Message-ID: ${opts.messageId}`)
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
  raw: string,
  opts: { from: string },
): Promise<DoorResult> {
  const local = unique("recipient")
  const to = `${local}-to@example.test`
  const qs = new URLSearchParams({ to, from: opts.from })
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
  opts: {
    from: string
    subject: string
    messageId: string | null
    body: string
    extraHeaders?: Record<string, string>
  },
): Promise<{ id: string; disposition: string }> {
  const raw = buildRawMessage(opts)
  const result = await postEmail(request, raw, { from: opts.from })
  expect(result.status, `${DOOR_UNAVAILABLE} (got HTTP ${result.status}, body: ${result.text})`).toBe(200)
  expect(result.body, `${DOOR_UNAVAILABLE} (body was not JSON: ${result.text})`).not.toBeNull()
  const body = result.body as DoorResponse
  expect(typeof body.id, "the pinned response carries a non-empty id").toBe("string")
  return { id: body.id as string, disposition: String(body.disposition) }
}

// DMARC-pass, shaped as Zoho's own forward would stamp it (contract §
// "reply-auth-result" topology note) — same convention every prior ms-5 slice
// establishes. Rungs 3/4 need this to fire at all.
const DMARC_PASS = "mx.zohomail.com; dmarc=pass header.from=example.test"

// ── reading rows back, read-only ─────────────────────────────────────────────

interface InboundRow {
  id: string
  from_email: string
  subject: string
  body_text: string
  routed_kind: string | null
  routed_project_id: string | null
  routed_lead_id: string | null
  outbox_id: string | null
  promoted_submission_id: string | null
  promoted_at: string | null
}

function inboundRowById(id: string): InboundRow | null {
  const q = d1(`SELECT * FROM inbound_emails WHERE id = '${escapeSql(id)}'`)
  if (!q.ok || q.rows.length === 0) return null
  return q.rows[0] as unknown as InboundRow
}

interface SubmissionRow {
  id: string
  reference: string
  status: string
  customer_email: string
  outcome: string
  audience: string
  done_definition: string
  project_id: string | null
  created_at: string
}

function submissionById(id: string): SubmissionRow | null {
  const q = d1(`SELECT * FROM submissions WHERE id = '${escapeSql(id)}'`)
  if (!q.ok || q.rows.length === 0) return null
  return q.rows[0] as unknown as SubmissionRow
}

function submissionsByEmail(email: string): SubmissionRow[] {
  const q = d1(`SELECT * FROM submissions WHERE customer_email = '${escapeSql(email)}' ORDER BY created_at ASC`)
  if (!q.ok) return []
  return q.rows as unknown as SubmissionRow[]
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
  approval_state: string
}

function outboxRowById(id: string): OutboxRow | null {
  const q = d1(`SELECT * FROM outbox WHERE id = '${escapeSql(id)}'`)
  if (!q.ok || q.rows.length === 0) return null
  return q.rows[0] as unknown as OutboxRow
}

const MIGRATION_HINT =
  "issues #161-#166 (already landed) provide the schema, routing, drafting and review screen this " +
  "slice depends on; a failure locating the expected inbound/outbox row past `POST /__email` or " +
  "`/replies*` succeeding points at an earlier, already-sealed issue, not at #167 — unless the " +
  "failure is specifically about a submission's own creation, which is #167's own scope"

// ── operator + customer identity (mirrors ms-2/33, ms-5/164-166) ───────────

const ACCESS_HEADER = "Cf-Access-Authenticated-User-Email"

const OPERATOR_EMAIL = process.env.COORD_PORTAL_OPERATOR_EMAIL ?? "ops@example.test"

function withIdentity(browser: Browser, baseURL: string | undefined, email: string): Promise<BrowserContext> {
  return browser.newContext({ baseURL, extraHTTPHeaders: { [ACCESS_HEADER]: email } })
}

function asOperator(browser: Browser, baseURL: string | undefined): Promise<BrowserContext> {
  return withIdentity(browser, baseURL, OPERATOR_EMAIL)
}

/** The `/replies/:id` path for a pending draft, via the list row's own `review-reply` link. */
async function replyPathBySender(operator: Page, email: string): Promise<string> {
  await operator.goto("/replies")
  const row = operator.getByTestId("reply-row").filter({ hasText: email })
  await expect(row, `exactly one /replies row for ${email} (${MIGRATION_HINT})`).toHaveCount(1)
  const href = await row.getByTestId("review-reply").getAttribute("href")
  expect(href, "review-reply links to the reply's own detail screen").toMatch(/^\/replies\/[^/]+$/)
  return href!
}

/** Promote through the pinned form, the way an operator does. */
async function promoteViaUi(operator: Page, path: string): Promise<void> {
  await operator.goto(path)
  await expect(operator.getByTestId("reply-promote-form"), `reply-promote-form present (${MIGRATION_HINT})`).toBeVisible()
  await operator.getByTestId("reply-promote-button").click()
}

/** A raw form POST to the promote route, never assumed to redirect anywhere in particular. */
function postPromote(request: APIRequestContext, path: string) {
  return request.post(`${path}/promote`, { form: {}, maxRedirects: 0, failOnStatusCode: false })
}

// ── the sync bridge (mirrors ms-1/15, ms-2/33) ───────────────────────────────

interface BridgeEvent {
  id: string
  revision: number
  type: string
  submission_id: string
  occurred_at: string
  payload: unknown
}

const SERVICE_TOKEN = {
  "CF-Access-Client-Id":
    process.env.COORD_BRIDGE_CLIENT_ID ?? "9f2c17b4a8de40518c6b3ad0e75f1c62.access",
  "CF-Access-Client-Secret":
    process.env.COORD_BRIDGE_CLIENT_SECRET ??
    "4d1e9c07b35a2f68e4c81079ba6d35f2c9017e4ab8d562309fc71ea48b0d63a5",
}

/** Read `GET /api/bridge/pull` to its end from `cursor`, returning every event after it. */
async function pullSince(
  request: APIRequestContext,
  cursor: string | null,
): Promise<{ events: BridgeEvent[]; cursor: string | null }> {
  const events: BridgeEvent[] = []
  let at = cursor
  for (let page = 0; page < 100; page++) {
    const params: Record<string, string> = { limit: "200" }
    if (at != null) params.cursor = at
    const res = await request.get("/api/bridge/pull", { params, headers: SERVICE_TOKEN })
    expect(res.status(), "a pull with a valid service token is 200").toBe(200)
    const body = (await res.json()) as { events: BridgeEvent[]; cursor: string | null; has_more: boolean }
    events.push(...body.events)
    if (typeof body.cursor === "string" && body.cursor.length > 0) at = body.cursor
    if (!body.has_more) return { events, cursor: at }
    expect(body.events.length, "`has_more: true` with no events would page forever").toBeGreaterThan(0)
  }
  throw new Error("pull never reported has_more:false — the cursor is not advancing")
}

/**
 * Contract § "Promotion idempotency" / issue #167's own text: the not-
 * captured fields follow `promoteLead()`'s precedent — "a plain statement
 * that they were not captured, never a guess." Exact wording is not pinned
 * (the contract explicitly allows "`NOT_CAPTURED_AT_FIRST_CONTACT` or an
 * equivalent worded for this channel"), so this only asserts what the
 * contract actually requires: non-empty, not a blank placeholder, and never
 * the sender's own words repurposed as an invented answer.
 */
function expectNotCapturedPlaceholder(value: string, field: string, messageBody: string): void {
  expect(value, `${field}: must be populated, never null/empty`).toBeTruthy()
  const trimmed = value.trim()
  expect(trimmed.length, `${field}: must be a real sentence, not a token`).toBeGreaterThan(10)
  expect(
    ["n/a", "unknown", "-", "none", "todo", ""].includes(trimmed.toLowerCase()),
    `${field} ("${trimmed}") reads like a placeholder token, not a stated sentence`,
  ).toBe(false)
  expect(
    trimmed,
    `${field} must never be (or contain) the sender's own message — that would be a guess, not ` +
      `an honest "not captured" statement`,
  ).not.toContain(messageBody)
}

// ═══════════════════════════════════════════════════════════════════════════

test.describe("ms-5 issue 167 EM-7: promote an inbound email to a submission, in one click", () => {
  test("promoting a matched reply creates exactly one submission in the matched project, owned by the sender, and leaves EM-5's own thread message untouched", async ({
    request,
    browser,
    baseURL,
  }) => {
    const from = `${unique("core")}@example.test`
    const client = insertClient(from)
    const projectName = `Promote Target ${unique("proj")}`
    const project = insertProject({ clientId: client, customerEmail: from, name: projectName })
    const existing = insertSubmission({ customerEmail: from, projectId: project })

    const messageBody = `A brand new ask, buried in what looked like a reply — ${unique("body")}.`
    const delivered = await deliver(request, {
      from,
      subject: "Actually, one more thing",
      messageId: `<${unique("msgid")}@example.test>`,
      body: messageBody,
      extraHeaders: { "Authentication-Results": DMARC_PASS },
    })
    expect(delivered.disposition).toBe("received")

    const before = inboundRowById(delivered.id) as InboundRow
    expect(before.routed_kind, "sanity — depends on #163/#165, already landed").toBe("message")
    expect(before.routed_project_id, `sanity (${MIGRATION_HINT})`).toBe(project)
    expect(before.promoted_submission_id, "not yet promoted").toBeNull()

    // EM-5's own thread write, already landed — exactly one message on the
    // pre-existing submission this row matched to.
    const threadBefore = messagesFor(existing.reference)
    expect(threadBefore.length, `EM-5's own append (${MIGRATION_HINT})`).toBe(1)
    expect(threadBefore[0].body).toBe(messageBody)

    const baselineSubmissions = countWhere("submissions", "customer_email", from)
    expect(baselineSubmissions, "before promotion, only the seeded submission exists for this sender").toBe(1)

    const operatorCtx = await asOperator(browser, baseURL)
    const operator = await operatorCtx.newPage()
    const path = await replyPathBySender(operator, from)
    await promoteViaUi(operator, path)

    const after = inboundRowById(delivered.id) as InboundRow
    expect(after.promoted_submission_id, "issue #167: promoting mints a submission and records it").not.toBeNull()
    expect(after.promoted_at, "issue #167: promoted_at is stamped alongside").not.toBeNull()

    const submission = submissionById(after.promoted_submission_id as string)
    expect(submission, `the id inbound_emails.promoted_submission_id names must resolve (${MIGRATION_HINT})`).not.toBeNull()
    const created = submission as SubmissionRow

    expect(created.id, "promotion mints a NEW submission, distinct from the one EM-5 threaded onto").not.toBe(existing.id)
    expect(created.customer_email, "issue #167: owned by the sender's address").toBe(from)
    expect(created.project_id, "issue #167: lands in the matched project").toBe(project)
    expect(created.status, "createSubmissionStatements always creates at describing").toBe("describing")
    expect(created.outcome, "issue #167: the message body as its outcome").toBe(messageBody)
    expectNotCapturedPlaceholder(created.audience, "audience", messageBody)
    expectNotCapturedPlaceholder(created.done_definition, "done_definition", messageBody)

    // Exactly one NEW submission for this sender (the seeded one, plus this one).
    expect(countWhere("submissions", "customer_email", from), "promotion adds exactly one submission").toBe(2)

    // "The thread message EM-5 already wrote stays ... promotion adds a
    // submission, it does not rewrite history."
    const threadAfter = messagesFor(existing.reference)
    expect(threadAfter.length, "the old submission's own thread is untouched by promotion").toBe(1)
    expect(threadAfter[0]).toEqual(threadBefore[0])

    // Promotion mints a submission, not a message — the new submission has
    // none of its own.
    expect(messagesFor(created.reference).length, "promotion does not append a messages row").toBe(0)

    // The inbound row's own recorded facts (aside from the promotion columns)
    // are unchanged by promoting it.
    expect(after.from_email).toBe(before.from_email)
    expect(after.subject).toBe(before.subject)
    expect(after.body_text).toBe(before.body_text)
    expect(after.routed_project_id).toBe(before.routed_project_id)

    await operatorCtx.close()
  })

  test("promoting an inbound email produces exactly one submission.created event, shaped like an ordinary intake", async ({
    request,
    browser,
    baseURL,
  }) => {
    const from = `${unique("bridge")}@example.test`
    const client = insertClient(from)
    const project = insertProject({ clientId: client, customerEmail: from, name: `Bridge Shape ${unique("proj")}` })
    insertSubmission({ customerEmail: from, projectId: project })

    const baseline = await pullSince(request, null)

    const delivered = await deliver(request, {
      from,
      subject: "Something new, while I have you",
      messageId: `<${unique("msgid")}@example.test>`,
      body: `Bridge-shape check ${unique("body")}.`,
      extraHeaders: { "Authentication-Results": DMARC_PASS },
    })
    expect(delivered.disposition).toBe("received")

    // Landing the message itself (EM-5, already sealed) may or may not emit
    // its own bridge trace — not this slice's concern. Only what promotion
    // itself adds is asserted below, starting from a cursor taken just before
    // the promote.
    const preludeCursor = (await pullSince(request, baseline.cursor)).cursor ?? baseline.cursor

    const operatorCtx = await asOperator(browser, baseURL)
    const operator = await operatorCtx.newPage()
    const path = await replyPathBySender(operator, from)
    await promoteViaUi(operator, path)

    const inbound = inboundRowById(delivered.id) as InboundRow
    expect(inbound.promoted_submission_id, "issue #167: promoting must record the submission it minted").not.toBeNull()
    const submission = submissionById(inbound.promoted_submission_id as string) as SubmissionRow

    const afterPromote = await pullSince(request, preludeCursor)
    expect(
      afterPromote.events,
      "issue #167 acceptance: promoting creates exactly one submission.created event",
    ).toHaveLength(1)
    const event = afterPromote.events[0]
    expect(event.type).toBe("submission.created")
    expect(
      event.submission_id,
      "createSubmissionStatements() ships the customer-facing reference, byte-identical to /intake and promoteLead()",
    ).toBe(submission.reference)
    expect(typeof event.revision).toBe("number")

    // No email address of any kind crosses the bridge (CLAUDE.md rule 2, and
    // "the daemon never learns an email was involved").
    const serialised = JSON.stringify(afterPromote.events)
    expect(serialised, "no address crosses the bridge").not.toContain(from)

    await operatorCtx.close()
  })

  test("promoting the same inbound email twice — a retry and two concurrent attempts — converges on one submission", async ({
    request,
    browser,
    baseURL,
  }) => {
    const from = `${unique("idem")}@example.test`
    const client = insertClient(from)
    const project = insertProject({ clientId: client, customerEmail: from, name: `Idempotency ${unique("proj")}` })
    insertSubmission({ customerEmail: from, projectId: project })

    const delivered = await deliver(request, {
      from,
      subject: "One more ask",
      messageId: `<${unique("msgid")}@example.test>`,
      body: `Idempotency check ${unique("body")}.`,
      extraHeaders: { "Authentication-Results": DMARC_PASS },
    })
    expect(delivered.disposition).toBe("received")

    const operatorCtx = await asOperator(browser, baseURL)
    const operator = await operatorCtx.newPage()
    const path = await replyPathBySender(operator, from)
    await promoteViaUi(operator, path)

    const first = inboundRowById(delivered.id) as InboundRow
    const firstSubmissionId = first.promoted_submission_id
    expect(firstSubmissionId, "the first promote must have minted a submission").not.toBeNull()

    // "A double-click, a retry, or two concurrent promotes converge on one
    // submission." — a direct retried POST first.
    const retry = await postPromote(operatorCtx.request, path)
    expect(retry.status(), "a retried promote is not an error — it converges on the same submission").toBeLessThan(500)

    // ...then two genuinely concurrent attempts.
    const raced = await Promise.all([postPromote(operatorCtx.request, path), postPromote(operatorCtx.request, path)])
    for (const response of raced) {
      expect(response.status(), "a concurrent promote is not an error either").toBeLessThan(500)
    }

    const after = inboundRowById(delivered.id) as InboundRow
    expect(after.promoted_submission_id, "every promote reads back the same submission").toBe(firstSubmissionId)

    expect(
      countWhere("submissions", "customer_email", from),
      "issue #167 acceptance: \"promoting it twice still creates one\" — four promotes create exactly one new submission (the seeded one, plus this one)",
    ).toBe(2)

    await operatorCtx.close()
  })

  test('"Change route" to an operator-chosen project, then promote, lands the new submission in that chosen project', async ({
    request,
    browser,
    baseURL,
  }) => {
    const clientEmail = `${unique("route")}@example.test`
    const client = insertClient(clientEmail)
    const tiedTime = new Date(Date.now() - 30_000).toISOString()
    const projectA = insertProject({ clientId: client, customerEmail: clientEmail, name: `Alpha Promote ${unique("a")}` })
    insertSubmission({ customerEmail: clientEmail, projectId: projectA, status: "describing", createdAt: tiedTime })
    const projectB = insertProject({ clientId: client, customerEmail: clientEmail, name: `Beta Promote ${unique("b")}` })
    insertSubmission({ customerEmail: clientEmail, projectId: projectB, status: "describing", createdAt: tiedTime })

    const messageBody = `Ambiguous-client, new-ask body ${unique("body")}.`
    const delivered = await deliver(request, {
      from: clientEmail,
      subject: "Following up",
      messageId: `<${unique("msgid")}@example.test>`,
      body: messageBody,
      extraHeaders: { "Authentication-Results": DMARC_PASS },
    })
    expect(delivered.disposition).toBe("received")
    const inbound = inboundRowById(delivered.id) as InboundRow
    expect(inbound.routed_kind, "sanity — depends on #163, already landed: a genuine tie falls to unrouted").toBe(
      "unrouted",
    )

    const operatorCtx = await asOperator(browser, baseURL)
    const operator = await operatorCtx.newPage()
    const path = await replyPathBySender(operator, clientEmail)
    await operator.goto(path)

    // Re-target via the pinned "Change route" disclosure (#166, already
    // sealed — driven here only as the setup this test needs).
    const options = operator.getByTestId("reply-routing-option")
    await expect(options).toHaveCount(2)
    const first = options.first()
    const chosenTargetId = await first.getAttribute("data-target-id")
    expect([projectA, projectB]).toContain(chosenTargetId)
    await first.locator('input[type="radio"]').check()
    await operator.getByTestId("reply-routing-submit").click()

    const retargeted = inboundRowById(delivered.id) as InboundRow
    expect(retargeted.routed_project_id, `#166's own "Change route" (${MIGRATION_HINT})`).toBe(chosenTargetId)

    // Now #167's own act: promote the re-targeted row.
    await operator.goto(path)
    await promoteViaUi(operator, path)

    const promoted = inboundRowById(delivered.id) as InboundRow
    expect(promoted.promoted_submission_id).not.toBeNull()
    const submission = submissionById(promoted.promoted_submission_id as string) as SubmissionRow
    expect(
      submission.project_id,
      "issue #167: lands in the matched project — for a re-targeted row, that is the operator's chosen one",
    ).toBe(chosenTargetId)
    expect(submission.customer_email).toBe(clientEmail)
    expect(submission.outcome).toBe(messageBody)

    await operatorCtx.close()
  })

  test("a stranger's inbound email (already a lead) has no promote path here, and a direct POST creates no submission", async ({
    request,
    browser,
    baseURL,
  }) => {
    const from = `${unique("stranger")}@example.test`
    const delivered = await deliver(request, {
      from,
      subject: "Interested in a small project",
      messageId: `<${unique("msgid")}@example.test>`,
      body: "Hi, could someone quote a small booking page?",
    })
    expect(delivered.disposition).toBe("received")
    const inbound = inboundRowById(delivered.id) as InboundRow
    expect(inbound.routed_kind, "sanity — depends on #164, already landed").toBe("lead")
    expect(inbound.routed_lead_id, "sanity — #164's own write path").not.toBeNull()

    const operatorCtx = await asOperator(browser, baseURL)
    const operator = await operatorCtx.newPage()
    const path = await replyPathBySender(operator, from)
    await operator.goto(path)

    // Contract: reply-promote-form absent for data-routed-kind="lead" — a
    // stranger's own promotion path is /leads/:id/promote, unchanged by this
    // milestone (#166's own scope, not re-asserted here beyond this sanity
    // check that the setup this test needs actually holds).
    await expect(operator.getByTestId("reply-promote-form")).toHaveCount(0)

    const before = countWhere("submissions", "customer_email", from)
    const direct = await postPromote(operatorCtx.request, path)
    expect(direct.status(), "a rejected/no-op promote is not a server error").toBeLessThan(500)

    const after = inboundRowById(delivered.id) as InboundRow
    expect(after.promoted_submission_id, "a stranger's row has no matched project to promote into").toBeNull()
    expect(countWhere("submissions", "customer_email", from), "no submission is created for this address").toBe(
      before,
    )

    await operatorCtx.close()
  })

  test("a discarded draft cannot be promoted afterward — the pending guard blocks it", async ({
    request,
    browser,
    baseURL,
  }) => {
    const from = `${unique("discarded")}@example.test`
    const client = insertClient(from)
    const project = insertProject({ clientId: client, customerEmail: from, name: `Discard Guard ${unique("proj")}` })
    insertSubmission({ customerEmail: from, projectId: project })

    const delivered = await deliver(request, {
      from,
      subject: "Never mind",
      messageId: `<${unique("msgid")}@example.test>`,
      body: "Please disregard, this turned out to be nothing.",
      extraHeaders: { "Authentication-Results": DMARC_PASS },
    })
    expect(delivered.disposition).toBe("received")
    const inbound = inboundRowById(delivered.id) as InboundRow
    expect(inbound.outbox_id, MIGRATION_HINT).not.toBeNull()
    const outboxId = inbound.outbox_id as string

    const operatorCtx = await asOperator(browser, baseURL)
    const operator = await operatorCtx.newPage()
    const path = await replyPathBySender(operator, from)
    await operator.goto(path)
    await operator.getByTestId("reply-discard-button").click()

    const discarded = outboxRowById(outboxId) as OutboxRow
    expect(discarded.approval_state, "EM-6's own table: Discard -> approval_state = 'rejected'. Terminal.").toBe(
      "rejected",
    )

    const before = countWhere("submissions", "customer_email", from)
    const attempt = await postPromote(operatorCtx.request, path)
    expect(attempt.status(), "a guarded no-op is not a server error").toBeLessThan(500)

    const after = inboundRowById(delivered.id) as InboundRow
    expect(
      after.promoted_submission_id,
      "contract: /promote is guarded on approval_state = 'pending', same as the other three actions — a " +
        "discarded row must not be promotable afterward",
    ).toBeNull()
    expect(countWhere("submissions", "customer_email", from), "a guarded no-op creates nothing").toBe(before)

    await operatorCtx.close()
  })
})
