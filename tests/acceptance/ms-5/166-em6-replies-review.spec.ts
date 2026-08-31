import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test"

/**
 * ms-5 sealed acceptance slice — issue #166
 * "[portal] EM-6: /replies — proof-read, edit and approve a drafted reply
 *  before it sends"
 *
 * Written from `tests/acceptance/ms-5/contract.md` (§ "Route surface", § "/replies
 * — pinned data-testid hooks", § "/replies/:id — pinned data-testid hooks", §
 * "/replies/:id/route", § "Schema — outbox.approval_state", § "The drain
 * clause") and issue #166's own text, without sight of any implementation.
 *
 * ── WHAT #166 OWNS, AND WHAT THIS SLICE THEREFORE COVERS ────────────────────
 *
 * #166's own Scope: "the operator screen where a drafted reply is read,
 * edited and approved," gated by `readOperator()` with the same
 * indistinguishable 404 `/leads` and `/deliveries` already use — and its own
 * Acceptance, quoted verbatim: "a non-operator gets the same 404 as for
 * /leads; a pending draft renders with its inbound message and routing
 * reason; editing the body and approving sends the edited text, not the
 * original; approving twice sends once; a discarded draft never sends
 * however many ticks run." Plus the contract's own additional pin on "Change
 * route" (EM-6's own third action, confirmed by amendment as re-targeting ANY
 * row, not only an ambiguous one).
 *
 * ── WHY THIS SLICE SEEDS clients/projects/submissions DIRECTLY ─────────────
 * Same reasoning `ms-5/163-inbound-router.spec.ts` and
 * `ms-5/165-em5-known-client-thread.spec.ts` already give: the only HTTP path
 * that produces a `clients` row with a linked `projects` row is out of this
 * milestone's scope, so a router rung this slice needs to reach (rung 3 for
 * an exact match, a rung-4 tie for the unrouted case) is seeded straight into
 * D1 by column name, on schema already shipped by earlier, already-landed
 * issues (#161/#162/#163/#164/#165 are all landed on this branch — this
 * slice depends on their behaviour exactly the way #166's own issue text
 * assumes "After EM-4. The gate becomes operable," never re-asserting it).
 * Every ROW THIS SLICE ACTUALLY REVIEWS, EDITS, APPROVES OR DISCARDS — the
 * thing #166 itself owns — is produced through the real `POST /__email` door
 * and the real `/replies*` routes, never inserted directly.
 *
 * ── NOT COVERED HERE, AND WHY ────────────────────────────────────────────────
 *  - **The router ladder's own rung/reason/runner-up mechanics** (#163,
 *    already sealed). `routed_kind`/`routed_rung` are read back only as a
 *    sanity check that the scenario this slice needs (an exact match, or a
 *    genuine tie) actually landed on the row it seeded, never as a fresh
 *    assertion of #163's own behaviour.
 *  - **The drafted template's own copy, forbidden vocabulary and
 *    idempotency** (#164, #165, already sealed). This slice edits and reads
 *    back subject/body as opaque strings; it never asserts what the
 *    UNEDITED draft says.
 *  - **`replies-list-empty`.** Contract pins the hook in prose, but it is
 *    unassertable from this slice for the same reason
 *    `ms-2/33-lead-triage-promotion.spec.ts` already gives for
 *    `leads-list-empty`: the acceptance database is wiped per *run*, not per
 *    *test*, and `164-em4-stranger-lead.spec.ts` / `165-em5-known-client-thread.spec.ts`
 *    both sort before this file and leave `pending` intake-reply drafts of
 *    their own behind. By the time `/replies` is first reachable here the
 *    inbox is never empty.
 *  - **"Promote to a submission" actually creating anything** (#167, EM-7, a
 *    separate issue dispatched separately). This slice asserts only
 *    `reply-promote-form`'s presence/absence rule (part of EM-6's own
 *    rendering scope, pinned by the contract's hook table) — never that
 *    clicking it produces a submission, which is #167's own acceptance bar.
 *  - **Rate limiting (#169) and attachments (#169).** Different issue,
 *    dispatched separately.
 *  - **`Reply-To` on the drafted reply itself (#168).** Different issue.
 *  - **"Change route" targeting an operator-chosen CLIENT** (as opposed to
 *    one of the router's own candidate projects, or the literal `lead`).
 *    Contract's own Notes: the request encoding for this is "still this
 *    contract's own invention... no issue text, truncated or not, describes
 *    one" and no mock renders a client-picker. Not testable without an
 *    invented shape this slice would then be asserting into existence rather
 *    than discovering.
 *  - **What "re-render the draft from the template" visibly changes about
 *    subject/body text, and whether `/route` updates `routed_submission_id`
 *    / `cta_href`.** TODO(test-author): the contract's own schema table lists
 *    `routed_submission_id` as set by EM-5 alone, not by `/route`, and
 *    neither mock nor issue text says the rendered subject/body text must
 *    visibly differ between two structurally similar project targets (the
 *    template is not shown naming a project). This slice's own "Change
 *    route" test asserts only what is explicitly pinned: `routed_project_id`
 *    updates to the operator's chosen target, and `approval_state` stays
 *    `pending`.
 *
 * SYNTHETIC DATA. Per CLAUDE.md rule 1 and contract § "Synthetic data", every
 * address, name and message body below is invented on the reserved
 * `example.test` TLD — never the real `intake@heurontech.com` /
 * `mail.heurontech.com` domains this milestone actually wires up.
 */

test.describe.configure({ timeout: 120_000 })

// ── the repository, as a schema surface (mirrors ms-5/161/162/163/164/165) ──

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
  return `ms5-166-${label}-${Date.now()}-${counter}`
}

const SEED_HINT =
  "this slice seeds clients/projects/submissions directly on schema already shipped by earlier, " +
  "already-landed issues (#161-#165) — a failure here means that schema is missing, not a #166 defect"

// ── seeding clients / projects / submissions directly (mirrors ms-5/163) ────

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

function insertSubmission(opts: { customerEmail: string; projectId: string; status?: string; createdAt?: string }): string {
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
    "Synthetic outcome text for the ms-5 #166 acceptance fixture.",
    "Synthetic audience for the ms-5 #166 acceptance fixture.",
    "Synthetic done-definition for the ms-5 #166 acceptance fixture.",
    now,
    opts.projectId,
  ].map((v) => `'${escapeSql(v)}'`)
  const r = d1(`INSERT INTO submissions (${cols.join(", ")}) VALUES (${vals.join(", ")})`)
  expect(r.ok, `seeding a synthetic submission failed (${SEED_HINT}). SQLite said: ${r.error}`).toBe(true)
  return id
}

// ── the inbound test door (mirrors ms-5/161/163/164/165) ────────────────────

const EMAIL_DOOR = "/__email"

const DOOR_UNAVAILABLE =
  `ms-5 issue #166 cannot be observed at all: \`POST ${EMAIL_DOOR}\` did not answer with the ` +
  "pinned `{id, disposition}` JSON shape. This door is #161's own, already sealed and landed — a " +
  "failure here means the acceptance environment itself is broken, not a #166 defect."

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
  headers.push(`To: intake@mail.example.test`) // informational only
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

async function postEmail(request: APIRequestContext, raw: string, opts: { from: string }): Promise<DoorResult> {
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
  opts: { from: string; subject: string; messageId: string | null; body: string; extraHeaders?: Record<string, string> },
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
// "reply-auth-result" topology note) — same convention every prior ms-5
// slice establishes. Rungs 3/4 need this to fire at all.
const DMARC_PASS = "mx.zohomail.com; dmarc=pass header.from=example.test"

// ── reading rows back, read-only ─────────────────────────────────────────────

interface InboundRow {
  id: string
  from_email: string
  from_name: string | null
  subject: string
  body_text: string
  auth_result: string
  disposition: string
  routed_kind: string | null
  routed_rung: number | null
  routed_project_id: string | null
  routed_lead_id: string | null
  outbox_id: string | null
}

function inboundRowById(id: string): InboundRow | null {
  const q = d1(`SELECT * FROM inbound_emails WHERE id = '${escapeSql(id)}'`)
  if (!q.ok || q.rows.length === 0) return null
  return q.rows[0] as unknown as InboundRow
}

interface OutboxRow {
  id: string
  to_email: string
  subject: string
  body: string
  approval_state: string
  approved_at: string | null
  approved_by: string | null
  claimed_at: string | null
  status: string
  attempts: number
  sent_at: string | null
}

function outboxRowById(id: string): OutboxRow | null {
  const q = d1(`SELECT * FROM outbox WHERE id = '${escapeSql(id)}'`)
  if (!q.ok || q.rows.length === 0) return null
  return q.rows[0] as unknown as OutboxRow
}

const MIGRATION_HINT =
  "issues #161-#165 (already landed) provide the schema, routing and drafting this slice depends on; " +
  "a failure locating the expected outbox/inbound row past `POST /__email` succeeding points at an " +
  "earlier, already-sealed issue, not at #166 — unless the failure is specifically about `/replies*` " +
  "rendering or actions, which is #166's own scope"

// ── the drain trigger (mirrors ms-5/162, ms-5/164) ───────────────────────────

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

// ── the recording fake's captured payloads (contract: "observable ... via GET
// /__outbound (ms-3's existing test door — unchanged by this milestone)") ────

interface RecordedEmail {
  to: string
  from: string
  subject: string
  text: string
}

async function recordedEmails(request: APIRequestContext): Promise<RecordedEmail[]> {
  const res = await request.get("/__outbound")
  expect(res.ok(), "GET /__outbound (ms-3, already sealed, contract-confirmed unchanged) should answer 2xx").toBe(true)
  const body = (await res.json()) as { emails?: RecordedEmail[] }
  return body.emails ?? []
}

// ── operator + customer identity (mirrors ms-2/33, ms-5/164) ────────────────

const ACCESS_HEADER = "Cf-Access-Authenticated-User-Email"

/**
 * Same convention, same escape hatch and the same caveat every prior slice in
 * this repo that reads an operator identity records: the contract pins
 * operator *behaviour*, not the env var name.
 */
const OPERATOR_EMAIL = process.env.COORD_PORTAL_OPERATOR_EMAIL ?? "ops@example.test"

function withIdentity(browser: Browser, baseURL: string | undefined, email: string): Promise<BrowserContext> {
  return browser.newContext({ baseURL, extraHTTPHeaders: { [ACCESS_HEADER]: email } })
}

function asOperator(browser: Browser, baseURL: string | undefined): Promise<BrowserContext> {
  return withIdentity(browser, baseURL, OPERATOR_EMAIL)
}

/** A caller with no Access identity at all. */
function asStranger(browser: Browser, baseURL: string | undefined): Promise<BrowserContext> {
  return browser.newContext({ baseURL })
}

/**
 * The `/replies/:id` path for a pending draft, found the way an operator
 * finds it — via the list row's own `review-reply` link, filtered by sender
 * email. Mirrors `ms-5/164-em4-stranger-lead.spec.ts`'s own `leadPathByEmail`.
 */
async function replyPathBySender(operator: Page, email: string): Promise<string> {
  await operator.goto("/replies")
  const row = operator.getByTestId("reply-row").filter({ hasText: email })
  await expect(row, `exactly one /replies row for ${email} (${MIGRATION_HINT})`).toHaveCount(1)
  const href = await row.getByTestId("review-reply").getAttribute("href")
  expect(href, "review-reply links to the reply's own detail screen").toMatch(/^\/replies\/[^/]+$/)
  return href!
}

/** `routed_reason`/`reply-route-reason` is pinned "non-empty, human-readable... exact wording not pinned". */
function expectHumanReadable(text: string | null, context: string): void {
  expect(text, `${context}: must be populated`).not.toBeNull()
  const trimmed = (text ?? "").trim()
  expect(trimmed.length, `${context}: must be human-readable, not a placeholder`).toBeGreaterThan(10)
  expect(
    ["n/a", "unknown", "-", "none", "todo"].includes(trimmed.toLowerCase()),
    `${context}: ("${trimmed}") reads like a placeholder, not a reason`,
  ).toBe(false)
}

// ═══════════════════════════════════════════════════════════════════════════

test.describe("ms-5 issue 166 EM-6: /replies — proof-read, edit and approve a drafted reply", () => {
  // ── gating: the same indistinguishable 404 /leads and /deliveries use ────

  test("a non-operator gets the same 404 leadsNotFound() gives /leads, for /replies, /replies/:id, and every action route", async ({
    request,
    browser,
    baseURL,
  }) => {
    const from = `${unique("gate")}@example.test`
    const client = insertClient(from)
    const project = insertProject({ clientId: client, customerEmail: from, name: `Gate Test ${unique("proj")}` })
    insertSubmission({ customerEmail: from, projectId: project })

    const delivered = await deliver(request, {
      from,
      subject: "A message that should stay private",
      messageId: `<${unique("msgid")}@example.test>`,
      body: "Nobody but an operator should be able to read this.",
      extraHeaders: { "Authentication-Results": DMARC_PASS },
    })
    expect(delivered.disposition).toBe("received")
    const inbound = inboundRowById(delivered.id) as InboundRow
    expect(inbound.outbox_id, MIGRATION_HINT).not.toBeNull()
    const outboxId = inbound.outbox_id as string

    const operatorCtx = await asOperator(browser, baseURL)
    const operatorPeek = await operatorCtx.newPage()
    const path = await replyPathBySender(operatorPeek, from)
    await operatorCtx.close()

    const strangerCtx = await asStranger(browser, baseURL)
    // The reply's own sender is the sharpest customer identity to test: the
    // person the message is about still may not read the operator's inbox
    // (same reasoning ms-2's own 404 test gives for a lead's own address).
    const customerCtx = await withIdentity(browser, baseURL, from)

    for (const [who, ctx] of [
      ["an anonymous caller", strangerCtx],
      ["the reply's own sender (a customer identity)", customerCtx],
    ] as const) {
      for (const target of ["/replies", path]) {
        const res = await ctx.request.get(target, { maxRedirects: 0, failOnStatusCode: false })
        expect(res.status(), `${who} gets a 404 from ${target}`).toBe(404)
        const body = await res.text()
        expect(body, `${who} learns nothing about the reply`).not.toContain(from)
        expect(body, `${who} is not told the operator surface exists`).not.toContain('data-testid="replies-list"')
        expect(body, `${who} is not told the operator surface exists`).not.toContain('data-testid="reply-detail"')
      }

      for (const action of ["approve", "discard", "route", "promote"]) {
        const res = await ctx.request.post(`${path}/${action}`, {
          form: {},
          maxRedirects: 0,
          failOnStatusCode: false,
        })
        expect(res.status(), `${who} cannot ${action} a reply`).toBe(404)
      }
    }

    const stillPending = outboxRowById(outboxId) as OutboxRow
    expect(stillPending.approval_state, "no non-operator action above may have touched the row").toBe("pending")

    await strangerCtx.close()
    await customerCtx.close()
  })

  // ── /replies: a pending draft renders with its message and routing ───────

  test("a pending draft (rung 3, known client) renders on /replies with its inbound message and the router's decision", async ({
    request,
    browser,
    baseURL,
  }) => {
    const from = `${unique("list")}@example.test`
    const client = insertClient(from)
    const projectName = `List Renders ${unique("proj")}`
    const project = insertProject({ clientId: client, customerEmail: from, name: projectName })
    insertSubmission({ customerEmail: from, projectId: project })

    const delivered = await deliver(request, {
      from: `"List Sender" <${from}>`,
      subject: "A subject the list should show",
      messageId: `<${unique("msgid")}@example.test>`,
      body: "Body text for the list rendering check.",
      extraHeaders: { "Authentication-Results": DMARC_PASS },
    })
    expect(delivered.disposition).toBe("received")
    const inbound = inboundRowById(delivered.id) as InboundRow
    expect(inbound.routed_kind, "sanity — depends on #163/#165, already landed").toBe("message")
    expect(inbound.routed_rung, "sanity — rung 3, an exact single-project client match").toBe(3)

    const operatorCtx = await asOperator(browser, baseURL)
    const operator = await operatorCtx.newPage()
    await operator.goto("/replies")

    const row = operator.getByTestId("reply-row").filter({ hasText: from })
    await expect(row, `exactly one /replies row for ${from} (${MIGRATION_HINT})`).toHaveCount(1)
    await expect(row).toHaveAttribute("data-rung", "3")
    await expect(row).toHaveAttribute("data-routed-kind", "message")
    await expect(row.getByTestId("reply-sender-email")).toHaveText(from)
    await expect(row.getByTestId("reply-sender-name")).toHaveText("List Sender")
    await expect(row.getByTestId("reply-subject")).toHaveText("A subject the list should show")

    const receivedAt = (await row.getByTestId("reply-received-at").innerText()).trim()
    expect(receivedAt.length, "reply-received-at must not be blank").toBeGreaterThan(0)

    const auth = (await row.getByTestId("reply-auth-result").innerText()).trim()
    expect(["pass", "fail", "none"], "contract: auth_result vocabulary is exactly these three strings").toContain(auth)

    await expect(row.getByTestId("reply-route-badge")).toHaveAttribute("data-routed-kind", "message")
    const badgeText = await row.getByTestId("reply-route-badge").innerText()
    expect(badgeText, "contract: the badge names the matched project somewhere in its text").toContain(projectName)

    const href = await row.getByTestId("review-reply").getAttribute("href")
    expect(href, "review-reply links to /replies/:id").toMatch(/^\/replies\/[^/]+$/)

    await operatorCtx.close()
  })

  // ── /replies/:id: exact match — no runner-up, plain-text target ──────────

  test("GET /replies/:id renders the message as received and the router's decision for an exact match, with no runner-up and a plain-text route target", async ({
    request,
    browser,
    baseURL,
  }) => {
    const from = `${unique("detail")}@example.test`
    const client = insertClient(from)
    const projectName = `Detail Renders ${unique("proj")}`
    const project = insertProject({ clientId: client, customerEmail: from, name: projectName })
    insertSubmission({ customerEmail: from, projectId: project })

    const distinctiveBody = `Distinctive detail-view body ${unique("body")}.`
    const delivered = await deliver(request, {
      from: `"Detail Sender" <${from}>`,
      subject: "Detail view subject",
      messageId: `<${unique("msgid")}@example.test>`,
      body: distinctiveBody,
      extraHeaders: { "Authentication-Results": DMARC_PASS },
    })
    expect(delivered.disposition).toBe("received")
    const inbound = inboundRowById(delivered.id) as InboundRow
    expect(inbound.routed_kind, "sanity — depends on #163/#165, already landed").toBe("message")

    const operatorCtx = await asOperator(browser, baseURL)
    const operator = await operatorCtx.newPage()
    const path = await replyPathBySender(operator, from)
    await operator.goto(path)

    const main = operator.getByTestId("reply-detail")
    await expect(main).toHaveAttribute("data-rung", "3")
    await expect(main).toHaveAttribute("data-routed-kind", "message")

    const backLink = await operator.getByTestId("back-to-replies").getAttribute("href")
    expect(backLink).toBe("/replies")

    await expect(operator.getByTestId("reply-sender-email")).toHaveText(from)
    await expect(operator.getByTestId("reply-sender-name")).toHaveText("Detail Sender")
    await expect(operator.getByTestId("reply-subject")).toHaveText("Detail view subject")
    await expect(operator.getByTestId("reply-original-body")).toHaveText(distinctiveBody)

    await expect(operator.getByTestId("reply-route-decision")).toHaveAttribute("data-routed-kind", "message")
    const reason = await operator.getByTestId("reply-route-reason").innerText()
    expectHumanReadable(reason, "reply-route-reason (exact match)")

    await expect(
      operator.getByTestId("reply-route-runner-up"),
      "contract: absent on an exact-match rung (1-3) — there is nothing to be a runner-up to",
    ).toHaveCount(0)

    const target = operator.getByTestId("reply-route-target")
    await expect(target).toContainText(projectName)
    const tag = await target.evaluate((el) => el.tagName)
    expect(tag, "contract: reply-route-target is plain text, never a link").not.toBe("A")
    expect(await target.getAttribute("href"), "reply-route-target must carry no href").toBeNull()

    // No sibling project to move to, but a "become a lead instead" option
    // still exists (contract: reply-routing-option-lead is present whenever
    // routed_kind is 'message' or 'unrouted', even a sole exact match).
    await expect(operator.getByTestId("reply-routing-option")).toHaveCount(0)
    await expect(operator.getByTestId("reply-routing-option-lead")).toHaveCount(1)
    await expect(
      operator.getByTestId("reply-routing-toggle"),
      "contract: closed by default on an unambiguous match",
    ).not.toBeChecked()

    await expect(operator.getByTestId("reply-promote-form"), "contract: present for data-routed-kind=message").toBeVisible()
    await expect(operator.getByTestId("reply-approve-form")).toBeVisible()
    await expect(operator.getByTestId("reply-discard-form")).toBeVisible()

    await operatorCtx.close()
  })

  // ── /replies/:id: ambiguous tie — runner-up, panel open, both candidates ─

  test("GET /replies/:id for an ambiguous unrouted row shows both candidates, a runner-up, and the routing panel open by default", async ({
    request,
    browser,
    baseURL,
  }) => {
    const clientEmail = `${unique("tied")}@example.test`
    const client = insertClient(clientEmail)
    const tiedTime = new Date(Date.now() - 30_000).toISOString()

    // Same status, same recency, no name overlap with the subject below — a
    // genuine tie across every scoring axis the contract pins (mirrors
    // ms-5/163's own rung 4 -> 6 tie test).
    const projectA = insertProject({ clientId: client, customerEmail: clientEmail, name: `Zeta ${unique("a")}` })
    insertSubmission({ customerEmail: clientEmail, projectId: projectA, status: "describing", createdAt: tiedTime })
    const projectB = insertProject({ clientId: client, customerEmail: clientEmail, name: `Omega ${unique("b")}` })
    insertSubmission({ customerEmail: clientEmail, projectId: projectB, status: "describing", createdAt: tiedTime })

    const delivered = await deliver(request, {
      from: clientEmail,
      subject: "Following up on things",
      messageId: `<${unique("msgid")}@example.test>`,
      body: "Just checking in.",
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

    await expect(operator.getByTestId("reply-detail")).toHaveAttribute("data-routed-kind", "unrouted")

    const runnerUp = await operator.getByTestId("reply-route-runner-up").innerText()
    expect(runnerUp.trim().length, "contract: runner-up present for the unrouted case").toBeGreaterThan(0)

    await expect(
      operator.getByTestId("reply-routing-toggle"),
      "contract: open by default on an unrouted row",
    ).toBeChecked()

    const options = operator.getByTestId("reply-routing-option")
    await expect(options).toHaveCount(2)
    const targetIds = await options.evaluateAll((els) => els.map((el) => el.getAttribute("data-target-id")))
    expect(targetIds.sort()).toEqual([projectA, projectB].sort())

    await expect(operator.getByTestId("reply-routing-option-lead")).toHaveCount(1)
    await expect(operator.getByTestId("reply-promote-form"), "contract: present for data-routed-kind=unrouted").toBeVisible()

    await operatorCtx.close()
  })

  // ── /replies/:id: a stranger — no routing panel, no promote form ─────────

  test("GET /replies/:id for a stranger has no routing panel and no promote form", async ({ request, browser, baseURL }) => {
    const from = `${unique("stranger")}@example.test`
    const delivered = await deliver(request, {
      from, // bare address, no display name
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

    await expect(operator.getByTestId("reply-detail")).toHaveAttribute("data-routed-kind", "lead")
    await expect(
      operator.getByTestId("reply-sender-name"),
      "no display name was given — same optionality nameBlock() already gives a lead's own name",
    ).toHaveCount(0)

    const target = await operator.getByTestId("reply-route-target").innerText()
    expect(target, "contract: for the stranger case, reply-route-target names the LEAD-XXXXXX reference").toMatch(
      /LEAD-[A-Z0-9]{6}/,
    )

    await expect(
      operator.getByTestId("reply-route-runner-up"),
      "contract: absent on a stranger — no client match at all, nothing to be a runner-up to",
    ).toHaveCount(0)

    await expect(
      operator.getByTestId("reply-routing-toggle"),
      "contract: the routing disclosure is absent entirely on the stranger/lead case",
    ).toHaveCount(0)
    await expect(operator.getByTestId("reply-routing-form")).toHaveCount(0)
    await expect(
      operator.getByTestId("reply-promote-form"),
      "contract: absent for data-routed-kind=lead — a stranger's own promotion path is /leads/:id/promote",
    ).toHaveCount(0)

    await expect(operator.getByTestId("reply-approve-form")).toBeVisible()
    await expect(operator.getByTestId("reply-discard-form")).toBeVisible()

    await operatorCtx.close()
  })

  // ── the core behaviour: edit, approve, sends the edited text ─────────────

  test("editing the subject and body before approving sends the edited text, not the original", async ({
    request,
    browser,
    baseURL,
  }) => {
    const from = `${unique("edit")}@example.test`
    const client = insertClient(from)
    const project = insertProject({ clientId: client, customerEmail: from, name: `Edit Target ${unique("proj")}` })
    insertSubmission({ customerEmail: from, projectId: project })

    const delivered = await deliver(request, {
      from: `"Priya Shah" <${from}>`,
      subject: "About the timeline",
      messageId: `<${unique("msgid")}@example.test>`,
      body: "Just checking on the timeline for this.",
      extraHeaders: { "Authentication-Results": DMARC_PASS },
    })
    expect(delivered.disposition).toBe("received")
    const inbound = inboundRowById(delivered.id) as InboundRow
    expect(inbound.outbox_id, MIGRATION_HINT).not.toBeNull()
    const outboxId = inbound.outbox_id as string
    const before = outboxRowById(outboxId) as OutboxRow

    const operatorCtx = await asOperator(browser, baseURL)
    const operator = await operatorCtx.newPage()
    const path = await replyPathBySender(operator, from)
    await operator.goto(path)

    const subjectField = operator.getByTestId("reply-subject-field")
    const bodyField = operator.getByTestId("reply-body-field")
    expect(await subjectField.inputValue(), "the field's initial value is the drafted subject").toBe(before.subject)
    expect(await bodyField.inputValue(), "the field's initial value is the drafted body").toBe(before.body)

    const canary = `edited-by-operator-${unique("canary")}`
    const editedSubject = `Re: About the timeline (${canary})`
    const editedBody = `Edited reply body — ${canary}\n\n— John, Heuron Technology`

    await subjectField.fill(editedSubject)
    await bodyField.fill(editedBody)
    await operator.getByTestId("reply-approve-button").click()

    const after = outboxRowById(outboxId) as OutboxRow
    expect(after.approval_state, "EM-6's own table: Approve & send -> approval_state = 'approved'").toBe("approved")
    expect(after.subject, "issue #166 acceptance: \"sends the edited text, not the original\"").toBe(editedSubject)
    expect(after.body, "issue #166 acceptance: \"sends the edited text, not the original\"").toBe(editedBody)
    expect(after.approved_at, "EM-6's own table: stamps approved_at").not.toBeNull()
    expect(after.approved_by, "EM-6's own table: stamps approved_by").toBe(OPERATOR_EMAIL)
    expect(after.claimed_at, "EM-6's own table: clears claimed_at").toBeNull()

    // The next drain tick carries the EDITED text.
    await runDrain(request)
    const afterTick = outboxRowById(outboxId) as OutboxRow
    expect(afterTick.status, "EM-6's own table: the next cron tick (<=5 min) carries it").toBe("sent")

    const sentToThis = (await recordedEmails(request)).filter((e) => e.to === from)
    expect(sentToThis.length, "exactly one recorded send for this address").toBe(1)
    expect(sentToThis[0].subject).toBe(editedSubject)
    expect(sentToThis[0].text, "the recorded provider payload carries the EDITED body").toContain(canary)

    // No longer pending.
    await operator.goto("/replies")
    await expect(operator.getByTestId("reply-row").filter({ hasText: from })).toHaveCount(0)

    await operatorCtx.close()
  })

  // ── approving twice sends once ────────────────────────────────────────────

  test("approving twice sends once", async ({ request, browser, baseURL }) => {
    const from = `${unique("twice")}@example.test`
    const delivered = await deliver(request, {
      from,
      subject: "Quick one",
      messageId: `<${unique("msgid")}@example.test>`,
      body: "Following up on my earlier note.",
    })
    expect(delivered.disposition).toBe("received")
    const inbound = inboundRowById(delivered.id) as InboundRow
    expect(inbound.outbox_id, MIGRATION_HINT).not.toBeNull()
    const outboxId = inbound.outbox_id as string

    const operatorCtx = await asOperator(browser, baseURL)
    const operator = await operatorCtx.newPage()
    const path = await replyPathBySender(operator, from)
    await operator.goto(path)

    const firstSubject = `First approval ${unique("s1")}`
    await operator.getByTestId("reply-subject-field").fill(firstSubject)
    await operator.getByTestId("reply-approve-button").click()

    const afterFirst = outboxRowById(outboxId) as OutboxRow
    expect(afterFirst.approval_state).toBe("approved")
    expect(afterFirst.subject).toBe(firstSubject)
    const approvedAtFirst = afterFirst.approved_at

    // A second approve — a direct POST, simulating a double-click or a
    // retried request. The row is no longer `pending`, so this must be a
    // guarded no-op (contract: "Every write is guarded WHERE id = ? AND
    // approval_state = 'pending'... a double-click converges instead of
    // double-sending"), not an error.
    const second = await operatorCtx.request.post(`${path}/approve`, {
      form: { subject: "Second approval — should never land", body: "Different text entirely." },
      failOnStatusCode: false,
    })
    expect(second.status(), "a guarded no-op is not a server error").toBeLessThan(500)

    const afterSecond = outboxRowById(outboxId) as OutboxRow
    expect(
      afterSecond.subject,
      "contract's own guard convention: the second write must not land once approval_state left 'pending'",
    ).toBe(firstSubject)
    expect(afterSecond.approved_at, "a guarded no-op must not re-stamp approved_at").toBe(approvedAtFirst)

    await tickDrain(request, 3)
    const afterTicks = outboxRowById(outboxId) as OutboxRow
    expect(afterTicks.status).toBe("sent")

    const sentToThis = (await recordedEmails(request)).filter((e) => e.to === from)
    expect(sentToThis.length, "issue #166 acceptance: \"approving twice sends once\"").toBe(1)
    expect(sentToThis[0].subject).toBe(firstSubject)

    await operatorCtx.close()
  })

  // ── discard is terminal ───────────────────────────────────────────────────

  test("a discarded draft never sends however many ticks run, and approving it afterward is a guarded no-op", async ({
    request,
    browser,
    baseURL,
  }) => {
    const from = `${unique("discard")}@example.test`
    const delivered = await deliver(request, {
      from,
      subject: "Not needed after all",
      messageId: `<${unique("msgid")}@example.test>`,
      body: "Please cancel, never mind.",
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

    const afterDiscard = outboxRowById(outboxId) as OutboxRow
    expect(afterDiscard.approval_state, "EM-6's own table: Discard -> approval_state = 'rejected'. Terminal.").toBe(
      "rejected",
    )

    await tickDrain(request, 5)
    const afterTicks = outboxRowById(outboxId) as OutboxRow
    expect(afterTicks.status, "issue #166 acceptance: \"a discarded draft never sends however many ticks run\"").toBe(
      "queued",
    )
    expect(afterTicks.attempts).toBe(0)
    expect(afterTicks.sent_at).toBeNull()

    const sentToThis = (await recordedEmails(request)).filter((e) => e.to === from)
    expect(sentToThis.length, "a rejected draft is never handed to the provider").toBe(0)

    // Gone from the pending list immediately.
    await operator.goto("/replies")
    await expect(operator.getByTestId("reply-row").filter({ hasText: from })).toHaveCount(0)

    // The guard applies to every one of EM-6's actions — an approve POST
    // after a terminal discard must not resurrect the row.
    const approveAfter = await operatorCtx.request.post(`${path}/approve`, {
      form: { subject: "Too late", body: "Should never land." },
      failOnStatusCode: false,
    })
    expect(approveAfter.status(), "a guarded no-op is not a server error").toBeLessThan(500)
    const afterApproveAttempt = outboxRowById(outboxId) as OutboxRow
    expect(
      afterApproveAttempt.approval_state,
      "contract: the guard applies to all four actions — 'rejected' is terminal",
    ).toBe("rejected")

    await operatorCtx.close()
  })

  // ── Change route ──────────────────────────────────────────────────────────

  test('"Change route" re-targets an unrouted row to an operator-chosen project and keeps it pending', async ({
    request,
    browser,
    baseURL,
  }) => {
    const clientEmail = `${unique("route")}@example.test`
    const client = insertClient(clientEmail)
    const tiedTime = new Date(Date.now() - 30_000).toISOString()
    const projectA = insertProject({ clientId: client, customerEmail: clientEmail, name: `Alpha Retarget ${unique("a")}` })
    insertSubmission({ customerEmail: clientEmail, projectId: projectA, status: "describing", createdAt: tiedTime })
    const projectB = insertProject({ clientId: client, customerEmail: clientEmail, name: `Beta Retarget ${unique("b")}` })
    insertSubmission({ customerEmail: clientEmail, projectId: projectB, status: "describing", createdAt: tiedTime })

    const delivered = await deliver(request, {
      from: clientEmail,
      subject: "Following up",
      messageId: `<${unique("msgid")}@example.test>`,
      body: "Checking in on this.",
      extraHeaders: { "Authentication-Results": DMARC_PASS },
    })
    expect(delivered.disposition).toBe("received")
    const inbound = inboundRowById(delivered.id) as InboundRow
    expect(inbound.routed_kind, "sanity — depends on #163, already landed").toBe("unrouted")
    expect(inbound.outbox_id, MIGRATION_HINT).not.toBeNull()
    const outboxId = inbound.outbox_id as string

    const operatorCtx = await asOperator(browser, baseURL)
    const operator = await operatorCtx.newPage()
    const path = await replyPathBySender(operator, clientEmail)
    await operator.goto(path)

    const options = operator.getByTestId("reply-routing-option")
    await expect(options).toHaveCount(2)
    const first = options.first()
    const chosenTargetId = await first.getAttribute("data-target-id")
    expect([projectA, projectB]).toContain(chosenTargetId)

    await first.locator('input[type="radio"]').check()
    await operator.getByTestId("reply-routing-submit").click()

    const inboundAfter = inboundRowById(delivered.id) as InboundRow
    expect(
      inboundAfter.routed_project_id,
      '"Change route" re-targets to an operator-chosen ... project (contract §  /replies/:id/route)',
    ).toBe(chosenTargetId)

    const afterRoute = outboxRowById(outboxId) as OutboxRow
    expect(afterRoute.approval_state, "EM-6's own words: \"stay pending\"").toBe("pending")

    // Still pending, still findable on the list.
    await operator.goto("/replies")
    await expect(operator.getByTestId("reply-row").filter({ hasText: clientEmail })).toHaveCount(1)

    await operatorCtx.close()
  })
})
