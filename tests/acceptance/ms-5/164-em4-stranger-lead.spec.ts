import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test"

/**
 * ms-5 sealed acceptance slice — issue #164
 * "[portal] EM-4: an email from a stranger becomes a lead, with a drafted
 *  acknowledgement"
 *
 * Written from `tests/acceptance/ms-5/contract.md` (§ "The router ladder —
 * full six rungs" rung 6, § "Schema — inbound_emails" (`routed_lead_id`,
 * `outbox_id`), § "The templated reply — pinned invariants (issue #164...)",
 * § "Ownership") and issue #164's own text, without sight of any
 * implementation.
 *
 * ── WHAT #164 OWNS, AND WHAT THIS SLICE THEREFORE COVERS ────────────────────
 *
 * #164's own Scope: "Wire EM-3's rung 6 — nobody we know — and draft the
 * acknowledgement." Three things, quoted:
 *
 *   1. "Create the lead by calling `createLead()` in `src/leads.ts`. Not a
 *      copy of it, not a variant: the *same function* `POST /start` calls,
 *      producing the same inert row on the same triage screen, promotable by
 *      the same button." — `summary` from the (already EM-1-capped) message
 *      body, `email` from the sender, `name` from the `From:` header's
 *      display name or `null`.
 *   2. "Record the link on the `inbound_emails` row (which lead it
 *      produced)" — `routed_lead_id`.
 *   3. "Draft the reply into `outbox` with `email_type = 'intake-reply'` and
 *      `approval_state = 'pending'`" via a *new* enqueue function — and
 *      `outbox_id` recorded back onto the `inbound_emails` row.
 *
 * Plus the template invariants issue #164's own text pins directly (never
 * quotes the sender's message, never discloses state, carries the
 * `LEAD-XXXXXX` reference "the way `/start`'s own receipt does"), and the
 * idempotency guarantee ("an inbound message that is processed twice must
 * produce one lead and one draft").
 *
 * ── WHY THIS SLICE NEVER SEEDS ANYTHING DIRECTLY ────────────────────────────
 *
 * Unlike `ms-5/162` and `ms-5/163` (which stand in for a write path *later*
 * issues add), #164 IS the write path for the rung-6-stranger case — the one
 * thing this slice must never do is insert a `leads` or `outbox` row itself,
 * because that would be testing this slice's own fixture instead of #164's
 * code. Every row this file inspects is produced through the real
 * `POST /__email` door (#161, already sealed and landed) and read back
 * read-only, the same posture `ms-5/161-inbound-seam.spec.ts` established.
 *
 * ── WHY THIS SLICE DOES NOT ALSO DRIVE A CONTROL LEAD THROUGH `POST /start` ──
 *
 * "Byte-identical in shape to one `/start` produces" is proven here by
 * exercising the *same* rendering code a `/start`-sourced lead already goes
 * through — `/leads`' `lead-row`/`review-lead` hooks, `/leads/:id`'s
 * `lead-detail`/`lead-reference`/`lead-summary-full`/`lead-contact-email`/
 * `lead-name`/`promote-lead-form` hooks, and the promotion route itself —
 * rather than by seeding a second lead through `/start` (which would also
 * require solving #32's Turnstile bot gate) and diffing the two rows
 * byte-for-byte. Since `createLead`/`listLeads`/`getLead`/`promoteLead` are
 * shared, unconditional code with no branch on where a lead came from, a
 * `/start`-sourced lead rendering correctly (already sealed by
 * `tests/acceptance/ms-2/33-lead-triage-promotion.spec.ts` and
 * `tests/acceptance/ms-4/132-start-work-override.spec.ts`) plus an
 * email-sourced lead rendering identically through that same code is the
 * whole of what "byte-identical in shape" can mean for two rows in one table
 * rendered by one function.
 *
 * ── NOT COVERED HERE, AND WHY ────────────────────────────────────────────────
 *  - **`/replies`, `/replies/:id` and its four actions (#166).** No mock and
 *    no issue text for this milestone's own one new screen belongs to #164;
 *    every assertion below that needs to read the drafted subject/body reads
 *    it through `GET /outbox` (ms-1's own sealed customer surface,
 *    unconditionally scoped to the caller's own `to_email` — this milestone
 *    adds no new route that could leak it instead) or directly from the
 *    migrated D1, never a route `/replies` itself owns.
 *  - **The router ladder's own rung/reason/runner-up values** (#163, already
 *    sealed by `ms-5/163-inbound-router.spec.ts`). This slice reads
 *    `routed_kind`/`routed_rung` only as a sanity check that the rung-6
 *    stranger decision it depends on is actually reaching this row, not as a
 *    fresh assertion of #163's own behaviour.
 *  - **The exact cap applied to `summary`.** Issue #164: "capped per EM-1" —
 *    this slice checks `leads.summary` equals the (already-capped)
 *    `inbound_emails.body_text` for an ordinary short message, not a fresh
 *    16,000-character boundary (`ms-5/161`'s own "an oversized body is
 *    stored truncated and flagged" test already owns that boundary).
 *  - **The exact `cta_href`/`cta_text` of a stranger's drafted reply.**
 *    Contract's own Notes: "the acknowledgement for a stranger names no URL a
 *    browser could follow, only the `LEAD-XXXXXX` reference to quote back" —
 *    but `outbox.cta_href` is `NOT NULL` and no mock or issue text gives a
 *    concrete value for this case. TODO(test-author): this slice asserts the
 *    drafted body never *names* a URL and always carries the reference, but
 *    does not pin what `cta_href`/`cta_text` themselves contain.
 *  - **Rate limiting (#169) and attachments (#169).** Different issue,
 *    dispatched separately; not exercised here.
 *  - **`Reply-To` on the drafted reply itself (#168).** #168's own scope is
 *    outbound mail carrying a `Reply-To` bearing *its own* submission
 *    reference — a stranger's acknowledgement has no submission to reference,
 *    and the contract's own § "Reply-To on outbound mail" never names
 *    intake-reply drafts as a case it covers.
 *
 * SYNTHETIC DATA. Per CLAUDE.md rule 1 and contract § "Synthetic data", every
 * address, name and message body below is invented on the reserved
 * `example.test` TLD — never the real `intake@heurontech.com` /
 * `mail.heurontech.com` domains this milestone actually wires up.
 */

test.describe.configure({ timeout: 120_000 })

// ── the repository, as a schema surface (mirrors ms-5/161, ms-5/162, ms-5/163) ─

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
      `${process.cwd()} — this slice reads the migrated local D1, read-only`,
  )
}

interface D1Query {
  ok: boolean
  rows: Record<string, unknown>[]
  error: string | null
}

/**
 * Ask the migrated local D1 a read-only question. Identical mechanism to
 * `ms-5/161-inbound-seam.spec.ts`'s own `d1()` — every row this slice
 * inspects was created through the real `POST /__email` or
 * `POST /leads/:id/promote` surface, never inserted directly.
 */
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

function countWhere(table: string, column: string, value: string): number {
  const q = d1(`SELECT COUNT(*) as n FROM ${table} WHERE ${column} = '${escapeSql(value)}'`)
  if (!q.ok) return -1
  return Number((q.rows[0] as { n: unknown } | undefined)?.n ?? -1)
}

let counter = 0
/** A unique, synthetic local-part — every test in this slice owns its own address. */
function unique(label: string): string {
  counter += 1
  return `ms5-164-${label}-${Date.now()}-${counter}`
}

// ── the inbound test door (mirrors ms-5/161, ms-5/163) ──────────────────────

const EMAIL_DOOR = "/__email"

const DOOR_UNAVAILABLE =
  `ms-5 issue #164 cannot be observed at all: \`POST ${EMAIL_DOOR}\` did not answer with the ` +
  "pinned `{id, disposition}` JSON shape. This door is #161's own, already sealed and landed — a " +
  "failure here means the acceptance environment itself is broken, not a #164 defect."

interface RawMessageOpts {
  from: string
  subject: string
  messageId: string | null
  body: string
}

/**
 * A minimal, valid RFC 822 blob, mirroring `ms-5/161-inbound-seam.spec.ts`'s
 * own `buildRawMessage`. No `Authentication-Results` header is set anywhere
 * in this slice — every message here is a genuine stranger (rungs 3-5 never
 * fire for an address with no `clients`/historical `submissions` row
 * regardless of DMARC, so `auth_result` is irrelevant to which rung a
 * stranger's message reaches).
 */
function buildRawMessage(opts: RawMessageOpts): string {
  const headers: string[] = []
  headers.push(`From: ${opts.from}`)
  headers.push(`To: intake@mail.example.test`) // informational only
  headers.push(`Subject: ${opts.subject}`)
  if (opts.messageId) headers.push(`Message-ID: ${opts.messageId}`)
  headers.push(`Date: ${new Date().toUTCString()}`)
  headers.push("MIME-Version: 1.0")
  headers.push("Content-Type: text/plain; charset=utf-8")
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

async function postEmail(request: APIRequestContext, raw: string, opts: { messageId: string | null; from: string }): Promise<DoorResult> {
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
  opts: { from: string; subject: string; messageId: string | null; body: string },
): Promise<{ id: string; disposition: string }> {
  const raw = buildRawMessage({ from: opts.from, subject: opts.subject, messageId: opts.messageId, body: opts.body })
  const result = await postEmail(request, raw, { messageId: opts.messageId, from: opts.from })
  expect(result.status, `${DOOR_UNAVAILABLE} (got HTTP ${result.status}, body: ${result.text})`).toBe(200)
  expect(result.body, `${DOOR_UNAVAILABLE} (body was not JSON: ${result.text})`).not.toBeNull()
  const body = result.body as DoorResponse
  expect(typeof body.id, "the pinned response carries a non-empty id").toBe("string")
  return { id: body.id as string, disposition: String(body.disposition) }
}

// ── reading rows back, read-only ─────────────────────────────────────────────

interface InboundRow {
  id: string
  from_email: string
  from_name: string | null
  body_text: string
  disposition: string
  routed_kind: string | null
  routed_rung: number | null
  routed_lead_id: string | null
  routed_project_id: string | null
  outbox_id: string | null
}

function inboundRowById(id: string): InboundRow | null {
  const q = d1(`SELECT * FROM inbound_emails WHERE id = '${escapeSql(id)}'`)
  if (!q.ok || q.rows.length === 0) return null
  return q.rows[0] as unknown as InboundRow
}

interface LeadRow {
  id: string
  reference: string
  summary: string
  email: string
  name: string | null
  created_at: string
  promoted_at: string | null
}

function leadRowById(id: string): LeadRow | null {
  const q = d1(`SELECT * FROM leads WHERE id = '${escapeSql(id)}'`)
  if (!q.ok || q.rows.length === 0) return null
  return q.rows[0] as unknown as LeadRow
}

interface OutboxRow {
  id: string
  email_type: string
  to_email: string
  approval_state: string
  approved_at: string | null
  approved_by: string | null
  status: string
  attempts: number
  sent_at: string | null
  body: string
}

function outboxRowById(id: string): OutboxRow | null {
  const q = d1(`SELECT * FROM outbox WHERE id = '${escapeSql(id)}'`)
  if (!q.ok || q.rows.length === 0) return null
  return q.rows[0] as unknown as OutboxRow
}

const MIGRATION_HINT =
  "issues #161/#162/#163 (already landed) provide the schema and routing this slice depends on; " +
  "a failure locating the expected row past `POST /__email` succeeding means #164's own createLead " +
  "+ enqueue wiring has not landed yet"

// ── the drain trigger (mirrors ms-5/162-outbox-approval.spec.ts) ────────────

const DRAIN = "/__scheduled"

async function runDrain(request: APIRequestContext): Promise<void> {
  const res = await request.get(DRAIN)
  expect(res.ok(), `GET ${DRAIN} (ms-3 issue #50, already sealed) should answer 2xx`).toBe(true)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Fire the drain a fixed number of times — a NEGATIVE wait ("never sent, however many ticks run"). */
async function tickDrain(request: APIRequestContext, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    await runDrain(request)
    await sleep(500)
  }
}

// ── operator + customer identity (mirrors ms-4/132-start-work-override.spec.ts) ─

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

/** ms-2's own `LEAD-XXXXXX` reference pattern, reused verbatim by every sibling slice. */
const LEAD_REFERENCE = /LEAD-[A-Z0-9]{6}/
const SUBMISSION_REFERENCE = /SUB-[A-Z0-9]{6}/

/**
 * The `/leads/:id` path for a lead, found the way an operator finds it — via
 * the inbox row's own `review-lead` link, filtered by contact email. Mirrors
 * `ms-4/132-start-work-override.spec.ts`'s own `leadPath`.
 */
async function leadPathByEmail(operator: Page, email: string): Promise<string> {
  await operator.goto("/leads")
  const row = operator.getByTestId("lead-row").filter({ hasText: email })
  await expect(row, `exactly one /leads inbox row for ${email} (${MIGRATION_HINT})`).toHaveCount(1)
  const href = await row.getByTestId("review-lead").getAttribute("href")
  expect(href, "`review-lead` links to the lead's own detail screen").toMatch(/^\/leads\/[^/]+$/)
  return href!
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

// ═══════════════════════════════════════════════════════════════════════════

test.describe("ms-5 issue 164 EM-4: a stranger's email becomes a lead", () => {
  // ── the lead itself: same table, same function, same screen ──────────────

  test("a stranger's inbound email creates exactly one leads row, via the same createLead() /start uses", async ({
    request,
    browser,
    baseURL,
  }) => {
    const from = `${unique("plain")}@example.test`
    const body = "We'd like a small booking page for our community garden's plot rota."

    const result = await deliver(request, {
      from: `"Dana Okafor" <${from}>`,
      subject: "Booking page for the garden",
      messageId: `<${unique("msgid")}@example.test>`,
      body,
    })
    expect(result.disposition, "a genuine stranger is never suppressed or rate-limited").toBe("received")

    const inbound = inboundRowById(result.id)
    expect(inbound, `no inbound_emails row was found for id ${result.id}`).not.toBeNull()
    const r = inbound as InboundRow

    // Sanity check only — #163's own rung-6 decision, already sealed by
    // `ms-5/163-inbound-router.spec.ts`. Not a fresh assertion of #163's
    // behaviour; #164 depends on it reaching this row.
    expect(r.routed_kind, "contract § router ladder, rung 6: \"nobody we know ... → a lead\"").toBe("lead")

    expect(r.routed_lead_id, `issue #164 scope item 2: "record the link" (${MIGRATION_HINT})`).not.toBeNull()
    const leadId = r.routed_lead_id as string

    const lead = leadRowById(leadId)
    expect(lead, `inbound_emails.routed_lead_id (${leadId}) did not resolve to a leads row`).not.toBeNull()
    const l = lead as LeadRow

    expect(l.reference, "createLead() mints a LEAD-XXXXXX reference, same as /start").toMatch(LEAD_REFERENCE)
    expect(l.email, "issue #164 scope item 1: \"email ← the sender\"").toBe(from)
    expect(l.name, "issue #164 scope item 1: \"name ← the display name from the From: header\"").toBe("Dana Okafor")
    expect(
      l.summary,
      "issue #164 scope item 1: \"summary ← the message body (capped per EM-1)\" — for an ordinary " +
        "short message this is the same value EM-1 already stored in body_text",
    ).toBe(r.body_text)
    expect(l.summary, "the summary is the sender's own words, not a paraphrase").toBe(body)
    expect(l.promoted_at, "a freshly-created lead is not yet promoted").toBeNull()

    // ── the same triage screen, the same rendering code ───────────────────
    const operatorCtx = await asOperator(browser, baseURL)
    const operator = await operatorCtx.newPage()
    const path = await leadPathByEmail(operator, from)
    expect(path).toBe(`/leads/${leadId}`)

    await operator.goto(path)
    await expect(operator.getByTestId("lead-detail"), "the same /leads/:id screen /start's own leads use").toHaveAttribute(
      "data-status",
      "new",
    )
    await expect(operator.getByTestId("lead-reference")).toContainText(l.reference)
    await expect(operator.getByTestId("lead-summary-full")).toHaveText(body)
    await expect(operator.getByTestId("lead-contact-email")).toHaveText(from)
    await expect(
      operator.getByTestId("lead-name"),
      "a display name was given, so lead-name (optional, same as /start) is present",
    ).toHaveText("Dana Okafor")
    await expect(
      operator.getByTestId("promote-lead-form"),
      "issue #164: \"promotable by the same button\" — the ordinary, unmodified promote form",
    ).toBeVisible()

    await operatorCtx.close()
  })

  test("a stranger's email with no display name leaves the lead's name null, same as /start's optional field", async ({
    request,
    browser,
    baseURL,
  }) => {
    const from = `${unique("noname")}@example.test`
    const result = await deliver(request, {
      from, // bare address, no "Display Name <addr>" wrapper
      subject: "Quick question",
      messageId: `<${unique("msgid")}@example.test>`,
      body: "Do you do ongoing maintenance retainers, or one-off projects only?",
    })
    expect(result.disposition).toBe("received")

    const inbound = inboundRowById(result.id) as InboundRow
    expect(inbound.routed_lead_id, MIGRATION_HINT).not.toBeNull()
    const lead = leadRowById(inbound.routed_lead_id as string) as LeadRow
    expect(
      lead.name,
      "issue #164: \"name ← the display name from the From: header, or null\" — no display name here",
    ).toBeNull()

    const operatorCtx = await asOperator(browser, baseURL)
    const operator = await operatorCtx.newPage()
    const path = await leadPathByEmail(operator, from)
    await operator.goto(path)
    await expect(
      operator.getByTestId("lead-name"),
      "nameBlock() renders nothing at all when a lead has no name — same optionality /start's own leads get",
    ).toHaveCount(0)
    await operatorCtx.close()
  })

  test("the lead a stranger's email produces is promotable through the exact same button, and becomes a real submission", async ({
    request,
    browser,
    baseURL,
  }) => {
    const from = `${unique("promote")}@example.test`
    const result = await deliver(request, {
      from: `"Kwame Boateng" <${from}>`,
      subject: "Interested in a project",
      messageId: `<${unique("msgid")}@example.test>`,
      body: "Could someone help us build a simple sign-up form for a workshop series?",
    })
    expect(result.disposition).toBe("received")
    const inbound = inboundRowById(result.id) as InboundRow
    expect(inbound.routed_lead_id, MIGRATION_HINT).not.toBeNull()

    const operatorCtx = await asOperator(browser, baseURL)
    const operator = await operatorCtx.newPage()
    const path = await leadPathByEmail(operator, from)

    await operator.goto(path)
    await expect(operator.getByTestId("lead-detail")).toHaveAttribute("data-status", "new")
    await operator.getByTestId("promote-button").click()
    await expect(
      operator.getByTestId("lead-detail"),
      "issue #164: \"promotable by the same button\" — the unmodified /leads/:id/promote route",
    ).toHaveAttribute("data-status", "promoted")

    const reference = (await operator.getByTestId("promoted-submission-reference").innerText()).trim()
    expect(reference).toMatch(SUBMISSION_REFERENCE)

    await operatorCtx.close()
  })

  // ── the link recorded on inbound_emails ───────────────────────────────────

  test("the inbound_emails row records both which lead it produced and which draft it produced", async ({ request }) => {
    const from = `${unique("linked")}@example.test`
    const result = await deliver(request, {
      from,
      subject: "Getting started",
      messageId: `<${unique("msgid")}@example.test>`,
      body: "We saw your site and would like a quote for a small internal tool.",
    })
    expect(result.disposition).toBe("received")

    const inbound = inboundRowById(result.id) as InboundRow
    expect(inbound.routed_lead_id, `issue #164 scope item 2 (${MIGRATION_HINT})`).not.toBeNull()
    expect(
      inbound.outbox_id,
      `issue #164 scope item 3 — "outbox_id | Set by EM-4/EM-5" (contract § Schema) (${MIGRATION_HINT})`,
    ).not.toBeNull()

    expect(leadRowById(inbound.routed_lead_id as string), "routed_lead_id must resolve to a real row").not.toBeNull()
    expect(outboxRowById(inbound.outbox_id as string), "outbox_id must resolve to a real row").not.toBeNull()
  })

  // ── the drafted reply itself ───────────────────────────────────────────────

  test("the stranger's message drafts exactly one outbox row at pending, never sent however many drain ticks run", async ({
    request,
    browser,
    baseURL,
  }) => {
    const from = `${unique("draft")}@example.test`
    const result = await deliver(request, {
      from,
      subject: "Hello",
      messageId: `<${unique("msgid")}@example.test>`,
      body: "Wondering if you have capacity to take on a new client this quarter.",
    })
    expect(result.disposition).toBe("received")

    const inbound = inboundRowById(result.id) as InboundRow
    expect(inbound.outbox_id, MIGRATION_HINT).not.toBeNull()

    const draft = outboxRowById(inbound.outbox_id as string)
    expect(draft, `outbox_id (${inbound.outbox_id}) did not resolve to an outbox row`).not.toBeNull()
    const d = draft as OutboxRow

    expect(d.email_type, "issue #164 scope item 3: \"email_type = 'intake-reply'\"").toBe("intake-reply")
    expect(d.approval_state, "issue #164 scope item 3: \"approval_state = 'pending'\"").toBe("pending")
    expect(d.to_email, "the draft replies to the sender").toBe(from)
    expect(d.status, "a freshly-drafted row is queued, not sent").toBe("queued")
    expect(d.sent_at, "a freshly-drafted row has never been sent").toBeNull()

    expect(countWhere("outbox", "id", inbound.outbox_id as string), "exactly one outbox row for this draft").toBe(1)

    // ── the customer-facing read surface (ms-1 GET /outbox, unchanged) ──────
    const customerCtx = await withIdentity(browser, baseURL, from)
    const customer = await customerCtx.newPage()
    await customer.goto("/outbox")
    const preview = customer.getByTestId("email-preview")
    await expect(preview, "GET /outbox is scoped to the caller's own to_email (ms-1 issue #14)").toHaveCount(1)
    await expect(preview).toHaveAttribute("data-email-type", "intake-reply")
    await expect(customer.getByTestId("email-to")).toHaveText(from)
    await customerCtx.close()

    // ── issue #162's own drain gate (already sealed) must still hold here ───
    await tickDrain(request, 5)
    const afterTicks = outboxRowById(d.id) as OutboxRow
    expect(
      afterTicks.status,
      "contract § \"The drain clause\": a pending row is never claimed by the drain, however many ticks run",
    ).toBe("queued")
    expect(afterTicks.attempts, "a never-claimed row is never attempted").toBe(0)
    expect(afterTicks.sent_at, "a pending row is never sent").toBeNull()
  })

  // ── idempotency ──────────────────────────────────────────────────────────

  test("re-delivering the same message produces no second lead and no second draft", async ({ request }) => {
    const from = `${unique("redeliver")}@example.test`
    const messageId = `<${unique("msgid")}@example.test>`
    const opts = {
      from,
      subject: "Following up on my earlier note",
      messageId,
      body: "Sending this again in case it did not go through the first time.",
    }

    const first = await deliver(request, opts)
    expect(first.disposition).toBe("received")
    const firstInbound = inboundRowById(first.id) as InboundRow
    expect(firstInbound.routed_lead_id, MIGRATION_HINT).not.toBeNull()
    expect(firstInbound.outbox_id, MIGRATION_HINT).not.toBeNull()

    const second = await deliver(request, opts)
    expect(
      second.id,
      "issue #161's own UNIQUE(message_id, to_email) means a redelivery resolves to the SAME row",
    ).toBe(first.id)

    const secondInbound = inboundRowById(second.id) as InboundRow
    expect(
      secondInbound.routed_lead_id,
      "a redelivery must not re-route or re-link a different lead onto the same row",
    ).toBe(firstInbound.routed_lead_id)
    expect(secondInbound.outbox_id, "a redelivery must not re-draft a second reply onto the same row").toBe(
      firstInbound.outbox_id,
    )

    expect(
      countWhere("leads", "email", from),
      "issue #164: \"an inbound message that is processed twice must produce one lead\"",
    ).toBe(1)
    expect(
      countWhere("outbox", "to_email", from),
      "issue #164: \"an inbound message that is processed twice must produce ... one draft\"",
    ).toBe(1)
  })

  // ── the template's own safety invariants ────────────────────────────────

  test("the drafted acknowledgement never quotes the sender's own message, discloses no state, and carries the lead's own reference", async ({
    request,
    browser,
    baseURL,
  }) => {
    const from = `${unique("safety")}@example.test`
    // A distinctive, made-up canary phrase. If this ever appears in the
    // drafted reply, the template quoted the sender's own message back to
    // them — exactly what issue #164's own text forbids ("it never quotes
    // submission content").
    const canary = "purple-narwhal-invoice-4471"
    const result = await deliver(request, {
      from,
      subject: "Confidential-ish request",
      messageId: `<${unique("msgid")}@example.test>`,
      body: `Please keep this quiet, but can you quote a job referencing ${canary}? Thanks.`,
    })
    expect(result.disposition).toBe("received")

    const inbound = inboundRowById(result.id) as InboundRow
    expect(inbound.routed_lead_id, MIGRATION_HINT).not.toBeNull()
    expect(inbound.outbox_id, MIGRATION_HINT).not.toBeNull()
    const lead = leadRowById(inbound.routed_lead_id as string) as LeadRow

    const customerCtx = await withIdentity(browser, baseURL, from)
    const customer = await customerCtx.newPage()
    await customer.goto("/outbox")
    const bodyText = await customer.getByTestId("email-body").innerText()
    const subjectText = await customer.getByTestId("email-subject").innerText()
    await customerCtx.close()

    expect(
      bodyText,
      "issue #164: \"it never quotes submission content\" — the sender's own canary phrase must not " +
        "reappear in the drafted acknowledgement",
    ).not.toContain(canary)
    expect(subjectText).not.toContain(canary)

    expect(
      bodyText,
      "issue #164: \"Mirror the copy /start's receipt already uses, including the reference\" — the " +
        `lead's own LEAD-XXXXXX reference (${lead.reference}) must appear in the drafted body`,
    ).toContain(lead.reference)

    for (const [pattern, why] of FORBIDDEN) {
      expect(bodyText, `the drafted acknowledgement: ${why}`).not.toMatch(pattern)
      expect(subjectText, `the drafted acknowledgement's subject: ${why}`).not.toMatch(pattern)
    }
  })
})
