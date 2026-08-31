import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { expect, test, type APIRequestContext, type Page } from "@playwright/test"

/**
 * ms-5 sealed acceptance slice — issue #162
 * "[portal] EM-2: hold a reply for approval — approval_state on outbox, one
 *  clause in the drain"
 *
 * Written from `tests/acceptance/ms-5/contract.md` (§ "Schema —
 * `outbox.approval_state`", which is pinned "verbatim from #162's own issue
 * text") and issue #162's own text, without sight of any implementation.
 *
 * ── WHAT #162 OWNS, AND WHAT THIS SLICE THEREFORE COVERS ────────────────────
 *
 * #162's own Scope, quoted: "Make 'this reply is waiting for a human' a
 * representable, unsendable state — and nothing else. No UI, no new sends, no
 * new callers." So this slice is entirely schema + drain-gating, and nothing
 * from any sibling issue:
 *
 *   1. `migrations/0021_outbox_approval.sql` lands: `outbox` gains
 *      `approval_state` (`NOT NULL DEFAULT 'not_required'`, `CHECK` pinned to
 *      the four-value vocabulary), `approved_at`, `approved_by`.
 *   2. The `DEFAULT 'not_required'` is load-bearing: an `INSERT` that never
 *      mentions the column lands `not_required` anyway, and the untouched
 *      `recordNotificationForStatus` enqueue path (driven here exactly as
 *      `ms-3/50-drain.spec.ts` drives it, through `/intake` + a bridge push)
 *      keeps producing rows that send exactly as before.
 *   3. `outbox.email_type`'s `CHECK` widens to admit `'intake-reply'`, *and*
 *      `SENDING_TYPES` in `src/notifications.ts` grows the same value in the
 *      same change — issue #162's own words: "`fromRow` drops rows whose type
 *      it does not recognise, so a migration that lands without the code
 *      change makes intake replies invisible." Tested black-box by writing an
 *      `intake-reply` row and confirming it does NOT silently vanish from
 *      `GET /outbox` (ms-3's existing, sealed customer route).
 *   4. The drain clause, issue #162's own acceptance text, all three clauses:
 *      a `pending` row is never claimed however many ticks run; flipping it to
 *      `approved` sends it on the very next tick; a `rejected` row is never
 *      sent and never retried, and never mistaken for `failed`.
 *
 * ── WHY THIS SLICE WRITES DIRECTLY TO THE LOCAL D1 (unlike every sibling) ────
 *
 * Every other schema-only or read-back slice in this suite — `ms-4/128`,
 * `ms-4/129`, `ms-5/161` — is emphatic that it reads the migrated D1
 * READ-ONLY and creates every row it needs through a real HTTP surface, to
 * avoid contaminating a sibling slice sharing the same database. That is not
 * available here, and not by accident: #162's own scope is "no new callers".
 * The only things that will ever produce a `pending` `intake-reply` row are
 * the router (#163), the draft template (#164) and `/replies/:id/approve` /
 * `/discard` (#166) — three *other* issues, dispatched separately, with no
 * guarantee any of them exist yet when this slice runs. Contract § "The drain
 * clause" itself describes the ideal end-to-end instrument as "enqueue an
 * intake-reply draft… then `POST /replies/:id/approve`" — a route this issue
 * explicitly does not add. Waiting for a sibling issue's route would make
 * this slice untestable in isolation, which is exactly what "just-in-time
 * slice extension" (this dispatch's own mode) is not supposed to require.
 *
 * So, and only for this one axis: this slice `INSERT`s and `UPDATE`s `outbox`
 * rows directly through `wrangler d1 execute --local`, standing in for the
 * write `/replies/:id/approve` (or the router) will eventually make. Blast
 * radius is kept to zero for any sibling: every row this slice writes uses a
 * `to_email`/`submission_id` pair generated fresh per test
 * (`ms5-162-<label>-<timestamp>-<counter>@example.test`, never reused, never
 * matching any address a sibling slice's own fixtures use), so no other
 * slice's `/outbox` or `/__scheduled` observation can be affected by a row
 * this file wrote, and the suite's `workers: 1` / `fullyParallel: false`
 * config (`playwright.acceptance.config.ts`) means no two tests, in this file
 * or any other, ever run concurrently against the shared D1 in the first
 * place.
 *
 * ── NOT COVERED HERE, AND WHY ────────────────────────────────────────────────
 *  - **`/replies`, `/replies/:id`, `/replies/:id/approve|discard|route|promote`**
 *    (#166/#167). #162's own scope is explicit: "no UI, ... no new callers."
 *  - **The router (#163) actually producing a `pending` row from a real
 *    inbound message**, and **the draft template (#164)**. Different issues,
 *    dispatched separately.
 *  - **Which SQL clause (the `SELECT` vs. the claim `UPDATE`) is missing the
 *    guard**, if only one of them ever ships one. Contract § "The drain
 *    clause" is explicit this is "pinned as an observable invariant, not
 *    merely a specific SQL clause" — this slice can only observe that a
 *    `pending`/`rejected` row is never claimed at all, which is true whether
 *    one or both clauses are guarded, or whether the implementer chooses a
 *    different mechanism (a `WHERE NOT IN`, a partial index, …) that produces
 *    the same observable behaviour.
 *
 * SYNTHETIC DATA. Per CLAUDE.md rule 1 and contract § "Synthetic data", every
 * address, submission and outbox row below is invented on the reserved
 * `example.test` TLD.
 */

test.describe.configure({ timeout: 120_000 })

// ── the repository, as a config + schema surface (mirrors ms-3/51, ms-4/128,
//    ms-4/129, ms-5/161) ──────────────────────────────────────────────────

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
      `${process.cwd()} — this slice inspects and seeds the migrated local D1`,
  )
}

interface D1Result {
  ok: boolean
  rows: Record<string, unknown>[]
  changes: number | null
  error: string | null
}

/**
 * Run one statement against the migrated local D1 — read or write. Same
 * mechanism `ms-4/128-clients-schema.spec.ts` and `ms-5/161-inbound-seam.spec.ts`
 * use for reads; extended to writes here for the reason given in the module
 * comment above (§ "Why this slice writes directly").
 */
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

interface Column {
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
}

function columnsOf(table: string): Column[] | null {
  const q = d1(`PRAGMA table_info(${table})`)
  if (!q.ok || q.rows.length === 0) return null
  return q.rows as unknown as Column[]
}

function column(cols: Column[], name: string): Column | undefined {
  return cols.find((c) => c.name === name)
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''")
}

const MIGRATION_HINT =
  "issue #162 adds `migrations/0021_outbox_approval.sql`, which alters `outbox` to add " +
  "`approval_state`/`approved_at`/`approved_by` and widen the `email_type` CHECK — until it " +
  "lands, `outbox` has neither, and every write below that depends on them fails"

// ── the outbox row shape, as this slice writes it ───────────────────────────

interface OutboxRow {
  id: string
  submission_id: string
  email_type: string
  status: string
  attempts: number
  claimed_at: string | null
  sent_at: string | null
  approval_state: string
  approved_at: string | null
  approved_by: string | null
}

function rowById(id: string): OutboxRow | null {
  const q = d1(`SELECT * FROM outbox WHERE id = '${escapeSql(id)}'`)
  if (!q.ok || q.rows.length === 0) return null
  return q.rows[0] as unknown as OutboxRow
}

let counter = 0
/** A unique, synthetic id/local-part — every row this slice writes owns its own. */
function unique(label: string): string {
  counter += 1
  return `ms5-162-${label}-${Date.now()}-${counter}`
}

interface SeedOpts {
  emailType?: string
  approvalState?: string
}

/**
 * Write one synthetic `outbox` row directly, standing in for the write a
 * sibling issue's caller will eventually make (see the module comment for
 * why). Returns the row's id. Fails the calling test with `MIGRATION_HINT`
 * context if the write did not succeed — the expected, correct outcome before
 * #162 lands.
 */
function seedOutboxRow(label: string, opts: SeedOpts = {}): { id: string; toEmail: string } {
  const id = unique(label)
  const toEmail = `${unique(label)}@example.test`
  const submissionId = `SUB-${unique(label).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12)}`
  const emailType = opts.emailType ?? "intake-reply"
  const now = new Date().toISOString()

  const columns = ["id", "submission_id", "email_type", "to_email", "from_email", "subject", "preheader", "body", "cta_text", "cta_href", "coord_revision", "queued_at"]
  const values = [
    `'${escapeSql(id)}'`,
    `'${escapeSql(submissionId)}'`,
    `'${escapeSql(emailType)}'`,
    `'${escapeSql(toEmail)}'`,
    "'coord-portal <notify@intake.heurontech.com>'",
    `'Re: ${escapeSql(label)}'`,
    "'A synthetic acceptance-test preheader.'",
    "'A synthetic acceptance-test body, never sent to a real inbox.'",
    "'View'",
    "'/submissions/SUB-000000'",
    "1",
    `'${escapeSql(now)}'`,
  ]

  if (opts.approvalState) {
    columns.push("approval_state")
    values.push(`'${escapeSql(opts.approvalState)}'`)
  }

  const result = d1(
    `INSERT INTO outbox (${columns.join(", ")}) VALUES (${values.join(", ")})`,
  )
  expect(
    result.ok,
    `seeding a synthetic outbox row failed (${MIGRATION_HINT}). SQLite said: ${result.error}`,
  ).toBe(true)

  return { id, toEmail }
}

function approveRow(id: string): void {
  const result = d1(
    `UPDATE outbox SET approval_state = 'approved' WHERE id = '${escapeSql(id)}'`,
  )
  expect(result.ok, `approving the synthetic row failed. SQLite said: ${result.error}`).toBe(true)
  expect(result.changes, "the approving UPDATE must actually touch the seeded row").toBe(1)
}

// ── the schema version probe (mirrors ms-4/128, ms-5/161) ───────────────────

/**
 * The schema version at the head of `migrations/` before ms-5 issue #162.
 * `0020_inbound_emails.sql` (issue #161) is already applied in this
 * checkout — #162 is the next migration, whatever number it lands as.
 */
const SCHEMA_HEAD_BEFORE_162 = 20

const HEALTH = "/api/health"

// ── the drain trigger (mirrors ms-3/50-drain.spec.ts) ────────────────────────

/** Contract § "Route surface (pinned)" (ms-3, unchanged): `GET /__scheduled`. */
const DRAIN = "/__scheduled"

const DRAIN_UNAVAILABLE =
  `ms-5 issue #162's drain-gating assertions cannot run at all: \`GET ${DRAIN}\` did not answer ` +
  "2xx. This route is ms-3 issue #50's own trigger for the Cron Trigger the drain runs on, " +
  "already sealed and, per that milestone's own manifest, already green — a failure here means " +
  "the acceptance environment itself is missing `--test-scheduled`, not a #162 defect."

async function runDrain(request: APIRequestContext): Promise<void> {
  const res = await request.get(DRAIN)
  expect(res.ok(), `${DRAIN_UNAVAILABLE} (got HTTP ${res.status()})`).toBe(true)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Fire the drain a fixed number of times, with brief pauses, mirroring
 * `ms-3/50-drain.spec.ts`'s own budget for a POSITIVE wait (row must reach a
 * state). Used here for a NEGATIVE assertion instead — issue #162's own
 * acceptance text: "however many ticks run" — so a fixed, generous tick count
 * (well inside ms-3's own 60s drain budget) stands in for "arbitrarily many".
 */
async function tickDrain(request: APIRequestContext, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    await runDrain(request)
    await sleep(1_000)
  }
}

/** Poll the seeded row until `done`, or ms-3's own 60s drain budget expires. */
async function pollUntil(
  request: APIRequestContext,
  id: string,
  done: (row: OutboxRow) => boolean,
  what: string,
  budgetMs = 60_000,
): Promise<OutboxRow> {
  const deadline = Date.now() + budgetMs
  let row = rowById(id)
  while (Date.now() < deadline) {
    await runDrain(request)
    await sleep(1_000)
    row = rowById(id)
    if (row && done(row)) return row
  }
  throw new Error(
    `${what} — not reached within 60s. Last seen: ${row ? JSON.stringify(row) : "<row missing>"}`,
  )
}

// ── instruments borrowed from ms-3 (used here only as instruments, never as
//    subjects) — the untouched enqueue path, driven through real HTTP ──────

const SEED = {
  outcome: "A printable watering rota for the community greenhouse.",
  audience: "our Saturday volunteers",
  doneDefinition: "Anyone on shift can see which beds are due without asking.",
}

const ROUND = {
  round: 1,
  outcome: "Volunteers can see a watering rota for the greenhouse on their phone.",
  decomposition: ["A rota page showing who waters which beds this week"],
  mockBundleUrl: "https://mocks.example.test/rota/round-1/",
}

const REFERENCE = /^SUB-[A-Z0-9]{6}$/

function asCustomer(page: Page, email: string) {
  return page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": email })
}

async function seedSubmission(page: Page): Promise<string> {
  await page.goto("/intake")
  await page.getByTestId("field-outcome").fill(SEED.outcome)
  await page.getByTestId("field-audience").fill(SEED.audience)
  await page.getByTestId("field-done-definition").fill(SEED.doneDefinition)
  await page.getByTestId("submit-intake").click()
  await expect(page.getByTestId("intake-receipt")).toBeVisible()

  const shown = (await page.getByTestId("submission-reference").innerText()).trim()
  const reference = shown.replace(/^Reference\s+/, "")
  expect(reference, "the receipt shows a SUB-XXXXXX reference").toMatch(REFERENCE)
  return reference
}

/**
 * TODO(test-author): identical to the note in `ms-3/50-drain.spec.ts` and its
 * own siblings — ms-1's contract pins the two header names but not how a
 * Worker booted by `npm run serve:acceptance` learns which pair is valid, and
 * no later contract reopens the question. Same escape hatch, same defaults,
 * so every slice that needs a bridge push agrees.
 */
const SERVICE_TOKEN = {
  "CF-Access-Client-Id":
    process.env.COORD_BRIDGE_CLIENT_ID ?? "9f2c17b4a8de40518c6b3ad0e75f1c62.access",
  "CF-Access-Client-Secret":
    process.env.COORD_BRIDGE_CLIENT_SECRET ??
    "4d1e9c07b35a2f68e4c81079ba6d35f2c9017e4ab8d562309fc71ea48b0d63a5",
}

async function pushFields(
  request: APIRequestContext,
  submissionId: string,
  revision: number,
  fields: Record<string, unknown>,
): Promise<void> {
  const res = await request.post("/api/bridge/push", {
    data: { updates: [{ submission_id: submissionId, revision, fields }] },
    headers: SERVICE_TOKEN,
  })
  expect(res.status(), "a push with a valid service token is 200").toBe(200)
  const body = (await res.json()) as { results: Array<{ outcome: string }> }
  expect(body.results[0]?.outcome, "coord owns `status`/`design_round`").toBe("applied")
}

// ── DOM read for the email_type widening check (ms-3's existing, sealed
//    `/outbox` route — its hooks, not #162's own) ──────────────────────────

async function outboxHasPreview(page: Page, toEmail: string, subject: string): Promise<boolean> {
  await asCustomer(page, toEmail)
  const res = await page.goto("/outbox")
  expect(res?.ok(), "ms-3's existing, sealed `GET /outbox` route").toBe(true)
  const previews = page.getByTestId("email-preview")
  const count = await previews.count()
  for (let i = 0; i < count; i++) {
    const s = await previews.nth(i).getByTestId("email-subject")
    if ((await s.count()) > 0 && (await s.first().innerText()).includes(subject)) return true
  }
  return false
}

// ═══════════════════════════════════════════════════════════════════════════

test.describe("ms-5 issue 162 outbox approval state", () => {
  test("the migration lands, and the running Worker reports the newer schema", async ({ request }) => {
    const res = await request.get(HEALTH)
    expect(res.status(), "the health probe should stay green across a migration").toBe(200)

    const health = (await res.json()) as { ok: boolean; checks: { d1: { ok: boolean; detail?: string } } }
    expect(health.ok, "GET /api/health should report the stack healthy").toBe(true)
    expect(health.checks.d1.ok, "the D1 probe should be green after the migration applies").toBe(true)

    const detail = health.checks.d1.detail ?? ""
    const version = /schema\s+(\d+)/.exec(detail)?.[1]
    expect(version, `the D1 probe should report a schema version, got "${detail}"`).toBeTruthy()
    expect(
      Number(version),
      `issue #162 adds \`migrations/0021_outbox_approval.sql\`, so the schema version should have ` +
        `moved past ${SCHEMA_HEAD_BEFORE_162} (0020_inbound_emails, the head before #162) — ` +
        `reported "${detail}"`,
    ).toBeGreaterThan(SCHEMA_HEAD_BEFORE_162)
  })

  test("outbox carries approval_state / approved_at / approved_by, not_required by default", async () => {
    const cols = columnsOf("outbox")
    expect(cols, `reading \`outbox\`'s columns should succeed (${MIGRATION_HINT})`).not.toBeNull()
    const columns = cols as Column[]

    const approvalState = column(columns, "approval_state")
    expect(approvalState, "contract § schema: `outbox.approval_state` must exist").toBeTruthy()
    expect(approvalState?.notnull, "`approval_state` is `NOT NULL` per #162's own migration text").toBe(1)
    expect(
      approvalState?.dflt_value ?? "",
      "`DEFAULT 'not_required'` is load-bearing per #162's own words — every existing row and " +
        "every existing enqueue path must be untouched",
    ).toContain("not_required")

    const approvedAt = column(columns, "approved_at")
    expect(approvedAt, "contract § schema: `outbox.approved_at` must exist").toBeTruthy()
    expect(approvedAt?.notnull, "`approved_at` is nullable — only stamped on approval").toBe(0)

    const approvedBy = column(columns, "approved_by")
    expect(approvedBy, "contract § schema: `outbox.approved_by` must exist").toBeTruthy()
    expect(approvedBy?.notnull, "`approved_by` is nullable — only stamped on approval").toBe(0)
  })

  test("approval_state is a fixed four-value vocabulary — the CHECK is enforced, not decorative", async () => {
    // Positive: exactly the four values #162's own migration text enumerates.
    for (const value of ["not_required", "pending", "approved", "rejected"]) {
      const { id } = seedOutboxRow(`vocab-${value}`, { approvalState: value })
      const row = rowById(id);
      expect(row?.approval_state, `a row explicitly written as '${value}' must read back as '${value}'`).toBe(
        value,
      )
    }

    // Negative: anything outside the four-value vocabulary is rejected by the
    // CHECK, the same way #162's own text insists the drain must never widen
    // `outbox.status` and rely on app-code discipline alone.
    const bogusId = unique("vocab-bogus")
    const result = d1(
      `INSERT INTO outbox (id, submission_id, email_type, to_email, from_email, subject, preheader, ` +
        `body, cta_text, cta_href, coord_revision, queued_at, approval_state) VALUES ` +
        `('${escapeSql(bogusId)}', 'SUB-BOGUS01', 'intake-reply', 'bogus@example.test', ` +
        `'coord-portal <notify@intake.heurontech.com>', 'x', 'x', 'x', 'x', '/x', 1, ` +
        `'${new Date().toISOString()}', 'sent-to-the-moon')`,
    )
    expect(
      result.ok,
      "an `approval_state` outside {not_required, pending, approved, rejected} must be rejected " +
        "by the CHECK constraint #162's own migration text pins verbatim, not silently accepted",
    ).toBe(false)
  })

  test("outbox.email_type admits 'intake-reply' without it silently vanishing from GET /outbox", async ({
    page,
  }) => {
    // Contract: "`fromRow` drops rows whose type it does not recognise, so a
    // migration that lands without the [SENDING_TYPES] code change makes
    // intake replies invisible." This is the one point at which #162's schema
    // change and its `src/notifications.ts` change are both required for a
    // single black-box observation to pass — either one missing fails this.
    const label = "widen"
    const { id, toEmail } = seedOutboxRow(label, { approvalState: "not_required" })
    const row = rowById(id)
    expect(
      row,
      `the row must exist at all — a rejected \`email_type = 'intake-reply'\` insert means the ` +
        `CHECK was not widened (${MIGRATION_HINT})`,
    ).not.toBeNull()
    expect(row?.email_type).toBe("intake-reply")

    const visible = await outboxHasPreview(page, toEmail, `Re: ${label}`)
    expect(
      visible,
      "issue #162's own words: a migration that lands without adding 'intake-reply' to " +
        "SENDING_TYPES in src/notifications.ts makes intake replies invisible on GET /outbox " +
        "(fromRow returns null and the row is silently dropped) — this row must render",
    ).toBe(true)
  })

  test("a pending row is never claimed by the drain, however many ticks run", async ({ request }) => {
    // Issue #162's own acceptance text, clause 1: "A row with approval_state =
    // 'pending' is never claimed by the drain, however many ticks run."
    const { id } = seedOutboxRow("pending", { approvalState: "pending" })

    const before = rowById(id)
    expect(before?.status, "positive control: the row starts queued, unclaimed").toBe("queued")
    expect(before?.attempts, "positive control: zero attempts before any tick").toBe(0)
    expect(before?.claimed_at, "positive control: no live claim before any tick").toBeNull()

    await tickDrain(request, 5)

    const after = rowById(id)
    expect(
      after?.status,
      "contract § \"The drain clause\": `approval_state IN ('not_required','approved')` is " +
        "required to be claimed at all — a `pending` row must still be `queued` after any number " +
        "of ticks",
    ).toBe("queued")
    expect(after?.attempts, "never claimed ⇒ never attempted").toBe(0)
    expect(after?.claimed_at, "never claimed ⇒ the lease marker is never stamped").toBeNull()
    expect(after?.sent_at, "never claimed ⇒ never delivered").toBeNull()
  })

  test("flipping a pending row to approved sends it on the very next tick", async ({ request }) => {
    // Issue #162's own acceptance text, clause 2: "Flipping it to approved
    // makes the very next tick send it." Seeded `pending` first (so this test
    // also re-proves the pending-is-unclaimable half on its own row, not just
    // borrowed from the previous test), then flipped via the write this
    // slice stands in for `/replies/:id/approve` (contract § "Route surface":
    // "writes... `approval_state = 'approved'`, stamps `approved_at`/
    // `approved_by`, clears `claimed_at`").
    const { id } = seedOutboxRow("approve", { approvalState: "pending" })

    await tickDrain(request, 2)
    const stillPending = rowById(id)
    expect(stillPending?.status, "positive control: still queued while pending").toBe("queued")
    expect(stillPending?.attempts, "positive control: never attempted while pending").toBe(0)

    approveRow(id)
    const approved = rowById(id)
    expect(approved?.approval_state, "the seam this slice stands in for the approve write").toBe(
      "approved",
    )

    const sent = await pollUntil(
      request,
      id,
      (row) => row.status === "sent",
      "a row flipped to approved must reach `sent` on the very next tick the drain gets " +
        "(contract § \"The drain clause\")",
    )
    expect(sent.status, "contract § \"The drain clause\": approved ⇒ claimable ⇒ sent").toBe("sent")
    expect(sent.sent_at, "a sent row records a delivery time").not.toBeNull()
    expect(
      sent.approval_state,
      "the drain's own write never touches approval_state — sending is a status transition, " +
        "approval is a separate axis (contract § schema)",
    ).toBe("approved")
  })

  test("a rejected row is never sent and never retried, however many ticks run", async ({ request }) => {
    // Issue #162's own acceptance text, clause 3: "A rejected row is never
    // sent and never retried." And, separately, contract § schema: "`rejected`
    // is not `failed`... A sealed test must not treat these as
    // interchangeable: a rejected row must never transition to
    // outbox.status = 'failed' and must never be retried."
    const { id } = seedOutboxRow("rejected", { approvalState: "rejected" })

    const before = rowById(id)
    expect(before?.status, "positive control: born queued, like any other row").toBe("queued")

    await tickDrain(request, 5)

    const after = rowById(id)
    expect(
      after?.status,
      "a `rejected` row must never be claimed, so `status` never leaves `queued` — and, per " +
        "contract § schema, it must certainly never become `sent`",
    ).toBe("queued")
    expect(
      after?.status,
      "contract § schema: `rejected` is not `failed` — a rejected row must never be recorded as " +
        "a delivery fault either, since it was never claimed to be attempted in the first place",
    ).not.toBe("failed")
    expect(after?.attempts, "never claimed ⇒ never retried").toBe(0)
    expect(after?.claimed_at).toBeNull()
    expect(after?.sent_at).toBeNull()
    expect(after?.approval_state, "rejection is terminal — nothing in this issue's scope moves it").toBe(
      "rejected",
    )
  })

  test("every pre-existing row (approval_state = not_required) still sends exactly as before", async ({
    page,
    request,
  }) => {
    // Issue #162's own acceptance text, clause 4 (and its own explicit
    // reason for DEFAULT 'not_required'): "Every pre-existing row still
    // sends exactly as before." Driven through the untouched enqueue path —
    // `/intake` + a bridge push deciding `awaiting-signoff` — the same
    // instrument `ms-3/50-drain.spec.ts` uses, never a seeded row, so this is
    // a true end-to-end regression check of the code path #162 must not
    // disturb, not just a schema-level default check.
    const toEmail = `${unique("regression")}@example.test`
    await asCustomer(page, toEmail)
    const reference = await seedSubmission(page)

    await pushFields(request, reference, 6000, {
      status: "awaiting-signoff",
      design_round: {
        round: ROUND.round,
        outcome_definition: ROUND.outcome,
        mock_bundle_url: ROUND.mockBundleUrl,
      },
      decomposition: ROUND.decomposition,
    })

    // Find the row the push just decided, scoped to this test's own address.
    const q = d1(`SELECT id FROM outbox WHERE to_email = '${escapeSql(toEmail)}'`)
    expect(q.ok, `reading the row the untouched enqueue path just wrote (${MIGRATION_HINT})`).toBe(
      true,
    )
    expect(q.rows.length, "the push decided exactly one send").toBe(1)
    const id = String((q.rows[0] as { id: unknown }).id)

    const queued = rowById(id)
    expect(
      queued?.approval_state,
      "issue #162's own words: the untouched `recordNotificationForStatus` path never mentions " +
        "`approval_state`, so it must land on the column's own DEFAULT, unaffected by this " +
        "milestone",
    ).toBe("not_required")
    expect(queued?.status, "positive control: freshly queued").toBe("queued")

    const sent = await pollUntil(
      request,
      id,
      (row) => row.status === "sent",
      "a `not_required` row (every pre-existing row and every existing notification type) must " +
        "keep sending unattended — the drain's new clause admits `not_required` alongside " +
        "`approved`",
    )
    expect(sent.status, "the drain clause change must not regress the existing send path").toBe(
      "sent",
    )
    expect(sent.approval_state, "the drain never rewrites approval_state").toBe("not_required")
  })
})
