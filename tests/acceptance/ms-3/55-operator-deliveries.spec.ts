import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test"

/**
 * ms-3 sealed acceptance slice — issue #55
 * "[portal] The operator's delivery view — every outbox row, not just the caller's own"
 *
 * Written from `tests/acceptance/ms-3/contract.md` (§ "The operator delivery
 * view (issue #55)", § "Route surface", § "Delivery state vocabulary",
 * § "Customer-safe error copy", § "The provider seam", § "Triggering the drain
 * in the sealed suite") and from the two mocks that section pins —
 * `mocks/05-deliveries-mixed.html` and `mocks/06-deliveries-empty.html` —
 * without sight of any implementation.
 *
 * THE SHAPE UNDER TEST. #55 exists because #49's own motivating line ("the
 * operator has no way to see a stuck notification") was never closed:
 * `GET /outbox` is scoped to the caller's Access identity, so it answers "what
 * did you get", and "structurally cannot answer 'what is stuck'". `/deliveries`
 * is the counterpart. Four things are observable, and they are what this slice
 * asserts:
 *
 *   UNSCOPED    every outbox row, across every customer — not the caller's own.
 *   GATED       `readOperator`, the `/leads` precedent: anyone else gets the
 *               same indistinguishable 404 a route that does not exist gets.
 *               Distinct from the empty list, which is a 200.
 *   DIAGNOSTIC  recipient, subject, and the delivery state #49 adds — with the
 *               RAW `last_error`, the one thing `/outbox` may never show.
 *   SEPARATE    the customer-safe copy on `/outbox` and the raw provider string
 *               on `/deliveries`, asserted on the SAME underlying row. #55:
 *               "which is what makes the separation real rather than
 *               incidental." A worker who parameterises one rendering path with
 *               an `isOperator` flag can still pass every other test in this
 *               file; this one is why both halves are read from one seeded row.
 *
 * NOT COVERED HERE, deliberately:
 *  - **Any action.** #55's Scope, "Out": "No manual retry, no requeue, no
 *    resend button… adding a write here would silently amend an approved
 *    contract from a different milestone." So this slice never POSTs to
 *    `/deliveries` and never asserts a control that could. Nor does it assert
 *    the ABSENCE of one — the contract pins no such hook to be absent, and
 *    inventing a forbidden `data-testid` would be inventing behaviour.
 *  - **Filtering, search, pagination** — #55 puts all three out of scope.
 *  - **The `/outbox` delivery DOM itself** (#49's slice) and **what MOVES a row**
 *    (#50's drain, #51's fake). Both are used here as instruments — a `failed`
 *    row cannot exist without them — never as subjects. Nothing below asserts
 *    the drain's transitions, its retry budget, or the fake's selection.
 *  - **`delivery-provider-id`.** Contract § "The operator delivery view" and
 *    Notes item 8: "not required by this contract; additive if present." An
 *    implementer who omits it "has still met this contract", so no test may
 *    require it. `mocks/05` renders it on the `sent` row as an illustration
 *    only.
 *  - **#52** (`oracle:exempt` by its own issue text, contract Notes item 7).
 *
 * SYNTHETIC DATA. Per CLAUDE.md rule 1 and contract § "Synthetic data", every
 * address, submission and design round below is invented on the reserved
 * `example.test` TLD. The `mailfail` local-parts are the contract's own pinned
 * deterministic-failure lever, safe to commit.
 *
 * NOTE ON FIXTURES. This repo's `web-playwright` driver has no fixture-server
 * seam: `playwright.acceptance.config.ts` boots `npm run serve:acceptance`,
 * which wipes `.wrangler/state` and re-applies migrations, so "`wrangler dev`
 * over a freshly-migrated local D1 *is* a deterministic backend" (its own
 * words). Every row below is therefore seeded through the product's real
 * surfaces — the intake form and the bridge push — exactly as ms-1's, #49's and
 * #50's slices already do. No `page.route()` interception is used anywhere.
 */

// ── the pinned routes ───────────────────────────────────────────────────────

/**
 * Contract § "The operator delivery view (issue #55)", "Route name": #55 calls
 * `/deliveries` "a proposal, not a requirement", and the contract resolves that
 * open question by "pinning `/deliveries` as the exact path… If a worker ships a
 * different path, that is a contract amendment, not a free choice". So this
 * slice hard-codes it, and a 404 here from an operator identity means the path
 * moved, not that the gate worked.
 */
const DELIVERIES = "/deliveries"

/** The customer-scoped counterpart, unchanged from ms-1 / #49. */
const OUTBOX = "/outbox"

/** Contract § "Triggering the drain in the sealed suite" — #50's seam. */
const DRAIN = "/__scheduled"

const DRAIN_UNAVAILABLE =
  `\`GET ${DRAIN}\` is not available. Contract § "Triggering the drain in the sealed suite" ` +
  "pins it as the only way a sealed test can invoke the Cron Trigger, and flags that " +
  "`serve:acceptance` must pass `--test-scheduled` for it to exist. This slice needs it only " +
  "as an INSTRUMENT — to produce the `failed` row #55's own acceptance surface asks for — so " +
  "a failure here is #50's wiring, not #55's behaviour"

const ACCESS_HEADER = "Cf-Access-Authenticated-User-Email"

/**
 * The operator identity.
 *
 * TODO(test-author): same open point `ms-2/33-lead-triage-promotion.spec.ts`
 * flags, inherited verbatim rather than re-litigated. #55 is explicit that this
 * is "not new auth — reuse the `/leads` precedent", so whatever address is an
 * operator for `/leads` in the acceptance environment is an operator here. This
 * slice takes the only address the contract actually shows — `ops@example.test`,
 * what both `/deliveries` mocks render in `identity-email` — with the same
 * `COORD_PORTAL_OPERATOR_EMAIL` escape hatch, so this file and ms-2's agree.
 */
const OPERATOR_EMAIL = process.env.COORD_PORTAL_OPERATOR_EMAIL ?? "ops@example.test"

// ── the pinned delivery vocabulary (shared with `/outbox`) ──────────────────

/**
 * Contract § "The operator delivery view": `delivery-status` is "the pill, same
 * three slugs and exact text (`Queued` / `Sent` / `Delivery failed`) as
 * `/outbox`'s `delivery-status`". One vocabulary, two screens.
 */
const STATUS_TEXT = {
  queued: "Queued",
  sent: "Sent",
  failed: "Delivery failed",
} as const

type DeliveryStatus = keyof typeof STATUS_TEXT
const STATUSES = Object.keys(STATUS_TEXT) as DeliveryStatus[]

const DETAIL_HOOKS = ["delivery-sent-at", "delivery-attempts", "delivery-last-error"] as const
type DetailHook = (typeof DETAIL_HOOKS)[number]

/**
 * Contract § "The operator delivery view": `delivery-sent-at` "present iff
 * `data-status=\"sent\"`, same presence rule as `/outbox`"; `delivery-attempts`
 * and `delivery-last-error` "present iff `data-status=\"failed\"`, same presence
 * rule as `/outbox`".
 */
const PRESENT_FOR: Record<DeliveryStatus, DetailHook[]> = {
  queued: [],
  sent: ["delivery-sent-at"],
  failed: ["delivery-attempts", "delivery-last-error"],
}

// ── the customer-safe copy wall (applies to `/outbox` ONLY) ─────────────────

/**
 * Contract § "Customer-safe error copy (pinned invariant)" — ms-1's FORBIDDEN
 * array, copied verbatim from `tests/acceptance/ms-1/14-notifications.spec.ts`
 * the same way #49's and #50's slices copy it.
 *
 * ⚠ This wall is asserted against `/outbox` and never against `/deliveries`.
 * Contract § "The operator delivery view": the customer-safe section "governs
 * the *customer*-scoped route only; it does not apply to `/deliveries`, and a
 * worker who runs the customer redaction function against this field has
 * misread this contract".
 */
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
  [/\bstatus:ready\b/i, "labels are engineer-side"],
  [/\b(feat|fix|chore|refactor)\/[a-z0-9-]+/i, "customers never see a branch name"],
]

/** Contract § "Customer-safe error copy" — ms-3's own additions to that list. */
const INFRA_FORBIDDEN: Array<[RegExp, string]> = [
  [/resend/i, "the mail provider is never named to a customer"],
  [/\bapi key\b/i, "a credential is never mentioned to a customer"],
  [/\bfetch\b/i, "a transport verb is engineer-side"],
  [/\b\d{3}\b/, "a bare HTTP status code is operator-debugging material"],
  [/\bprovider\b/i, "the delivery pipeline is not a customer-facing concept"],
  [/\bendpoint\b/i, "an endpoint is engineer-side"],
]

/** ms-1's customer topbar hooks. The operator topbar is distinct from it. */
const CUSTOMER_TOPBAR = ["nav-dashboard", "nav-new", "nav-new-cta", "nav-outbox"]

// ── bridge transport (the instrument, not the subject) ──────────────────────

/**
 * The daemon's service-token credential — same convention, same defaults and
 * same escape hatch as ms-1's bridge slice and #49's/#50's, so this file runs
 * under exactly the environment those already run under. Invented values.
 */
const SERVICE_TOKEN = {
  "CF-Access-Client-Id":
    process.env.COORD_BRIDGE_CLIENT_ID ?? "9f2c17b4a8de40518c6b3ad0e75f1c62.access",
  "CF-Access-Client-Secret":
    process.env.COORD_BRIDGE_CLIENT_SECRET ??
    "4d1e9c07b35a2f68e4c81079ba6d35f2c9017e4ab8d562309fc71ea48b0d63a5",
}

interface PushResult {
  submission_id: string
  outcome: string
  reason?: string
}

async function pushFields(
  request: APIRequestContext,
  submissionId: string,
  revision: number,
  fields: Record<string, unknown>,
): Promise<PushResult> {
  const res = await request.post("/api/bridge/push", {
    data: { updates: [{ submission_id: submissionId, revision, fields }] },
    headers: SERVICE_TOKEN,
  })
  expect(res.status(), "a push with a valid service token is 200").toBe(200)
  const body = (await res.json()) as { results: PushResult[] }
  expect(body.results, "one result per update").toHaveLength(1)
  return body.results[0]
}

// ── synthetic material ──────────────────────────────────────────────────────

const SEEDS = [
  {
    outcome: "A printable watering rota for the community greenhouse.",
    audience: "our Saturday volunteers",
    doneDefinition: "Anyone on shift can see which beds are due without asking.",
  },
  {
    outcome: "A shared list of which raised beds are free to claim.",
    audience: "new plot holders",
    doneDefinition: "A new plot holder can pick a free bed unaided.",
  },
  {
    outcome: "A monthly note listing tools that were never returned.",
    audience: "the workshop steward",
    doneDefinition: "The steward gets one list on the first of the month.",
  },
]

const ROUND = {
  round: 1,
  outcome: "Volunteers can see a watering rota for the greenhouse on their phone.",
  decomposition: [
    "A rota page showing who waters which beds this week",
    "A way for a volunteer to swap a shift with someone else",
  ],
  mockBundleUrl: "https://mocks.example.test/rota/round-1/",
}

const QUESTION =
  "Should volunteers who swap a shift need the rota owner to confirm it, or is a straight swap enough?"

/** The three fields that make a submission ready for sign-off, in one push. */
function signoffFields() {
  return {
    status: "awaiting-signoff",
    design_round: {
      round: ROUND.round,
      outcome_definition: ROUND.outcome,
      mock_bundle_url: ROUND.mockBundleUrl,
    },
    decomposition: ROUND.decomposition,
  }
}

/**
 * One synthetic customer per row. The acceptance database is wiped per *run*,
 * not per *test* (`tests/acceptance/README.md` § Determinism) and `/deliveries`
 * is by definition unscoped — every row every other slice in this run seeded is
 * on the screen too — so a row is identified here by its own unique recipient,
 * never by position or by the size of the list.
 *
 * Local-parts containing `mailfail` are contract § "The provider seam"'s pinned
 * deterministic-failure lever: "the fake succeeds for every recipient **except**
 * one whose local-part contains the substring `mailfail`". They appear here only
 * where a `failed` row is the thing under test.
 */
const INBOX = {
  bothA: "rota-ops-both-a@example.test",
  bothB: "rota-ops-both-b@example.test",
  gate: "rota-ops-gate@example.test",
  scopedA: "rota-ops-scoped-a@example.test",
  scopedB: "rota-ops-scoped-b@example.test",
  rawError: "rota-ops-mailfail-raw@example.test",
  statesQueued: "rota-ops-states-queued@example.test",
  statesSent: "rota-ops-states-sent@example.test",
  statesFailed: "rota-ops-states-mailfail@example.test",
  orderFirst: "rota-ops-order-first@example.test",
  orderSecond: "rota-ops-order-second@example.test",
  nav: "rota-ops-nav@example.test",
}

const REFERENCE = /^SUB-[A-Z0-9]{6}$/

// ── identities ──────────────────────────────────────────────────────────────

/** Local `wrangler dev` has no Access in front of it, so identity is a header. */
function withIdentity(
  browser: Browser,
  baseURL: string | undefined,
  email: string,
): Promise<BrowserContext> {
  return browser.newContext({ baseURL, extraHTTPHeaders: { [ACCESS_HEADER]: email } })
}

function asOperator(browser: Browser, baseURL: string | undefined): Promise<BrowserContext> {
  return withIdentity(browser, baseURL, OPERATOR_EMAIL)
}

/** A caller with no Access identity at all. */
function asStranger(browser: Browser, baseURL: string | undefined): Promise<BrowserContext> {
  return browser.newContext({ baseURL })
}

// ── small utilities ─────────────────────────────────────────────────────────

/** Collapse the incidental whitespace of rendered HTML before comparing copy. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ── seeding, through the product's own surfaces ─────────────────────────────

/** Author one submission through ms-1's pinned intake form (#9's surface). */
async function seedSubmission(page: Page, n: number): Promise<string> {
  const seed = SEEDS[n % SEEDS.length]
  await page.goto("/intake")
  await page.getByTestId("field-outcome").fill(seed.outcome)
  await page.getByTestId("field-audience").fill(seed.audience)
  await page.getByTestId("field-done-definition").fill(seed.doneDefinition)
  await page.getByTestId("submit-intake").click()
  await expect(page.getByTestId("intake-receipt")).toBeVisible()

  const shown = (await page.getByTestId("submission-reference").innerText()).trim()
  const reference = shown.replace(/^Reference\s+/, "")
  expect(reference, "the receipt shows a SUB-XXXXXX reference").toMatch(REFERENCE)
  return reference
}

// ── the customer's own screen (`/outbox`), read the way #49 pins it ─────────

interface OutboxRow {
  status: string | null
  pillText: string | null
  subject: string | null
  recipient: string | null
  detail: Record<DetailHook, string | null>
}

async function readOutboxRow(preview: Locator): Promise<OutboxRow> {
  const pill = preview.getByTestId("delivery-status")
  const detail = {} as Record<DetailHook, string | null>
  for (const hook of DETAIL_HOOKS) {
    const node = preview.getByTestId(hook)
    detail[hook] = (await node.count()) === 0 ? null : flat(await node.first().innerText())
  }
  const subject = preview.getByTestId("email-subject")
  const to = preview.getByTestId("email-to")
  return {
    status: await preview.getAttribute("data-status"),
    pillText: (await pill.count()) > 0 ? flat(await pill.first().innerText()) : null,
    subject: (await subject.count()) > 0 ? flat(await subject.first().innerText()) : null,
    recipient: (await to.count()) > 0 ? flat(await to.first().innerText()) : null,
    detail,
  }
}

/**
 * Every row on the caller's own `/outbox`, in DOM order — filtered by
 * `email-to` so a globally-scoped outbox and a caller-scoped one are both
 * readable, the same indifference ms-1's, #49's and #50's slices build in. (The
 * scoping itself is asserted directly, once, below.)
 */
async function readOutbox(page: Page, to: string): Promise<OutboxRow[]> {
  const response = await page.goto(OUTBOX)
  expect(response?.ok(), `contract § Route surface pins \`GET ${OUTBOX}\``).toBe(true)

  const previews = page.getByTestId("email-preview")
  const rows: OutboxRow[] = []
  for (let i = 0; i < (await previews.count()); i++) {
    const preview = previews.nth(i)
    const recipient = preview.getByTestId("email-to")
    if ((await recipient.count()) > 0 && !flat(await recipient.first().innerText()).includes(to)) {
      continue
    }
    rows.push(await readOutboxRow(preview))
  }
  return rows
}

/** Wait until this customer's outbox holds exactly `expected` rows. */
async function awaitOutbox(page: Page, to: string, expected: number): Promise<OutboxRow[]> {
  let rows: OutboxRow[] = []
  await expect
    .poll(
      async () => {
        rows = await readOutbox(page, to)
        return rows.length
      },
      { message: `${to} must have exactly ${expected} outbox row(s)`, timeout: 30_000 },
    )
    .toBe(expected)
  return rows
}

/**
 * Seed exactly one outbox row for one synthetic customer, and return what the
 * customer's own screen says about it. Everything here is another issue's
 * surface used as an instrument: #9's intake form and #15's bridge push are the
 * only black-box way to make the portal DECIDE a send, exactly as #49's slice
 * documents.
 */
async function seedRow(
  browser: Browser,
  baseURL: string | undefined,
  request: APIRequestContext,
  recipient: string,
  seedIndex: number,
  revision: number,
  fields: Record<string, unknown>,
): Promise<OutboxRow> {
  const context = await withIdentity(browser, baseURL, recipient)
  const page = await context.newPage()
  const reference = await seedSubmission(page, seedIndex)
  expect(
    (await pushFields(request, reference, revision, fields)).outcome,
    "`status`, `question` and `design_round` are all coord-owned",
  ).toBe("applied")
  const [row] = await awaitOutbox(page, recipient, 1)
  await context.close()
  return row
}

// ── the drain (an instrument, borrowed from #50) ────────────────────────────

async function runDrain(request: APIRequestContext): Promise<void> {
  const res = await request.get(DRAIN)
  expect(res.ok(), `${DRAIN_UNAVAILABLE} (got HTTP ${res.status()})`).toBe(true)
}

/**
 * Fire the drain repeatedly, with the "brief, e.g. ≤2s" pauses contract
 * § "Retry/backoff budget" bounds, until `to`'s single outbox row satisfies
 * `done`, or the contract's 60-second total budget expires.
 */
async function drainUntil(
  page: Page,
  request: APIRequestContext,
  to: string,
  done: (rows: OutboxRow[]) => boolean,
  what: string,
  budgetMs = 60_000,
): Promise<OutboxRow[]> {
  const deadline = Date.now() + budgetMs
  let rows = await readOutbox(page, to)
  let ticks = 0

  while (Date.now() < deadline) {
    await runDrain(request)
    ticks++
    await sleep(1_000)
    rows = await readOutbox(page, to)
    if (done(rows)) return rows
  }

  const seen = rows.map((row, i) => `row ${i + 1}: ${row.status ?? "<no data-status>"}`).join("; ")
  throw new Error(
    `${what} — not reached within the contract's 60s budget after ${ticks} \`GET ${DRAIN}\` ` +
      `calls at ~1s intervals. Last seen for ${to}: ${seen || "<no outbox rows>"}. This is #50's ` +
      "drain and #51's fake being used as INSTRUMENTS here — if this is the only kind of failure " +
      "in this file, the operator view itself is probably fine and the delivery pipeline is not.",
  )
}

// ── the operator's screen (`/deliveries`) ───────────────────────────────────

interface DeliveryRow {
  /** Position in DOM order, so "most recent activity first" is checkable. */
  index: number
  recipient: string | null
  subject: string | null
  /** `data-status` on the `delivery-row` element itself. */
  status: string | null
  /** `data-status` on the `delivery-status` pill inside it. */
  pillStatus: string | null
  pillCount: number
  pillText: string | null
  detail: Record<DetailHook, string | null>
}

async function readDeliveryRow(row: Locator, index: number): Promise<DeliveryRow> {
  const pill = row.getByTestId("delivery-status")
  const pillCount = await pill.count()

  const detail = {} as Record<DetailHook, string | null>
  for (const hook of DETAIL_HOOKS) {
    const node = row.getByTestId(hook)
    detail[hook] = (await node.count()) === 0 ? null : flat(await node.first().innerText())
  }

  const recipient = row.getByTestId("delivery-recipient")
  const subject = row.getByTestId("delivery-subject")

  return {
    index,
    recipient: (await recipient.count()) > 0 ? flat(await recipient.first().innerText()) : null,
    subject: (await subject.count()) > 0 ? flat(await subject.first().innerText()) : null,
    status: await row.getAttribute("data-status"),
    pillStatus: pillCount > 0 ? await pill.first().getAttribute("data-status") : null,
    pillCount,
    pillText: pillCount > 0 ? flat(await pill.first().innerText()) : null,
    detail,
  }
}

/**
 * Every row on `GET /deliveries`, in DOM order, as the operator.
 *
 * The 200 is asserted here rather than in each test because a 404 from an
 * operator identity is the single most likely early failure — the route not
 * existing yet, or having shipped at a different path than the one contract
 * § "The operator delivery view" pins.
 */
async function readDeliveries(page: Page): Promise<DeliveryRow[]> {
  const response = await page.goto(DELIVERIES)
  expect(
    response?.status(),
    `contract § Route surface pins \`GET ${DELIVERIES}\` for an operator. A 404 here means ` +
      "either the route does not exist yet or it shipped at a different path — contract " +
      '§ "The operator delivery view": a different path "is a contract amendment, not a free ' +
      'choice"',
  ).toBe(200)

  // Rows exist by construction in every test that calls this, so the container
  // must be the list, not the empty state. Contract: `deliveries-list-empty` is
  // present "if and only if there are zero `outbox` rows across every customer".
  await expect(
    page.getByTestId("deliveries-list"),
    "contract § The operator delivery view: `deliveries-list` is the container",
  ).toHaveCount(1)
  await expect(
    page.getByTestId("deliveries-list-empty"),
    "rows were just seeded, so the empty state must not be rendered",
  ).toHaveCount(0)

  const locator = page.getByTestId("delivery-row")
  const rows: DeliveryRow[] = []
  for (let i = 0; i < (await locator.count()); i++) {
    rows.push(await readDeliveryRow(locator.nth(i), i))
  }
  return rows
}

/** The one row on `/deliveries` addressed to a given synthetic customer. */
function rowFor(rows: DeliveryRow[], recipient: string): DeliveryRow {
  const matches = rows.filter((row) => (row.recipient ?? "").includes(recipient))
  expect(
    matches.length,
    `\`/deliveries\` must carry exactly one row for ${recipient} — contract § The operator ` +
      "delivery view: `delivery-recipient` is \"the row's `to_email`, verbatim, unredacted\", " +
      `and exactly one outbox row was seeded for this address. Rows on screen: ${rows.length}`,
  ).toBe(1)
  return matches[0]
}

/**
 * Contract § "The operator delivery view" — everything pinned about a
 * `/deliveries` row that does not depend on WHICH state it is in. Applied to
 * every row on the screen, including rows other slices in this run seeded,
 * because the invariant is about the screen, not about one seeded fixture.
 */
function assertRowIsWellFormed(row: DeliveryRow, where: string) {
  expect(
    row.pillCount,
    `${where}: \`delivery-status\` is "Always present", exactly once per row`,
  ).toBe(1)
  expect(
    STATUSES as string[],
    `${where}: \`delivery-row\` carries \`data-status\` ∈ ${STATUSES.join(" / ")} — "same three ` +
      'slugs "Delivery state vocabulary" pins for `/outbox`"',
  ).toContain(row.status)
  expect(
    row.pillStatus,
    `${where}: the pill's \`data-status\` must agree with the row's — one row, one state`,
  ).toBe(row.status)

  const status = row.status as DeliveryStatus
  expect(
    row.pillText,
    `${where}: contract pins \`${status}\` ⇒ pill text exactly "${STATUS_TEXT[status]}", the ` +
      "same vocabulary `/outbox` uses",
  ).toBe(STATUS_TEXT[status])

  expect(
    row.recipient,
    `${where}: \`delivery-recipient\` — "the row's \`to_email\`, verbatim, unredacted"`,
  ).not.toBeNull()
  expect(row.recipient, `${where}: a recipient that is not an address identifies nothing`).toContain(
    "@",
  )
  expect(
    row.subject,
    `${where}: \`delivery-subject\` — "the row's subject line, verbatim"`,
  ).not.toBeNull()
  expect(
    (row.subject as string).length,
    `${where}: an empty subject tells an operator nothing about which send is stuck`,
  ).toBeGreaterThan(0)

  for (const hook of DETAIL_HOOKS) {
    if (PRESENT_FOR[status].includes(hook)) {
      expect(
        row.detail[hook],
        `${where}: \`${hook}\` is present if and only if the row is \`${status}\``,
      ).not.toBeNull()
      expect(
        (row.detail[hook] as string).length,
        `${where}: \`${hook}\` renders on a \`${status}\` row, so it must say something`,
      ).toBeGreaterThan(0)
    } else {
      expect(
        row.detail[hook],
        `${where}: \`${hook}\` must be absent on a \`${status}\` row — same presence rule as ` +
          "`/outbox`",
      ).toBeNull()
    }
  }

  if (status === "failed") {
    expect(
      row.detail["delivery-attempts"] as string,
      `${where}: \`delivery-attempts\` must show the attempt count as a base-10 integer ` +
        '(mock 05 renders "5 attempts"; the wording is illustrative, the number is not)',
    ).toMatch(/\d+/)
  }

  // The raw `last_error` on this screen is deliberately NOT checked against the
  // customer-safe wall — see the FORBIDDEN comment above, and the "raw provider
  // error" test below, which asserts the divergence positively.
}

/**
 * The operator topbar, per contract § "The operator delivery view" ("Operator
 * nav") and both `/deliveries` mocks.
 */
async function expectOperatorTopbar(page: Page) {
  await expect(page.getByTestId("brand-home")).toBeVisible()
  await expect(page.getByTestId("identity-email")).toHaveText(`signed in as ${OPERATOR_EMAIL}`)
  for (const hook of CUSTOMER_TOPBAR) {
    await expect(
      page.getByTestId(hook),
      `the operator topbar is not ms-1's customer one: ${hook} has no place on it`,
    ).toHaveCount(0)
  }
}

// ── the slice ───────────────────────────────────────────────────────────────

test.describe("ms-3 issue 55 the operator delivery view", () => {
  test("the operator sees every customer's outbox rows, not only one caller's own", async ({
    browser,
    baseURL,
    request,
  }) => {
    // #55's opening gap: "`GET /outbox` … is scoped to the caller's Access
    // identity — it answers *what did you get* and structurally cannot answer
    // *what is stuck*." And its acceptance surface: "Seed outbox rows for two
    // different customer addresses… As the dev operator identity, `GET
    // /deliveries` lists **both** customers' rows."
    //
    // The operator owns no submissions and no outbox rows of their own, so
    // every row on this screen is somebody else's — which is the whole claim.
    test.setTimeout(120_000)
    const a = await seedRow(browser, baseURL, request, INBOX.bothA, 0, 5500, signoffFields())
    const b = await seedRow(browser, baseURL, request, INBOX.bothB, 1, 5501, {
      question: QUESTION,
      status: "needs-input",
    })

    const operatorContext = await asOperator(browser, baseURL)
    const operator = await operatorContext.newPage()
    const rows = await readDeliveries(operator)

    for (const [recipient, seeded] of [
      [INBOX.bothA, a],
      [INBOX.bothB, b],
    ] as const) {
      const row = rowFor(rows, recipient)
      expect(
        row.recipient,
        "contract § The operator delivery view: the recipient is rendered verbatim and " +
          "unredacted — \"a delivery view that hid *who* a stuck email was addressed to would " +
          'defeat the point of the screen"',
      ).toContain(recipient)
      expect(
        row.subject,
        "`delivery-subject` is the row's own subject line — the same send the customer's own " +
          "screen shows, not a placeholder",
      ).toContain(seeded.subject as string)
      assertRowIsWellFormed(row, `the row for ${recipient}`)
    }

    // Not just "both present": present on ONE screen, for a caller who owns
    // neither. A `/deliveries` that were scoped like `/outbox` would render an
    // empty list here, since the operator has decided no sends of their own.
    expect(
      rows.length,
      "two customers' rows are on the operator's screen at once, and this run seeded more",
    ).toBeGreaterThanOrEqual(2)

    // Contract § The operator delivery view, "Row surface": deliberately NOT the
    // full `email-preview` DOM — "an operator triaging a stuck send needs enough
    // to identify and diagnose the row, not a rendered copy of the… content".
    //
    // TODO(test-author): asserted as absence of `email-body` / `email-preheader`
    // / `email-cta` only. The contract says "no `email-body`, no
    // `email-preheader`, no `email-cta`" in as many words, so those three are
    // fair; it says nothing about whether an implementer may ALSO render an
    // `email-preview` article, so that is not asserted either way.
    for (const hook of ["email-body", "email-preheader", "email-cta"]) {
      await expect(
        operator.getByTestId(hook),
        `contract § Row surface: \`${hook}\` is not part of the operator's row`,
      ).toHaveCount(0)
    }

    await operatorContext.close()
  })

  test("the delivery view is a 404 to a customer who owns rows in it", async ({
    browser,
    baseURL,
    request,
  }) => {
    // #55: "As an ordinary customer identity, `GET /deliveries` **404s** — same
    // response as a route that does not exist." Contract § The operator delivery
    // view: "No Access identity, or an identity not on the allowlist, gets the
    // same 404 `leadsNotFound()` already renders for `/leads` — never a login
    // redirect, never a 403 that confirms `/deliveries` exists."
    //
    // The seeded customer is the sharpest case: their OWN row is on the screen
    // they may not read.
    test.setTimeout(120_000)
    const seeded = await seedRow(browser, baseURL, request, INBOX.gate, 2, 5502, {
      status: "shipped",
    })

    const strangerContext = await asStranger(browser, baseURL)
    const customerContext = await withIdentity(browser, baseURL, INBOX.gate)

    // A path that certainly does not exist, so "the same response as a route
    // that does not exist" is measured against an actual one rather than
    // asserted from memory.
    const absent = "/no-such-route-55-operator-deliveries"

    for (const [who, ctx] of [
      ["an anonymous caller", strangerContext],
      ["a customer identity", customerContext],
    ] as const) {
      const response = await ctx.request.get(DELIVERIES, {
        maxRedirects: 0,
        failOnStatusCode: false,
      })
      expect(
        response.status(),
        `${who} gets a 404 from ${DELIVERIES} — never a 403, never a 30x login redirect`,
      ).toBe(404)

      const control = await ctx.request.get(absent, { maxRedirects: 0, failOnStatusCode: false })
      expect(control.status(), `${who} gets a 404 from a route that does not exist`).toBe(404)

      const body = await response.text()
      expect(
        body,
        `${who} is not told the operator surface exists (a response that only fires for ` +
          "non-operators confirms the surface to anyone who finds the URL)",
      ).not.toContain('data-testid="deliveries-list"')
      expect(body, `${who} learns nothing about another customer's row`).not.toContain(
        'data-testid="delivery-row"',
      )
      expect(body, `${who} does not even see their own row here`).not.toContain(INBOX.gate)
      if (seeded.subject) {
        expect(body, `${who} learns nothing about what was sent`).not.toContain(seeded.subject)
      }
    }

    // The gate is a gate, not an outage: the same run, the same seeded row, the
    // operator identity — 200. Without this, a route that 404s for EVERYONE
    // would pass the two checks above.
    const operatorContext = await asOperator(browser, baseURL)
    const operator = await operatorContext.newPage()
    const rows = await readDeliveries(operator)
    const row = rowFor(rows, INBOX.gate)
    expect(
      row.status,
      "the row the customer was refused a sight of is on the operator's screen",
    ).not.toBeNull()

    // TODO(test-author): the two 404s are asserted to be indistinguishable by
    // STATUS and by the absence of any `/deliveries` marker, not by byte
    // equality with the control body. The contract pins "the same
    // indistinguishable 404" behaviourally (via `leadsNotFound()`), and ms-2's
    // own slice reads it the same way; requiring the two response bodies to be
    // identical would pin a not-found page's markup that no contract states.

    await strangerContext.close()
    await customerContext.close()
    await operatorContext.close()
  })

  test("a customer's own outbox stays scoped to them while the operator's view is not", async ({
    browser,
    baseURL,
    request,
  }) => {
    // #55's acceptance surface: "`GET /outbox` continues to show the caller
    // their own rows only, unchanged." The point of asserting it here, in #55's
    // slice, is that the new unscoped query is the obvious way to break it — a
    // worker who makes the outbox listing unscoped and filters in the template
    // passes every `/deliveries` test in this file and leaks every customer's
    // mail to every other customer.
    test.setTimeout(120_000)
    const a = await seedRow(browser, baseURL, request, INBOX.scopedA, 0, 5503, signoffFields())
    const b = await seedRow(browser, baseURL, request, INBOX.scopedB, 1, 5504, {
      question: QUESTION,
      status: "needs-input",
    })

    // Read A's outbox WITHOUT the recipient filter the helpers use, so what is
    // measured is the page itself, not a filtered view of it.
    const context = await withIdentity(browser, baseURL, INBOX.scopedA)
    const page = await context.newPage()
    const response = await page.goto(OUTBOX)
    expect(response?.ok(), "the customer reaches their own outbox").toBe(true)

    const previews = page.getByTestId("email-preview")
    const count = await previews.count()
    expect(count, "customer A decided exactly one send of their own").toBeGreaterThanOrEqual(1)
    for (let i = 0; i < count; i++) {
      const to = previews.nth(i).getByTestId("email-to")
      expect(
        flat(await to.first().innerText()),
        "every row on a customer's outbox is addressed to that customer — `/outbox` is scoped " +
          "to the caller's Access identity, and #55 changes nothing about it",
      ).toContain(INBOX.scopedA)
    }
    const bodyA = flat(await page.locator("body").innerText())
    expect(bodyA, "customer A's screen never mentions customer B").not.toContain(INBOX.scopedB)
    if (b.subject && b.subject !== a.subject) {
      expect(bodyA, "customer A's screen never shows customer B's subject").not.toContain(b.subject)
    }

    // The same two rows, one screen, for the operator.
    const operatorContext = await asOperator(browser, baseURL)
    const operator = await operatorContext.newPage()
    const rows = await readDeliveries(operator)
    rowFor(rows, INBOX.scopedA)
    rowFor(rows, INBOX.scopedB)

    await context.close()
    await operatorContext.close()
  })

  test("a failed row shows the operator the raw provider error and the customer none of it", async ({
    browser,
    baseURL,
    request,
  }) => {
    // THE TEST THIS ISSUE EXISTS FOR. #55: "On a `failed` row, `/deliveries`
    // shows the raw provider error while `/outbox` shows only the customer-safe
    // copy — asserted on the same underlying row, which is what makes the
    // separation real rather than incidental."
    //
    // Contract § The operator delivery view: `delivery-last-error` here "is the
    // raw `outbox.last_error` column, unredacted… a worker who runs the customer
    // redaction function against this field has misread this contract".
    //
    // The `failed` row is produced with #50's drain and #51's `mailfail` hook —
    // instruments, per the header. Nothing here asserts how it got there.
    test.setTimeout(180_000)
    await seedRow(browser, baseURL, request, INBOX.rawError, 2, 5505, signoffFields())

    const customerContext = await withIdentity(browser, baseURL, INBOX.rawError)
    const customer = await customerContext.newPage()
    const [customerRow] = await drainUntil(
      customer,
      request,
      INBOX.rawError,
      (current) => current.length === 1 && current[0].status === "failed",
      "a `mailfail` recipient must reach `failed` so the two error surfaces can be compared",
    )

    expect(customerRow.status, "positive control: the row really is `failed`").toBe("failed")
    const customerCopy = customerRow.detail["delivery-last-error"]
    expect(
      customerCopy,
      "contract § hooks: `delivery-last-error` is present iff the row is `failed`",
    ).not.toBeNull()
    for (const [pattern, why] of [...FORBIDDEN, ...INFRA_FORBIDDEN]) {
      expect(
        customerCopy as string,
        `\`/outbox\` renders customer copy, never \`outbox.last_error\` verbatim: ${why}`,
      ).not.toMatch(pattern)
    }

    const operatorContext = await asOperator(browser, baseURL)
    const operator = await operatorContext.newPage()
    const operatorRow = rowFor(await readDeliveries(operator), INBOX.rawError)

    expect(
      operatorRow.status,
      "the same underlying row, seen from the operator's screen, is the same state",
    ).toBe("failed")
    expect(operatorRow.pillText, "…and reads with the same pinned vocabulary").toBe(
      STATUS_TEXT.failed,
    )
    const rawError = operatorRow.detail["delivery-last-error"]
    expect(
      rawError,
      "contract § The operator delivery view: `delivery-last-error` is present iff `failed`",
    ).not.toBeNull()
    expect(
      (rawError as string).length,
      "an operator diagnosing a wedged send needs the provider's actual message — an empty " +
        "error field is the `wrangler d1 execute` situation this issue exists to end",
    ).toBeGreaterThan(0)

    // The separation itself. Same row, two screens, two strings. If a worker
    // parameterised one rendering path with an `isOperator` flag and passed the
    // wrong value — or simply reused the customer-safe copy here — these are
    // equal, and this assertion is the only one in the milestone that notices.
    expect(
      rawError,
      "contract § The operator delivery view: this field is the RAW `outbox.last_error`, and " +
        "the customer-safe section \"governs the *customer*-scoped route only\". Identical text " +
        "on both screens means either the customer is being shown the provider's error or the " +
        "operator is being shown a redaction of it — one of the two audiences is wrong",
    ).not.toBe(customerCopy)

    expect(
      operatorRow.detail["delivery-attempts"] as string,
      "the operator also sees how many times it was tried before giving up",
    ).toMatch(/\d+/)

    // TODO(test-author): the RAW string's content is not asserted, only that it
    // is non-empty and differs from the customer's copy. Neither #55 nor the
    // contract pins what #51's fake writes into `last_error` for a `mailfail`
    // recipient ("Exact format not pinned"); `mocks/05` shows "Resend API
    // returned 401: invalid API key" as illustration. Asserting a substring like
    // /resend/i would pin the fake's wording, which is exactly the kind of
    // invention a sealed slice must not make. The consequence is a real gap: an
    // implementation that wrote a DIFFERENT non-empty operator-facing string
    // (rather than the column verbatim) would pass this test.
    //
    // TODO(test-author): `delivery-provider-id` is not asserted, on this row or
    // the `sent` rows above. Contract § The operator delivery view and Notes
    // item 8: "not required by this contract; additive if present", and "an
    // implementer who omits it has still met this contract". A test requiring it
    // would need a contract amendment.

    await customerContext.close()
    await operatorContext.close()
  })

  test("every delivery state renders on the operator's screen with its pinned detail", async ({
    browser,
    baseURL,
    request,
  }) => {
    // `mocks/05-deliveries-mixed.html` is the realistic screen: "three rows
    // across three different customers, one of each delivery state". #55's
    // acceptance surface asks for the same thing — "two different customer
    // addresses across all three delivery states" — so this drives one row into
    // each of `sent`, `failed` and `queued` and reads them on one screen.
    //
    // ORDER MATTERS in the seeding below: the `queued` row is seeded LAST, after
    // the drain has stopped running, because a drain fired for the other two
    // would claim it as well and there would be no `queued` row left to look at.
    test.setTimeout(240_000)

    // 1. `sent` — an ordinary recipient the fake accepts.
    await seedRow(browser, baseURL, request, INBOX.statesSent, 0, 5506, signoffFields())
    const sentContext = await withIdentity(browser, baseURL, INBOX.statesSent)
    const sentPage = await sentContext.newPage()
    await drainUntil(
      sentPage,
      request,
      INBOX.statesSent,
      (current) => current.length === 1 && current[0].status === "sent",
      "a recipient #51's fake accepts must reach `sent`",
    )
    await sentContext.close()

    // 2. `failed` — the `mailfail` hook, a different customer.
    await seedRow(browser, baseURL, request, INBOX.statesFailed, 1, 5507, {
      question: QUESTION,
      status: "needs-input",
    })
    const failedContext = await withIdentity(browser, baseURL, INBOX.statesFailed)
    const failedPage = await failedContext.newPage()
    await drainUntil(
      failedPage,
      request,
      INBOX.statesFailed,
      (current) => current.length === 1 && current[0].status === "failed",
      "a `mailfail` recipient must reach `failed`",
    )
    await failedContext.close()

    // 3. `queued` — decided after the last drain call, so nothing has claimed it.
    await seedRow(browser, baseURL, request, INBOX.statesQueued, 2, 5508, { status: "shipped" })

    const operatorContext = await asOperator(browser, baseURL)
    const operator = await operatorContext.newPage()
    const rows = await readDeliveries(operator)

    const expected: Array<[string, DeliveryStatus]> = [
      [INBOX.statesQueued, "queued"],
      [INBOX.statesSent, "sent"],
      [INBOX.statesFailed, "failed"],
    ]
    for (const [recipient, status] of expected) {
      const row = rowFor(rows, recipient)
      expect(
        row.status,
        `${recipient}: the operator's screen reports the same delivery state the customer's own ` +
          "screen does — one state machine, two renderings",
      ).toBe(status)
      assertRowIsWellFormed(row, `the \`${status}\` row (${recipient})`)
    }

    // The invariant over the WHOLE screen, not only this test's three rows:
    // every row every slice in this run has ever seeded is here, and none of
    // them may invent a fourth state or break a presence rule.
    for (const row of rows) {
      assertRowIsWellFormed(row, `row ${row.index + 1} of ${rows.length}`)
    }

    // TODO(test-author): `deliveries-list-empty` (mock `06`) is NOT asserted
    // anywhere in this slice, and this is a real gap. Contract § The operator
    // delivery view pins it as "present instead, if and only if there are zero
    // `outbox` rows across every customer", and pins that it is DISTINCT from
    // the 404 a non-operator gets — but the acceptance database is wiped per
    // *run*, not per *test* (`tests/acceptance/README.md` § Determinism), and
    // ms-1's, ms-2's, #49's and #50's slices all sort before this file and seed
    // outbox rows of their own. There is no point in this run at which the
    // outbox is globally empty, so the state is unreachable from a sealed slice.
    // The same limitation ms-2's `33-lead-triage-promotion.spec.ts` records for
    // `leads-list-empty`. What IS asserted, in the 404 test above, is the half
    // that matters for confusion between the two: a non-operator gets a 404
    // while rows exist, and the operator gets a 200 for the same rows.

    await operatorContext.close()
  })

  test("the operator's screen puts the most recent activity first", async ({
    browser,
    baseURL,
    request,
  }) => {
    // #55's Scope: "Every outbox row across all customers, most recent activity
    // first." Contract § The operator delivery view, "Ordering": a sealed test
    // "can still assert ordering: seed fixtures with known subjects/recipients
    // and distinguishable *server-side* activity times, then assert DOM order
    // matches the expected sequence by row identity (subject + recipient), not
    // by reading a displayed timestamp back out."
    //
    // That is exactly the shape here: two rows, two customers, seeded seconds
    // apart with no drain in between, so their only activity is their creation
    // and the later one must be above the earlier one.
    test.setTimeout(120_000)
    await seedRow(browser, baseURL, request, INBOX.orderFirst, 0, 5509, signoffFields())
    await sleep(1_500)
    await seedRow(browser, baseURL, request, INBOX.orderSecond, 1, 5510, {
      question: QUESTION,
      status: "needs-input",
    })

    const operatorContext = await asOperator(browser, baseURL)
    const operator = await operatorContext.newPage()
    const rows = await readDeliveries(operator)

    const first = rowFor(rows, INBOX.orderFirst)
    const second = rowFor(rows, INBOX.orderSecond)
    expect(
      second.index,
      `"most recent activity first": ${INBOX.orderSecond}'s send was decided after ` +
        `${INBOX.orderFirst}'s and neither has been drained since, so it must appear above it ` +
        `(seen at positions ${second.index + 1} and ${first.index + 1})`,
    ).toBeLessThan(first.index)

    // Relative order of two known rows only — never absolute position. Every
    // other slice in this run has seeded rows onto this same unscoped screen.

    // TODO(test-author): this asserts ordering ONLY between two rows whose sole
    // activity is their creation, deliberately. Contract Notes item 1 records
    // that `outbox.sent_at`'s meaning ("record-creation time" vs "delivery
    // time") is a genuine unresolved conflict in #49's own text, and the
    // "Ordering" section says that conflict is "inherited by `/deliveries`". So
    // a mixed comparison — is a row SENT ten seconds ago more recent than one
    // QUEUED five seconds ago? — has no contract answer, and asserting one would
    // invent behaviour. Nothing here compares across states.
    await operatorContext.close()
  })

  test("the delivery view is part of the operator's surface, alongside leads", async ({
    browser,
    baseURL,
    request,
  }) => {
    // Contract § The operator delivery view, "Operator nav": `operatorTopbar()`
    // "gains a second entry, `nav-deliveries`, and… `aria-current="page"`
    // becomes conditional on which of the two is current". #55's own text puts
    // the same thing behaviourally: `operatorTopbar(operator.email)` "so this
    // reads as one operator surface together with `/leads` rather than a second,
    // differently-shaped admin page". Both `/deliveries` mocks render exactly
    // `brand-home`, `nav-leads`, `nav-deliveries` and `identity-email`.
    test.setTimeout(120_000)
    await seedRow(browser, baseURL, request, INBOX.nav, 2, 5511, { status: "shipped" })

    const operatorContext = await asOperator(browser, baseURL)
    const operator = await operatorContext.newPage()

    await readDeliveries(operator)
    await expectOperatorTopbar(operator)
    await expect(
      operator.getByTestId("nav-leads"),
      "the operator's other surface is one click away — one topbar, two screens",
    ).toHaveAttribute("href", "/leads")
    await expect(operator.getByTestId("nav-deliveries")).toBeVisible()
    await expect(operator.getByTestId("nav-deliveries")).toHaveAttribute("href", DELIVERIES)
    await expect(
      operator.getByTestId("nav-deliveries"),
      "`aria-current=\"page\"` is conditional on which entry is current, and this is /deliveries",
    ).toHaveAttribute("aria-current", "page")

    // The other half of "conditional": on `/leads`, the current entry is leads.
    const leads = await operator.goto("/leads")
    expect(leads?.status(), "the operator reaches their own leads inbox (ms-2, #33)").toBe(200)
    await expect(
      operator.getByTestId("nav-deliveries"),
      "the delivery view is reachable from the leads inbox — otherwise an operator has to know " +
        "the URL to find the screen that shows a stuck send",
    ).toBeVisible()
    await expect(
      operator.getByTestId("nav-deliveries"),
      "on /leads the current page is leads, so `nav-deliveries` is NOT current — a topbar with " +
        "two permanently-current entries tells an operator nothing about where they are",
    ).not.toHaveAttribute("aria-current", "page")
    await expect(operator.getByTestId("nav-leads")).toHaveAttribute("aria-current", "page")

    // TODO(test-author): contract Notes item 9 flags that `/deliveries` as a
    // path and `nav-deliveries` as a hook are "this contract's own inventions,
    // not #55's" (#55 calls the route name "a proposal" and says nothing about
    // navigation). If a worker wires navigation differently, the black-box
    // behaviour the contract says must still hold is the operator-only unscoped
    // list — this nav test is the one in this file that would need the contract
    // amended alongside it.

    await operatorContext.close()
  })
})
