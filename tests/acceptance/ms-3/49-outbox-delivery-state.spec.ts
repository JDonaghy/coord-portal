import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test"

/**
 * ms-3 sealed acceptance slice — issue #49
 * "[portal] Outbox delivery state — queued / sent / failed, visible at /outbox"
 *
 * Written from `tests/acceptance/ms-3/contract.md` (§ "Delivery state vocabulary",
 * § "`data-testid` hooks", § "Customer-safe error copy", § "`outbox` schema
 * additions", § "Route surface") and from the four `/outbox` mocks that contract
 * pins — `mocks/01-outbox-queued.html`, `mocks/02-outbox-sent.html`,
 * `mocks/03-outbox-failed.html`, `mocks/04-outbox-mixed.html` — without sight of
 * any implementation.
 *
 * THE SHAPE UNDER TEST. Issue #49 in its own words: "`outbox` records what the
 * portal decided to send, but a row has no delivery state — nothing distinguishes
 * 'not sent yet' from 'sent' from 'gave up'." So the issue has two halves, and
 * only the second is black-box observable:
 *
 *   REPRESENTABLE  the columns exist (`status`, `provider_message_id`,
 *                  `attempts`, `last_error`, `sent_at`) and existing rows migrate
 *                  to `queued`. A new numbered migration carries them.
 *   VISIBLE        "`GET /outbox` renders the delivery state per row" — a
 *                  `delivery-status` pill from a three-word vocabulary, plus the
 *                  timestamp/attempts/error detail, each present exactly when the
 *                  contract says it is present and never otherwise.
 *
 * The presence RULES are the part that actually needs an oracle. A pill that
 * renders is obvious on sight; a `failed` row that quietly shows the customer
 * "Resend API returned 401" is not, and neither is a `queued` row that shows a
 * delivery timestamp it cannot possibly have.
 *
 * MECHANISM. An outbox row only exists because the portal DECIDED to send —
 * ms-1 issue #14's behaviour, unchanged. The only black-box way to cause a
 * decision is to drive a submission into one of the three sending states, which
 * are all coord-owned, i.e. a bridge push (#15's surface) against a submission
 * authored through #9's intake form. Both are other issues' surfaces, used here
 * as instruments, not as subjects — exactly as `ms-1/14-notifications.spec.ts`
 * uses them.
 *
 * NOT COVERED HERE, deliberately — these belong to the other issues in ms-3:
 *  - **Anything that MOVES a row out of `queued`.** #49's own "Out of scope":
 *    "Actually calling a provider (#B/#C). This issue only makes the state
 *    representable and visible." The drain (`GET /__scheduled`, issue #50) and
 *    the provider seam / `mailfail` fake (issue #51) are the only things that can
 *    produce a `sent` or `failed` row, so this slice never invokes them. What it
 *    does instead is assert the presence rules as a PER-STATUS INVARIANT that is
 *    checked against whatever state each row is actually in — so the same
 *    assertions keep binding, unchanged, once #50 and #51 make `sent` and
 *    `failed` rows reachable.
 *  - `GET /deliveries`, the operator view (#55) and its `nav-deliveries` entry.
 *  - Domain auth / reply routing (#52, `oracle:exempt` by its own issue text).
 *  - The email content itself (`email-subject`, `email-body`, …) — #14's slice
 *    owns that, and `ms-1/14-notifications.spec.ts` still asserts it. This slice
 *    only insists that the delivery state is ADDED to that DOM, never
 *    substituted for it.
 *
 * SYNTHETIC DATA. Per CLAUDE.md rule 1 and contract § "Synthetic data", every
 * address, submission and design round below is invented on the reserved
 * `example.test` TLD. No address here contains the `mailfail` substring: that
 * lever belongs to #51's fake and to #50's slice, and a row driven to `failed`
 * would be a different issue's evidence.
 */

// ── the pinned route ────────────────────────────────────────────────────────

/**
 * Contract § "Route surface (pinned)": `GET /outbox`, customer-scoped, "now
 * renders delivery state per row, in addition to the ms-1 email content". ms-1's
 * own slice had to PROBE for this path (its contract pinned the email DOM but no
 * route); ms-3's contract closes that gap in as many words — "this contract only
 * extends the one route #14 already pinned loosely and #49 now pins exactly" — so
 * this slice hard-codes it.
 */
const OUTBOX = "/outbox"

/**
 * Contract § "The applied migration head — pinned black-box probe (amendment,
 * issue #94)": `GET /api/health`, field `checks.d1.detail`, string form
 * `schema NNNN` — "the pinned black-box probe for the applied migration head,
 * and the only one this contract pins". Unauthenticated by design (a Cloudflare
 * Access **Bypass** application), and pinned reachable at its own path by
 * `ms-1/contract.md`, so it needs no session and cannot be pulled out from under
 * this suite by a customer-facing redesign.
 */
const HEALTH = "/api/health"

// ── the pinned delivery vocabulary ──────────────────────────────────────────

/**
 * Contract § "Delivery state vocabulary (pinned, from issue #49)": the fixed set
 * of `data-status` slugs and the exact pill text each one renders on
 * `delivery-status`. Three slugs, three strings, nothing else ever.
 */
const STATUS_TEXT = {
  queued: "Queued",
  sent: "Sent",
  failed: "Delivery failed",
} as const

type DeliveryStatus = keyof typeof STATUS_TEXT
const STATUSES = Object.keys(STATUS_TEXT) as DeliveryStatus[]

/**
 * Contract § "`data-testid` hooks": the three detail hooks and the exact status
 * each one is present for — "present **if and only if**", the contract's own
 * emphasis. `queued` shows none of them, deliberately: "A `queued` row renders
 * identically regardless of `attempts`… `delivery-attempts` and
 * `delivery-last-error` render **only** on `failed` rows."
 */
const DETAIL_HOOKS = ["delivery-sent-at", "delivery-attempts", "delivery-last-error"] as const
type DetailHook = (typeof DETAIL_HOOKS)[number]

const PRESENT_FOR: Record<DeliveryStatus, DetailHook[]> = {
  queued: [],
  sent: ["delivery-sent-at"],
  failed: ["delivery-attempts", "delivery-last-error"],
}

/** Contract § `data-testid` hooks (ms-1's Emails block, "unchanged, still all
 * present on every row regardless of delivery status"). */
const EMAIL_TESTIDS = [
  "email-from",
  "email-to",
  "email-subject",
  "email-preheader",
  "email-body",
  "email-cta",
] as const

/** ms-1 contract § Emails: the three `data-email-type`s that can exist at all. */
const SEND_TYPES = ["signoff-ready", "needs-input", "shipped"]

// ── the customer-safe copy wall ─────────────────────────────────────────────

/**
 * Contract § "Customer-safe error copy (pinned invariant)": the rendered text of
 * `delivery-last-error` "is **not** `outbox.last_error` verbatim — the DB column
 * holds whatever the provider or an unset key produced… which is
 * operator-debugging material, not customer copy".
 *
 * Two lists, both named by the contract. First, ms-1's own FORBIDDEN array,
 * copied verbatim from `tests/acceptance/ms-1/14-notifications.spec.ts` because
 * the contract names that array by file and says it is "unchanged, still applies
 * to every customer-facing string this milestone adds".
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

/**
 * Second, the infra/provider vocabulary ms-3's contract adds to that list for
 * this milestone's own strings, quoted from § "Customer-safe error copy": "`resend`
 * (case-insensitive), `api key`, `fetch`, any bare 3-digit HTTP status code
 * (`\b\d{3}\b`), `provider`, `endpoint`".
 */
const INFRA_FORBIDDEN: Array<[RegExp, string]> = [
  [/resend/i, "the mail provider is never named to a customer"],
  [/\bapi key\b/i, "a credential is never mentioned to a customer"],
  [/\bfetch\b/i, "a transport verb is engineer-side"],
  [/\b\d{3}\b/, "a bare HTTP status code is operator-debugging material"],
  [/\bprovider\b/i, "the delivery pipeline is not a customer-facing concept"],
  [/\bendpoint\b/i, "an endpoint is engineer-side"],
]

// ── bridge transport (the instrument, not the subject) ──────────────────────

/**
 * The daemon's service-token credential.
 *
 * TODO(test-author): identical to the note in `ms-1/14-notifications.spec.ts` —
 * ms-1's contract pins the two header names and pins missing/invalid ⇒ 401, but
 * not how a Worker booted by `npm run serve:acceptance` (no Access in front of
 * it) learns which pair is valid. ms-3's contract does not reopen the question.
 * Same escape hatch, same defaults, so this slice and ms-1's agree.
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

/**
 * One inbox per test. The acceptance database is wiped per *run*, not per *test*
 * (tests/acceptance/README.md § Determinism) and an outbox is cumulative, so
 * isolation comes from each test owning a distinct synthetic recipient.
 *
 * None of these local-parts contains `mailfail` — contract § "The provider seam"
 * makes that substring the deterministic-failure lever for #51's fake, and a row
 * this slice drove to `failed` would be evidence about #50/#51, not about #49.
 */
const INBOX = {
  born: "rota-born@example.test",
  bare: "rota-bare@example.test",
  vocabulary: "rota-vocabulary@example.test",
  envelope: "rota-envelope-49@example.test",
  copy: "rota-copy@example.test",
}

const REFERENCE = /^SUB-[A-Z0-9]{6}$/

// ── seeding and reading, through the pinned customer surface ────────────────

/** The verified-identity mechanism ms-1's screens assume is in front of them. */
function asCustomer(page: Page, email: string) {
  return page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": email })
}

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

/** Collapse the incidental whitespace of rendered HTML before comparing copy. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

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

// ── the outbox, read as the contract's delivery DOM ─────────────────────────

interface Row {
  /** `data-status` on the `email-preview` article itself. */
  rowStatus: string | null
  /** `data-status` on the `delivery-status` pill inside it. */
  pillStatus: string | null
  /** How many `delivery-status` elements the row contains — must be exactly 1. */
  pillCount: number
  pillText: string | null
  /** Rendered text of each detail hook, or `null` when the hook is absent. */
  detail: Record<DetailHook, string | null>
  /** `data-email-type` — ms-1's hook, unchanged. */
  emailType: string | null
  /** ms-1 email hooks this row failed to render. */
  missingEmailHooks: string[]
  /** Every string this milestone adds to the row, concatenated. */
  deliveryText: string
}

async function readRow(preview: Locator): Promise<Row> {
  const pill = preview.getByTestId("delivery-status")
  const pillCount = await pill.count()

  const detail = {} as Record<DetailHook, string | null>
  const deliveryStrings: string[] = []
  if (pillCount > 0) deliveryStrings.push(flat(await pill.first().innerText()))
  for (const hook of DETAIL_HOOKS) {
    const node = preview.getByTestId(hook)
    if ((await node.count()) === 0) {
      detail[hook] = null
      continue
    }
    detail[hook] = flat(await node.first().innerText())
    deliveryStrings.push(detail[hook] as string)
  }

  const missingEmailHooks: string[] = []
  for (const testid of EMAIL_TESTIDS) {
    if ((await preview.getByTestId(testid).count()) === 0) missingEmailHooks.push(testid)
  }

  return {
    rowStatus: await preview.getAttribute("data-status"),
    pillStatus: pillCount > 0 ? await pill.first().getAttribute("data-status") : null,
    pillCount,
    pillText: pillCount > 0 ? flat(await pill.first().innerText()) : null,
    detail,
    emailType: await preview.getAttribute("data-email-type"),
    missingEmailHooks,
    deliveryText: deliveryStrings.join(" · "),
  }
}

/**
 * Every row on the caller's own `/outbox`, in DOM order. Filtered by `email-to`
 * so that a globally-scoped outbox and a caller-scoped one are both readable —
 * the same indifference `ms-1/14-notifications.spec.ts` builds in.
 */
async function readOutbox(page: Page, to: string): Promise<Row[]> {
  const response = await page.goto(OUTBOX)
  expect(response?.ok(), `contract § Route surface pins \`GET ${OUTBOX}\``).toBe(true)

  const previews = page.getByTestId("email-preview")
  const rows: Row[] = []
  for (let i = 0; i < (await previews.count()); i++) {
    const preview = previews.nth(i)
    const recipient = preview.getByTestId("email-to")
    if ((await recipient.count()) > 0 && !flat(await recipient.first().innerText()).includes(to)) {
      continue
    }
    rows.push(await readRow(preview))
  }
  return rows
}

/**
 * Wait until the caller's outbox holds exactly `expected` rows, then return them.
 * A send is decided asynchronously — issue #14 is "digest-first, not instant" —
 * so this polls rather than reading once.
 */
async function awaitOutbox(page: Page, to: string, expected: number): Promise<Row[]> {
  let rows: Row[] = []
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
 * THE INVARIANT, applied to one row. Everything the contract pins about a row's
 * delivery state that does not depend on WHICH state the row is in — so it holds
 * today, when #49 alone can only produce `queued` rows, and keeps holding
 * unchanged once #50's drain and #51's fake make `sent` and `failed` reachable.
 */
function assertDeliveryStateIsWellFormed(row: Row, where: string) {
  expect(
    row.pillCount,
    `${where}: contract § hooks — \`delivery-status\` is "Always present", exactly once per row`,
  ).toBe(1)
  expect(
    STATUSES as string[],
    `${where}: contract § vocabulary pins \`data-status\` ∈ ${STATUSES.join(" / ")} on the row`,
  ).toContain(row.rowStatus)
  expect(
    row.pillStatus,
    `${where}: the pill's \`data-status\` must agree with the row's — one row, one state`,
  ).toBe(row.rowStatus)

  const status = row.rowStatus as DeliveryStatus
  expect(
    row.pillText,
    `${where}: contract § vocabulary pins \`${status}\` ⇒ pill text exactly "${STATUS_TEXT[status]}"`,
  ).toBe(STATUS_TEXT[status])

  for (const hook of DETAIL_HOOKS) {
    const expected = PRESENT_FOR[status].includes(hook)
    if (expected) {
      expect(
        row.detail[hook],
        `${where}: contract § hooks — \`${hook}\` is present if and only if the row is \`${status}\``,
      ).not.toBeNull()
      expect(
        (row.detail[hook] as string).length,
        `${where}: \`${hook}\` renders on a \`${status}\` row, so it must say something`,
      ).toBeGreaterThan(0)
    } else {
      expect(
        row.detail[hook],
        `${where}: contract § hooks — \`${hook}\` must be absent on a \`${status}\` row ` +
          `(present if and only if the row is \`${PRESENT_FOR.sent.includes(hook) ? "sent" : "failed"}\`)`,
      ).toBeNull()
    }
  }

  if (status === "failed") {
    expect(
      row.detail["delivery-attempts"] as string,
      `${where}: contract § hooks — \`delivery-attempts\` "Must contain at least one base-10 integer"`,
    ).toMatch(/\d+/)
    // Contract § "Customer-safe error copy" — the pinned invariant, checked here
    // rather than in its own test so that it binds the moment #50/#51 make a
    // `failed` row reachable, without a second seeding path to maintain.
    for (const [pattern, why] of [...FORBIDDEN, ...INFRA_FORBIDDEN]) {
      expect(
        row.detail["delivery-last-error"] as string,
        `${where}: \`delivery-last-error\` is customer copy, not \`outbox.last_error\` — ${why}`,
      ).not.toMatch(pattern)
    }
  }

  // TODO(test-author): `provider_message_id` is asserted nowhere in this slice.
  // #49 commits to the column, but contract § hooks is explicit that
  // `delivery-provider-id` is "**not part of this contract**… no test in this
  // milestone should require it", and nothing black-box can read a D1 column the
  // portal does not render. The column's existence is therefore covered only
  // indirectly, by "the delivery-state columns arrive as a numbered migration"
  // below — a real gap, and a deliberate one.
}

// ── the slice ───────────────────────────────────────────────────────────────

test.describe("ms-3 issue 49 outbox delivery state", () => {
  test("a decided send is born queued, and the outbox says so", async ({ page, request }) => {
    // Contract § "Delivery state vocabulary": `queued` means "decided, not yet
    // delivered", and `mocks/01-outbox-queued.html`'s own header calls it "the
    // state a row is born into the instant the portal decides to send… BEFORE the
    // #50 drain has ever claimed it". Nothing in this slice invokes that drain
    // (contract § "Triggering the drain in the sealed suite": `GET /__scheduled`
    // is the only way, and it is #50's slice that calls it), so a freshly decided
    // send must still read `queued` here.
    await asCustomer(page, INBOX.born)
    const reference = await seedSubmission(page, 0)

    expect(
      (await readOutbox(page, INBOX.born)).length,
      "authoring a submission decides no send, so there is no row to have a state",
    ).toBe(0)

    expect(
      (await pushFields(request, reference, 4900, signoffFields())).outcome,
      "a design round is entirely coord-owned",
    ).toBe("applied")

    const [row] = await awaitOutbox(page, INBOX.born, 1)
    expect(
      row.rowStatus,
      "contract § hooks: the `email-preview` article carries `data-status`",
    ).toBe("queued")
    expect(row.pillCount, "contract § hooks: `delivery-status` is always present").toBe(1)
    expect(row.pillStatus, "…carrying the same slug as the row").toBe("queued")
    expect(row.pillText, 'contract § vocabulary: `queued` renders exactly "Queued"').toBe("Queued")
  })

  test("a queued row shows no delivery time, attempt count, or failure copy", async ({
    page,
    request,
  }) => {
    // Contract § hooks, the contract's own emphasis: `delivery-sent-at` is
    // present "**if and only if** `data-status=\"sent\"`", and
    // `delivery-attempts` / `delivery-last-error` "render **only** on `failed`
    // rows". A queued row that renders a delivery timestamp is claiming a
    // delivery that has not happened — the exact confusion #49 exists to end
    // ("nothing distinguishes 'not sent yet' from 'sent'").
    await asCustomer(page, INBOX.bare)
    const reference = await seedSubmission(page, 1)

    expect(
      (await pushFields(request, reference, 4910, { question: QUESTION, status: "needs-input" }))
        .outcome,
      "coord owns both `question` and `status`",
    ).toBe("applied")

    const [row] = await awaitOutbox(page, INBOX.bare, 1)
    // Positive control: absence proves nothing next to a row that failed to
    // render its state at all.
    expect(row.pillText, "the row really rendered a queued delivery state").toBe("Queued")

    for (const hook of DETAIL_HOOKS) {
      expect(
        row.detail[hook],
        `contract § hooks: a \`queued\` row must not render \`${hook}\``,
      ).toBeNull()
    }

    // The whole screen, not just this row: a queued-only outbox has no business
    // rendering a single delivery timestamp or failure line anywhere.
    for (const hook of DETAIL_HOOKS) {
      await expect(
        page.getByTestId(hook),
        `nothing on this customer's outbox is sent or failed, so no \`${hook}\` may appear`,
      ).toHaveCount(0)
    }

    // TODO(test-author): the mid-retry case — `attempts > 0` with `status` still
    // `queued` — is NOT exercised here, because reaching it requires #50's drain
    // and #51's failing fake. Contract § vocabulary pins that it "renders
    // identically to `01-outbox-queued.html`", i.e. exactly the absences above,
    // so the assertions that would catch a regression are already written; only
    // the seeding path belongs to another issue's slice.
  })

  test("every outbox row carries exactly one delivery state from the pinned vocabulary", async ({
    page,
    request,
  }) => {
    // `mocks/04-outbox-mixed.html` is the realistic screen: several rows, each
    // with its own independent delivery state, rendered from "one template,
    // several `data-status` values" (contract § "Mock inventory"). This test
    // drives one customer through all three sending states so the invariant is
    // checked against three separate rows, and states it as a per-status rule
    // rather than as "they are all queued" — so it keeps binding once #50 and #51
    // can move a row on.
    await asCustomer(page, INBOX.vocabulary)
    const reference = await seedSubmission(page, 2)

    let revision = 4920
    const pushes: Array<Record<string, unknown>> = [
      signoffFields(),
      { question: QUESTION, status: "needs-input" },
      { status: "shipped" },
    ]
    for (const [index, fields] of pushes.entries()) {
      expect(
        (await pushFields(request, reference, revision++, fields)).outcome,
        "`status` is coord-owned",
      ).toBe("applied")
      await awaitOutbox(page, INBOX.vocabulary, index + 1)
    }

    const rows = await readOutbox(page, INBOX.vocabulary)
    expect(rows.length, "three sending states decided three sends").toBe(3)

    for (const [index, row] of rows.entries()) {
      assertDeliveryStateIsWellFormed(row, `row ${index + 1} of ${rows.length}`)
    }

    // No row invents a fourth state, and the page renders no pill outside the
    // rows either.
    const pills = page.getByTestId("delivery-status")
    await expect(pills, "one delivery pill per row, and none loose on the page").toHaveCount(
      rows.length,
    )
    for (let i = 0; i < rows.length; i++) {
      expect(
        STATUSES as string[],
        "contract § vocabulary is a fixed set — nothing else is renderable",
      ).toContain(await pills.nth(i).getAttribute("data-status"))
    }

    // TODO(test-author): ordering is NOT asserted. Contract note 2 says list
    // ordering is "unchanged from ms-1 (oldest first) — not re-pinned by #49 or
    // #50, inferred here", and note 1 records that `sent_at`'s meaning is a
    // genuine unresolved conflict in #49's own text. Asserting an order this
    // contract explicitly declines to pin would invent behaviour.
  })

  test("the delivery state is added to the ms-1 email, not substituted for it", async ({
    page,
    request,
  }) => {
    // Contract § hooks is emphatic that #49 EXTENDS ms-1's block: every
    // `email-preview` keeps `data-email-type`, `email-from`, `email-to`,
    // `email-subject`, `email-preheader`, `email-body`, `email-cta` —
    // "unchanged, still all present on every row regardless of delivery status"
    // — and "ms-1's own sealed suite… must keep working unmodified". A worker who
    // rebuilds `/outbox` as a delivery table rather than adding a delivery block
    // to the email card breaks #14 while passing #49.
    await asCustomer(page, INBOX.envelope)
    const reference = await seedSubmission(page, 0)

    let revision = 4930
    for (const fields of [signoffFields(), { question: QUESTION, status: "needs-input" }]) {
      expect((await pushFields(request, reference, revision++, fields)).outcome).toBe("applied")
    }
    const rows = await awaitOutbox(page, INBOX.envelope, 2)

    for (const [index, row] of rows.entries()) {
      const where = `row ${index + 1}`
      // The new half.
      assertDeliveryStateIsWellFormed(row, where)
      // The ms-1 half, alongside it rather than instead of it.
      expect(
        row.missingEmailHooks,
        `${where}: the delivery state must not displace ms-1's email hooks`,
      ).toEqual([])
      expect(
        SEND_TYPES,
        `${where}: ms-1's \`data-email-type\` survives the delivery-state addition`,
      ).toContain(row.emailType)
    }

    expect(
      rows.map((row) => row.emailType).sort(),
      "two sending states, two emails, each still identifying what it is",
    ).toEqual(["needs-input", "signoff-ready"])
  })

  test("the delivery state a customer can read leaks no provider or engineer-side vocabulary", async ({
    page,
    request,
  }) => {
    // Contract § "Customer-safe error copy" applies to `delivery-last-error` by
    // name, but frames the wider rule too: ms-1's FORBIDDEN list is "unchanged,
    // still applies to every customer-facing string this milestone adds". So the
    // check here is over every string #49 adds to the row — the pill, the
    // timestamp, the attempts line, the failure copy — not just the error field,
    // because "Queued (attempt 3, Resend 429)" would satisfy a field-scoped rule
    // and still put a provider error in front of a customer.
    await asCustomer(page, INBOX.copy)
    const reference = await seedSubmission(page, 1)

    expect((await pushFields(request, reference, 4940, { status: "shipped" })).outcome).toBe(
      "applied",
    )
    const [row] = await awaitOutbox(page, INBOX.copy, 1)

    // Positive control first: a row that rendered no delivery state leaks
    // nothing and proves nothing.
    assertDeliveryStateIsWellFormed(row, "the shipped row")
    expect(row.deliveryText.length, "the delivery state really rendered").toBeGreaterThan(0)

    for (const [pattern, why] of [...FORBIDDEN, ...INFRA_FORBIDDEN]) {
      expect(
        row.deliveryText,
        `the delivery state is customer-facing copy: ${why}`,
      ).not.toMatch(pattern)
    }

    // TODO(test-author): the contract pins no wording for any of these fields
    // ("Exact wording not pinned"; `mocks/03`'s "We tried 5 times" and
    // "We couldn't deliver this message…" are called illustrative only), so this
    // asserts what the copy must NOT contain plus non-emptiness, never a string.
  })

  test("the delivery-state columns arrive as a numbered migration past the ms-1 head", async ({
    request,
  }) => {
    // Contract § "`outbox` schema additions (issue #49)": "New numbered
    // migration… `e2e/smoke.spec.ts` currently pins `/schema 0009/`… Per #49's
    // own note, this pin moves in the same commit that adds the migration."
    // #49's own Notes warn that a duplicate leading number is "exactly the defect
    // that cost #14 two rounds, twice" — a migration that failed to apply, or was
    // never added, shows up here rather than as five confusing DOM failures above.
    //
    // The head is read from `GET /api/health` → `checks.d1.detail`, which
    // contract § "The applied migration head — pinned black-box probe" pins as
    // the probe for this state, "full stop". Deliberately NOT off a customer
    // page: the same clause records that `/` "carries no `#d1` readout, no schema
    // string, and no diagnostics of any kind" as of ms-1 issue #84, and forbids
    // any test in this milestone from probing schema/migration/binding state
    // through a customer page at all.
    const response = await request.get(HEALTH, { failOnStatusCode: false })
    expect(
      response.status(),
      `\`GET ${HEALTH}\` is the pinned probe for the applied migration head, and answers ` +
        "without a session by design (contract § \"The applied migration head\", item 2)",
    ).toBe(200)

    const body = (await response.json()) as { checks?: { d1?: { detail?: unknown } } }
    const detail = body?.checks?.d1?.detail
    const shown = flat(typeof detail === "string" ? detail : JSON.stringify(detail ?? null))
    expect(
      shown,
      `\`checks.d1.detail\` reports the applied migration head in the pinned \`schema NNNN\` ` +
        `form — ${HEALTH} answered "${shown}"`,
    ).toMatch(/schema\s*\d+/)

    const head = Number(/schema\s*(\d+)/.exec(shown)?.[1])
    expect(
      head,
      `#49 adds a new numbered migration for status/provider_message_id/attempts/last_error, ` +
        `so the applied head must move past ms-1's 0009 — \`checks.d1.detail\` still says ` +
        `"${shown}"`,
    ).toBeGreaterThan(9)

    // TODO(test-author): deliberately a strict inequality, not `=== 10`. #49's
    // own note says to check `origin/main`'s migrations directory "at the moment
    // you write it" rather than assuming the next number, so pinning 0010 here
    // would freeze a number the issue itself refuses to freeze. This asserts only
    // that the head moved.
    //
    // (The TODO that used to sit here — flagging that the `#d1` / "schema NNNN"
    // readout was not pinned by `ms-3/contract.md` itself, but inherited from
    // `e2e/smoke.spec.ts:19` and ms-1's landing page — is resolved by issue #94.
    // Contract § "The applied migration head — pinned black-box probe" now pins
    // the probe, the field and the string form outright, so a format change is a
    // contract amendment by construction rather than a silent edit. The unsealed
    // smoke spec's own `/schema \d+/` pin is separate and not governed here, per
    // item 4 of that section.)
  })
})
