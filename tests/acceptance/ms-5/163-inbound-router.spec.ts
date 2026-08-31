import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { expect, test, type APIRequestContext } from "@playwright/test"

/**
 * ms-5 sealed acceptance slice — issue #163
 * "[portal] EM-3: the inbound router — exact keys first, heuristics last,
 *  guessing never"
 *
 * Written from `tests/acceptance/ms-5/contract.md` (§ "The router ladder —
 * full six rungs", § "Schema — inbound_emails", § "Ownership") and issue
 * #163's own text, without sight of any implementation.
 *
 * ── WHAT #163 OWNS, AND WHAT THIS SLICE THEREFORE COVERS ────────────────────
 *
 * #163's own Scope: "The router: given a parsed inbound message, decide where
 * it belongs. **Writes nothing.** A pure exported function... Files:
 * `src/inboundRouter.ts` (new) · `test/inboundRouter.test.ts` (new)." That
 * unit-tested-in-isolation surface is `test/`'s own job (README's testing
 * table: `test/` is vitest, written by the implementing engineer, and is not
 * the sealed acceptance bar) — this slice cannot import `src/inboundRouter.ts`
 * without ceasing to be black-box.
 *
 * ── WHY THIS SLICE HAS ANY BLACK-BOX SURFACE AT ALL ──────────────────────────
 *
 * Despite "writes nothing," contract § "Schema — inbound_emails" pins three
 * of `inbound_emails`' own columns as "Set by EM-3": `routed_rung`,
 * `routed_reason`, `routed_runner_up`. That attribution is specific (the same
 * table separately attributes `routed_project_id` to "EM-5, or
 * `/replies/:id/route`" and `routed_lead_id` to "EM-4" — different issues,
 * named individually), so this slice reads it literally: issue #163's own
 * implementation is the thing that, immediately after a message is received
 * through `POST /__email` (#161's own door, already sealed and landed), runs
 * the ladder and persists its own three columns onto the row — independent of
 * #164 (the draft template) and #165 (the matched thread / unrouted parking),
 * which are dispatched separately and consume, not produce, this decision.
 * `routed_kind`, `routed_lead_id`, `routed_project_id`, `outbox_id` and every
 * `promoted_*` column are deliberately **not** asserted anywhere below — their
 * "Set by" issues are #164/#165/#167, not this one.
 *
 * `#163`'s own Files list also names "adds no write path to any of
 * [`src/clients.ts`, `src/projects.ts`, `src/submissions.ts`]" — consistent
 * with this reading: it *reads* client/project/submission state to decide,
 * and writes only its own three `inbound_emails` columns, never touching
 * those other tables.
 *
 * ── WHY THIS SLICE SEEDS `clients`/`projects`/`submissions`/`leads` DIRECTLY ─
 *
 * The only HTTP paths that produce a `clients` row with a linked `projects`
 * row (`/start` → `POST /leads/:id/promote`, ms-2/ms-4's own surface) sit in
 * an *earlier*, already-shipped milestone this slice has no reason to
 * re-drive end-to-end just to get a fixture — doing so would make this
 * slice's own success depend on ms-4's UI mechanics staying exactly as they
 * are, for no benefit over seeding the same tables this contract already
 * names by column (`clients(id, email, cc_emails, ...)`, `projects(id,
 * customer_email, client_id, name, ...)`, `submissions(id, reference, status,
 * customer_email, project_id, ...)`, `leads(id, reference, email, ...)` —
 * 0016/0012/0002/0005's own committed schemas). Same posture, and same
 * justification, `ms-5/162-outbox-approval.spec.ts` already took for seeding
 * `outbox` rows directly: standing in for a write path this issue does not
 * itself add, with isolation from every sibling slice via a unique synthetic
 * address/reference per test.
 *
 * ── NOT COVERED HERE, AND WHY ────────────────────────────────────────────────
 *  - **The exact wording of `routed_reason`.** Contract: "Exact wording not
 *    pinned... a test may assert non-emptiness and, for rungs 1–3, that the
 *    reason names the mechanism... rather than a vague placeholder." This
 *    slice only asserts non-emptiness and a minimum length, to avoid pinning
 *    a phrasing the contract explicitly declines to pin.
 *  - **Which of `routed_project_id`/`routed_lead_id`/`outbox_id` a message
 *    resolves to.** Other issues' own columns — see above.
 *  - **`getClientRecordByEmail`'s case-insensitivity.** Already-shipped
 *    (#128) behaviour this router reads, not #163's own new surface; not
 *    called out in #163's own acceptance bullet list.
 *  - **Rung 4/5 tie-breaking by word overlap specifically** (as opposed to
 *    the waiting-on-customer / recency axes). Covered exhaustively by
 *    #163's own unit tests (`test/inboundRouter.test.ts`, not this suite);
 *    this slice proves only that a genuine three-way tie never gets guessed.
 *
 * SYNTHETIC DATA. Per CLAUDE.md rule 1 and contract § "Synthetic data", every
 * address, name, subject and body below is invented on the reserved
 * `example.test` TLD — never the real `intake@heurontech.com` /
 * `mail.heurontech.com` domains this milestone actually wires up.
 */

test.describe.configure({ timeout: 120_000 })

// ── the repository, as a schema surface (mirrors ms-4/128, ms-5/161, ms-5/162)

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
  changes: number | null
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
    const first = parsed[0] as { results?: Record<string, unknown>[]; meta?: { changes?: number } } | undefined
    return { ok: true, rows: first?.results ?? [], changes: first?.meta?.changes ?? null, error: null }
  }
  const failure = parsed as { error?: { text?: string } }
  return { ok: false, rows: [], changes: null, error: failure.error?.text ?? JSON.stringify(parsed) }
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''")
}

let counter = 0
/** A unique, synthetic label — every row this slice writes owns its own. */
function unique(label: string): string {
  counter += 1
  return `ms5-163-${label}-${Date.now()}-${counter}`
}

function randomToken(n = 6): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
  let s = ""
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)]
  return s
}

const SEED_HINT =
  "issue #163 adds `src/inboundRouter.ts` and wires it into inbound processing so that, right " +
  "after a message reaches `POST /__email`, `inbound_emails.routed_rung`/`routed_reason`/" +
  "`routed_runner_up` are filled in — this slice's own fixture-seeding write failed, which means " +
  "the schema it depends on (clients/projects/submissions/leads, all from earlier, already-shipped " +
  "milestones) is missing, not a #163 defect"

// ── seeding clients / projects / submissions / leads directly ───────────────

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

function insertProject(opts: { clientId?: string; customerEmail: string; name?: string; createdAt?: string }): string {
  const id = `project-${unique("project")}`
  const now = opts.createdAt ?? new Date().toISOString()
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
    opts.status ?? "describing",
    opts.customerEmail,
    "Synthetic outcome text for the ms-5 #163 acceptance fixture.",
    "Synthetic audience for the ms-5 #163 acceptance fixture.",
    "Synthetic done-definition for the ms-5 #163 acceptance fixture.",
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

function insertLead(email: string, reference?: string): { id: string; reference: string } {
  const id = `lead-${unique("lead")}`
  const ref = reference ?? `LEAD-${randomToken()}`
  const now = new Date().toISOString()
  const r = d1(
    `INSERT INTO leads (id, reference, summary, email, created_at) VALUES ` +
      `('${escapeSql(id)}', '${escapeSql(ref)}', 'Synthetic lead summary for the ms-5 #163 ` +
      `acceptance fixture.', '${escapeSql(email)}', '${escapeSql(now)}')`,
  )
  expect(r.ok, `seeding a synthetic lead failed (${SEED_HINT}). SQLite said: ${r.error}`).toBe(true)
  return { id, reference: ref }
}

function countWhere(table: string, column: string, value: string): number {
  const q = d1(`SELECT COUNT(*) as n FROM ${table} WHERE ${column} = '${escapeSql(value)}'`)
  if (!q.ok) return -1
  return Number((q.rows[0] as { n: unknown } | undefined)?.n ?? -1)
}

// ── the inbound test door (mirrors ms-5/161-inbound-seam.spec.ts) ───────────

const EMAIL_DOOR = "/__email"

const DOOR_UNAVAILABLE =
  `ms-5 issue #163 cannot be observed at all: \`POST ${EMAIL_DOOR}\` did not answer with the ` +
  "pinned `{id, disposition}` JSON shape. This door is issue #161's own, already sealed and " +
  "landed — a failure here points at the acceptance environment, not at #163."

interface RawMessageOpts {
  from: string
  to?: string
  subject: string
  messageId?: string | null
  body: string
  extraHeaders?: Record<string, string>
}

function buildRawMessage(opts: RawMessageOpts): string {
  const headers: string[] = []
  headers.push(`From: ${opts.from}`)
  if (opts.to) headers.push(`To: ${opts.to}`)
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

// DMARC-pass / DMARC-fail headers, shaped as Zoho's own forward would stamp
// them (contract § "`/replies` — pinned `data-testid` hooks", `reply-auth-result`
// topology note) — same convention `ms-5/161-inbound-seam.spec.ts` establishes.
const DMARC_PASS = "mx.zohomail.com; dmarc=pass header.from=example.test"
const DMARC_FAIL = "mx.zohomail.com; dmarc=fail header.from=example.test"

// ── reading the routing decision back, read-only ─────────────────────────────

interface RoutedRow {
  id: string
  routed_rung: number | null
  routed_reason: string | null
  routed_runner_up: string | null
}

function routingById(id: string): RoutedRow | null {
  const q = d1(
    `SELECT id, routed_rung, routed_reason, routed_runner_up FROM inbound_emails WHERE id = '${escapeSql(id)}'`,
  )
  if (!q.ok || q.rows.length === 0) return null
  return q.rows[0] as unknown as RoutedRow
}

/**
 * Deliver `raw` and return the row's own routing decision. Fails immediately,
 * with `SEED_HINT`/`DOOR_UNAVAILABLE` context, if the door itself did not
 * behave — every rung test below builds on this.
 */
async function deliverAndRoute(
  request: APIRequestContext,
  envelopeTo: string,
  envelopeFrom: string,
  raw: string,
): Promise<RoutedRow> {
  const result = await postEmail(request, envelopeTo, envelopeFrom, raw)
  expect(result.status, `${DOOR_UNAVAILABLE} (got HTTP ${result.status}, body: ${result.text})`).toBe(200)
  expect(result.body, `${DOOR_UNAVAILABLE} (body was not JSON: ${result.text})`).not.toBeNull()
  const body = result.body as DoorResponse
  expect(typeof body.id, "the pinned response carries a non-empty id").toBe("string")

  const row = routingById(body.id as string)
  expect(row, `no inbound_emails row was found for id ${JSON.stringify(body.id)}`).not.toBeNull()
  return row as RoutedRow
}

/**
 * `routed_reason` is pinned "non-empty, human-readable... exact wording not
 * pinned" — this slice checks structure (present, not a placeholder), never a
 * specific phrase.
 */
function expectHumanReadableReason(reason: string | null, context: string): void {
  expect(reason, `${context}: routed_reason must be populated once #163 lands`).not.toBeNull()
  const trimmed = (reason ?? "").trim()
  expect(trimmed.length, `${context}: routed_reason must be human-readable, not a placeholder`).toBeGreaterThan(10)
  expect(
    ["n/a", "unknown", "-", "none", "todo"].includes(trimmed.toLowerCase()),
    `${context}: routed_reason ("${trimmed}") reads like a placeholder, not a reason`,
  ).toBe(false)
}

// ═══════════════════════════════════════════════════════════════════════════

test.describe("ms-5 issue 163 the inbound router", () => {
  // ── rung 1 — envelope recipient plus-address ────────────────────────────

  test("rung 1 — a plus-addressed envelope recipient beats a contradictory sender identity", async ({
    request,
  }) => {
    const targetOwner = `${unique("target-owner")}@example.test`
    const target = insertSubmission({ customerEmail: targetOwner })

    // The sender is a DIFFERENT, unrelated person who also happens to be a
    // known client with their own single project — if rung 1 were skipped in
    // favour of sender-identity rungs, this message would incorrectly match
    // the impersonator's own project (rung 3) instead of the plus-addressed
    // submission.
    const impersonatorEmail = `${unique("impersonator")}@example.test`
    const impersonatorClient = insertClient(impersonatorEmail)
    insertProject({ clientId: impersonatorClient, customerEmail: impersonatorEmail, name: "Impersonator Project" })

    const to = `intake+${target.reference}@mail.example.test`
    const raw = buildRawMessage({
      from: `"Impersonator" <${impersonatorEmail}>`,
      subject: "Quick question",
      body: "Just wanted to check in.",
      // Contract: "Rung 1 ... [is] not gated on authentication" — a DMARC
      // FAIL here still must not stop rung 1 from firing.
      extraHeaders: { "Authentication-Results": DMARC_FAIL },
    })

    const row = await deliverAndRoute(request, to, impersonatorEmail, raw)
    expect(
      row.routed_rung,
      "contract § \"The router ladder\", rung 1: the envelope's own plus-addressed reference wins " +
        "even though the sender address independently resolves to a different known client",
    ).toBe(1)
    expectHumanReadableReason(row.routed_reason, "rung 1")
    expect(
      row.routed_runner_up,
      "rung 1 is an exact match — contract: \"absent on an exact-match rung (1–3) ... there is " +
        "nothing to be a runner-up to\"",
    ).toBeNull()
  })

  // ── rung 2 — a reference quoted in the subject or body ──────────────────

  test("rung 2 — a LEAD-XXXXXX reference quoted in the body routes to that lead", async ({ request }) => {
    const leadEmail = `${unique("lead-owner")}@example.test`
    const lead = insertLead(leadEmail)

    const to = `intake@mail.example.test` // no plus-address — rung 1 must not fire
    const raw = buildRawMessage({
      from: leadEmail,
      subject: "One more thing",
      body:
        "Just adding a note to my earlier message.\n\n" +
        `> Thanks for reaching out! Your reference is ${lead.reference} — quote it in any reply.`,
      // Contract: rung 2 is "not gated on authentication" either.
      extraHeaders: { "Authentication-Results": DMARC_FAIL },
    })

    const row = await deliverAndRoute(request, to, leadEmail, raw)
    expect(
      row.routed_rung,
      `contract § "The router ladder", rung 2: a ${lead.reference} reference "anywhere including ` +
        "the quoted original\" must be found and routed",
    ).toBe(2)
    expectHumanReadableReason(row.routed_reason, "rung 2 (body)")
    expect(row.routed_runner_up, "rung 2 is an exact match — no runner-up").toBeNull()
  })

  test("rung 2 — a SUB-XXXXXX reference quoted in the subject line also routes there", async ({ request }) => {
    const owner = `${unique("sub-owner")}@example.test`
    const target = insertSubmission({ customerEmail: owner })

    const to = `intake@mail.example.test`
    const raw = buildRawMessage({
      from: owner,
      subject: `Re: ${target.reference} — a follow-up question`,
      body: "Any update on timing?",
    })

    const row = await deliverAndRoute(request, to, owner, raw)
    expect(
      row.routed_rung,
      `contract § "The router ladder", rung 2: "${target.reference} ... anywhere including" the ` +
        "subject line must route there",
    ).toBe(2)
    expectHumanReadableReason(row.routed_reason, "rung 2 (subject)")
  })

  // ── rung 3 — known client, one project, matched via cc_emails ───────────

  test("rung 3 — a cc_emails match resolves a single-project known client", async ({ request }) => {
    const primaryEmail = `${unique("primary")}@example.test`
    const ccEmail = `${unique("cc")}@example.test`
    const client = insertClient(primaryEmail, ccEmail)
    const project = insertProject({ clientId: client, customerEmail: primaryEmail, name: "Solo Project" })
    insertSubmission({ customerEmail: primaryEmail, projectId: project })

    const to = "intake@mail.example.test"
    const raw = buildRawMessage({
      from: ccEmail, // the cc address, NOT the client's own primary email
      subject: "Checking in",
      body: "How is this coming along?",
      extraHeaders: { "Authentication-Results": DMARC_PASS },
    })

    const row = await deliverAndRoute(request, to, ccEmail, raw)
    expect(
      row.routed_rung,
      "contract § \"The router ladder\", rung 3: \"getClientRecordByEmail ... plus clients.cc_emails\"",
    ).toBe(3)
    expectHumanReadableReason(row.routed_reason, "rung 3")
    expect(row.routed_runner_up, "rung 3 is an exact match — no runner-up").toBeNull()
  })

  // ── rung 4 — known client, several projects, scored ─────────────────────

  test("rung 4 — a two-project client where one is awaiting sign-off wins over a merely more recent one", async ({
    request,
  }) => {
    const clientEmail = `${unique("multi")}@example.test`
    const client = insertClient(clientEmail)

    const loserToken = randomToken()
    const winnerToken = randomToken()

    const olderTime = new Date(Date.now() - 60_000).toISOString()
    const newerTime = new Date(Date.now() - 1_000).toISOString()

    // The NOT-waiting project is the MORE RECENT one — a naive
    // "most-recent-wins" implementation would pick this one, which is
    // exactly the bug this test is built to catch.
    const loserProject = insertProject({
      clientId: client,
      customerEmail: clientEmail,
      name: `Loser Marker ${loserToken}`,
    })
    insertSubmission({ customerEmail: clientEmail, projectId: loserProject, status: "describing", createdAt: newerTime })

    // The waiting-on-customer project is OLDER but must still win — contract:
    // "a project whose newest submission is in a state waiting on the
    // customer ... beats one that is not; THEN most recent activity."
    const winnerProject = insertProject({
      clientId: client,
      customerEmail: clientEmail,
      name: `Winner Marker ${winnerToken}`,
    })
    insertSubmission({
      customerEmail: clientEmail,
      projectId: winnerProject,
      status: "awaiting-signoff",
      createdAt: olderTime,
    })

    const to = "intake@mail.example.test"
    const raw = buildRawMessage({
      from: clientEmail,
      subject: "Any news?", // no overlap with either project's name
      body: "Following up on where things stand.",
      extraHeaders: { "Authentication-Results": DMARC_PASS },
    })

    const row = await deliverAndRoute(request, to, clientEmail, raw)
    expect(
      row.routed_rung,
      "contract § \"The router ladder\", rung 4: a known client with several projects is scored, " +
        "not an exact match",
    ).toBe(4)
    expectHumanReadableReason(row.routed_reason, "rung 4")
    expect(
      row.routed_runner_up,
      "contract: routed_runner_up is present \"where rung 4 scored more than one candidate\"",
    ).not.toBeNull()
    expect(
      row.routed_runner_up,
      `the LOSING project (not waiting on the customer, merely more recent) is the one that should ` +
        `appear as the runner-up — looked for its marker "${loserToken}"`,
    ).toContain(loserToken)
    expect(
      row.routed_runner_up,
      "the WINNING project's own marker should not itself be reported as the runner-up",
    ).not.toContain(winnerToken)
  })

  test("rung 4 → 6 — an exact tie between two equally-weighted projects falls to unrouted, never guessed", async ({
    request,
  }) => {
    const clientEmail = `${unique("tied")}@example.test`
    const client = insertClient(clientEmail)
    const tiedTime = new Date(Date.now() - 30_000).toISOString()

    // Same status (neither waiting on the customer), same recency, and
    // neither project's name overlaps at all with the subject below — a
    // genuine three-way tie across every scoring axis the contract pins.
    const projectA = insertProject({ clientId: client, customerEmail: clientEmail, name: "Zeta Program" })
    insertSubmission({ customerEmail: clientEmail, projectId: projectA, status: "describing", createdAt: tiedTime })

    const projectB = insertProject({ clientId: client, customerEmail: clientEmail, name: "Omega Program" })
    insertSubmission({ customerEmail: clientEmail, projectId: projectB, status: "describing", createdAt: tiedTime })

    const to = "intake@mail.example.test"
    const raw = buildRawMessage({
      from: clientEmail,
      subject: "Following up on things",
      body: "Just checking in.",
      extraHeaders: { "Authentication-Results": DMARC_PASS },
    })

    const row = await deliverAndRoute(request, to, clientEmail, raw)
    expect(
      row.routed_rung,
      "contract § \"The router ladder\": \"A tie is not a winner — it falls to rung 6 as unrouted.\" " +
        "This must NOT be reported as rung 4, and must not silently pick projectA or projectB.",
    ).toBe(6)
    expectHumanReadableReason(row.routed_reason, "rung 4 tie → rung 6")
    expect(
      row.routed_runner_up,
      "contract: runner-up is present for both \"rung 4's scoring case, and the unrouted case\" — " +
        "this is a KNOWN client (unlike a total stranger, rung 6's other flavour, where runner-up " +
        "is absent), so there is something to be a runner-up to",
    ).not.toBeNull()
  })

  // ── rung 5 — historical customer_email, no clients row ──────────────────

  test("rung 5 — a historical customer_email match with no clients row resolves via address, then scores", async ({
    request,
  }) => {
    const historicalEmail = `${unique("historical")}@example.test`
    // Deliberately NO `insertClient` call — 0016's own words: "0016
    // deliberately backfilled nothing, so historical rows carry a bare
    // customer_email with client_id IS NULL."
    const project = insertProject({ customerEmail: historicalEmail, name: "Historical Project" })
    insertSubmission({ customerEmail: historicalEmail, projectId: project, status: "describing" })

    expect(countWhere("clients", "email", historicalEmail), "this fixture must have no clients row").toBe(0)

    const to = "intake@mail.example.test"
    const raw = buildRawMessage({
      from: historicalEmail,
      subject: "Still there?",
      body: "Wanted to follow up on my earlier project.",
      extraHeaders: { "Authentication-Results": DMARC_PASS },
    })

    const row = await deliverAndRoute(request, to, historicalEmail, raw)
    expect(
      row.routed_rung,
      "contract § \"The router ladder\", rung 5: a bare customer_email with no clients row still " +
        "resolves, by address, when there is exactly one such project",
    ).toBe(5)
    expectHumanReadableReason(row.routed_reason, "rung 5")

    // Rung 5 matching must not itself invent a `clients` row — that is not
    // this router's job (#163 "adds no write path to ... clients.ts"), and no
    // sibling issue's own text asks for a backfill here either.
    expect(
      countWhere("clients", "email", historicalEmail),
      "rung 5 matching a historical row must not create a clients row as a side effect",
    ).toBe(0)
  })

  // ── DMARC gating on rungs 3–5 ────────────────────────────────────────────

  test("a DMARC-fail message from a known client's address falls to unrouted rather than matching them", async ({
    request,
  }) => {
    const clientEmail = `${unique("dmarcfail")}@example.test`
    const client = insertClient(clientEmail)
    const project = insertProject({ clientId: client, customerEmail: clientEmail, name: "Gated Project" })
    insertSubmission({ customerEmail: clientEmail, projectId: project })

    const to = "intake@mail.example.test"
    const raw = buildRawMessage({
      from: clientEmail,
      subject: "Checking in",
      body: "Any news?",
      extraHeaders: { "Authentication-Results": DMARC_FAIL },
    })

    const row = await deliverAndRoute(request, to, clientEmail, raw)
    expect(
      row.routed_rung,
      "contract § \"The router ladder\": \"rungs 3, 4 and 5 ... only fire when EM-1 recorded a " +
        "DMARC pass. Anything else falls to rung 6\" — a DMARC FAIL from a real client's own " +
        "address must not resolve via rung 3, even though the address matches exactly.",
    ).toBe(6)
    expectHumanReadableReason(row.routed_reason, "DMARC-fail known-client fallback")
  })

  // ── rung 6 — a total stranger, no client match at all ───────────────────

  test("rung 6 — nobody we know at all falls to the default, with no runner-up to speak of", async ({
    request,
  }) => {
    const strangerEmail = `${unique("stranger")}@example.test`

    const to = "intake@mail.example.test"
    const raw = buildRawMessage({
      from: strangerEmail,
      subject: "Hello, interested in your services",
      body: "I found your site and wanted to ask about a project.",
      extraHeaders: { "Authentication-Results": DMARC_PASS },
    })

    const row = await deliverAndRoute(request, to, strangerEmail, raw)
    expect(
      row.routed_rung,
      "contract § \"The router ladder\", rung 6: \"Nobody we know ... → a lead. The default.\"",
    ).toBe(6)
    expectHumanReadableReason(row.routed_reason, "rung 6 stranger")
    expect(
      row.routed_runner_up,
      "contract: \"absent ... [for] a stranger (rung 6, no client at all) — there is nothing to be " +
        "a runner-up to\"",
    ).toBeNull()
  })
})
