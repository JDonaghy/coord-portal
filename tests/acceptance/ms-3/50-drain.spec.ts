import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test"

/**
 * ms-3 sealed acceptance slice — issue #50
 * "[portal] The drain — a Cron Trigger that sends queued outbox rows, retries,
 *  and gives up visibly"
 *
 * Written from `tests/acceptance/ms-3/contract.md` (§ "Triggering the drain in
 * the sealed suite", § "The provider seam", § "Delivery state vocabulary",
 * § "`data-testid` hooks", § "Customer-safe error copy", § "Route surface") and
 * from the `/outbox` mocks that contract pins — `mocks/01-outbox-queued.html`,
 * `mocks/02-outbox-sent.html`, `mocks/03-outbox-failed.html`,
 * `mocks/04-outbox-mixed.html` — without sight of any implementation.
 *
 * THE SHAPE UNDER TEST. #49 made delivery state representable and visible but,
 * in its own words, moves nothing: "Nothing moves a `queued` outbox row. This
 * issue adds the loop that does." So #50 is four claims, and all four are
 * observable through the one screen #49 already pinned, once the drain is fired:
 *
 *   MOVES      a `queued` row that the drain claims and the provider accepts
 *              becomes `sent`, with a delivery time.
 *   ONLY THEN  nothing moves it before that. "Why a cron and not the request
 *              path" is the issue's own heading: #14 shipped three defects that
 *              all trace back to doing notification work inside the request
 *              path, and "the outbox exists precisely so sending happens
 *              somewhere a failure cannot reach the customer's request."
 *   RETRIES    one provider failure is not a give-up — the row stays `queued`
 *              (and, per contract § vocabulary, stays visually indistinguishable
 *              from a fresh one) while attempts accumulate.
 *   GIVES UP   VISIBLY: after N attempts the row is terminal `failed`, showing
 *              an attempt count and customer-safe failure copy, and never moves
 *              again.
 *
 * Plus the one #50 calls out as "the thing to get right": CLAIMING SAFETY. Two
 * overlapping invocations must not double-send. Contract § "Claiming safety"
 * pins the black-box form of that: fire two `GET /__scheduled` requests
 * concurrently and assert the row reaches "exactly the outcome consistent with
 * **one** send… rather than any doubled side effect."
 *
 * MECHANISM, and its two seams. A row only exists because the portal DECIDED to
 * send (#14's behaviour, driven here through #9's intake form and #15's bridge
 * push, both used as instruments, not subjects — the same instruments
 * `ms-1/14-notifications.spec.ts` and `ms-3/49-outbox-delivery-state.spec.ts`
 * use). Moving it then needs two things this slice does not own:
 *
 *  1. `GET /__scheduled` — contract § "Triggering the drain in the sealed
 *     suite". The only way a black-box test can invoke a Cron Trigger. The
 *     contract flags it as unverified against this repo's wrangler version AND
 *     notes `serve:acceptance` does not yet pass `--test-scheduled`, so this
 *     slice fails with a legible, actionable message rather than a 404 stack —
 *     see `DRAIN_UNAVAILABLE`.
 *  2. The #51 fake, selected by `env.MAIL_PROVIDER === "fake"` — contract
 *     § "The provider seam". Its `mailfail` local-part hook is "the only
 *     black-box lever the sealed suite has to drive a row all the way to
 *     `failed`". Every recipient below either contains that substring on
 *     purpose or contains none of it on purpose.
 *
 * NOT COVERED HERE, deliberately:
 *  - **Whether mail is delivered.** #53's own framing: "nothing in this repo can
 *    observe a real inbox." This slice asserts outbox state transitions, which
 *    is what the issue's own "Acceptance surface" section says to assert.
 *  - **The per-row DOM rules themselves** (pill vocabulary, presence rules,
 *    ms-1's email hooks). #49's slice owns those; they are re-asserted here only
 *    where a transition is what makes them reachable at all.
 *  - **`MailProvider`'s interface and its fake's internals** (#51) — code-level
 *    seams, "never imported or called directly" by this suite per the contract.
 *  - **`GET /deliveries`** (#55) and domain auth / reply routing (#52,
 *    `oracle:exempt`).
 *
 * SYNTHETIC DATA. Per CLAUDE.md rule 1 and contract § "Synthetic data", every
 * address, submission and design round below is invented on the reserved
 * `example.test` TLD.
 */

// ── the two pinned routes ───────────────────────────────────────────────────

/** Contract § "Route surface (pinned)". */
const OUTBOX = "/outbox"

/**
 * Contract § "Triggering the drain in the sealed suite (issue #50 — pinned,
 * flagged as needing verification)": "**`GET /__scheduled`** (optionally
 * `?cron=<pattern>`)… This contract pins that route as the trigger mechanism,
 * since it is the only one that exists."
 */
const DRAIN = "/__scheduled"

const DRAIN_UNAVAILABLE =
  `ms-3 issue #50 has no way to be triggered: \`GET ${DRAIN}\` did not answer 2xx. ` +
  "Contract § \"Triggering the drain in the sealed suite\" pins that path as the only " +
  "black-box way to invoke a Cron Trigger, and flags TWO things the #50 implementer must " +
  "do before this slice can pass: (1) verify the path/flag against this repo's installed " +
  "wrangler (^4.0.0) — amend the contract if it differs; (2) add `--test-scheduled` to BOTH " +
  "`serve:acceptance` and `serve:test` in package.json, since without it wrangler dev does " +
  "not expose the route at all and every assertion in this slice is ungateable. That is a " +
  "normal source change outside tests/acceptance/**, called out in the contract by name."

// ── the pinned delivery vocabulary (contract § "Delivery state vocabulary") ──

const STATUS_TEXT = {
  queued: "Queued",
  sent: "Sent",
  failed: "Delivery failed",
} as const

type DeliveryStatus = keyof typeof STATUS_TEXT

/** Contract § "`data-testid` hooks": present **if and only if** these statuses. */
const DETAIL_HOOKS = ["delivery-sent-at", "delivery-attempts", "delivery-last-error"] as const
type DetailHook = (typeof DETAIL_HOOKS)[number]

const PRESENT_FOR: Record<DeliveryStatus, DetailHook[]> = {
  queued: [],
  sent: ["delivery-sent-at"],
  failed: ["delivery-attempts", "delivery-last-error"],
}

// ── the customer-safe copy wall ─────────────────────────────────────────────

/**
 * Contract § "Customer-safe error copy (pinned invariant)". Two lists, both
 * named by the contract: ms-1's own FORBIDDEN array (copied verbatim from
 * `tests/acceptance/ms-1/14-notifications.spec.ts`, which the contract names by
 * file and calls "unchanged, still applies to every customer-facing string this
 * milestone adds") and the infra/provider vocabulary ms-3 adds on top of it.
 *
 * This matters more for #50 than for #49: #49 could never reach a `failed` row,
 * so the wall was written but never actually tested against a real
 * `outbox.last_error`. The drain is what produces one.
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

/** Contract § "Customer-safe error copy", the ms-3 additions, quoted. */
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
 * TODO(test-author): identical to the note in `ms-1/14-notifications.spec.ts`
 * and `ms-3/49-outbox-delivery-state.spec.ts` — ms-1's contract pins the two
 * header names but not how a Worker booted by `npm run serve:acceptance` learns
 * which pair is valid, and ms-3's contract does not reopen the question. Same
 * escape hatch, same defaults, so all three slices agree.
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
 * One inbox per test — the acceptance database is wiped per *run*, not per
 * *test*, so isolation comes from each test owning a distinct recipient.
 *
 * The `mailfail` local-part substring is contract § "The provider seam"'s
 * "Deterministic fake failure hook": "the fake succeeds for every recipient
 * **except** one whose local-part contains the substring `mailfail`
 * (case-insensitive) — e.g. `rota-mailfail@example.test` — for which it
 * deterministically fails every call." Addresses below are split into two
 * groups on purpose, and nothing in the DELIVERS group may ever contain it.
 */
const INBOX = {
  // must succeed at the fake
  moves: "rota-drain-moves@example.test",
  untouched: "rota-drain-untouched@example.test",
  queue: "rota-drain-queue@example.test",
  overlap: "rota-drain-overlap@example.test",
  // must fail at the fake, every call, forever
  retry: "rota-mailfail-retry@example.test",
  giveup: "rota-mailfail-giveup@example.test",
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

/** Collapse the incidental whitespace of rendered HTML before comparing copy. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ── the outbox, read as the contract's delivery DOM ─────────────────────────

interface Row {
  status: string | null
  pillStatus: string | null
  pillText: string | null
  detail: Record<DetailHook, string | null>
  /** ms-1's `email-subject`, so a transition can be shown not to eat the email. */
  subject: string | null
}

async function readRow(preview: Locator): Promise<Row> {
  const pill = preview.getByTestId("delivery-status")
  const pillCount = await pill.count()

  const detail = {} as Record<DetailHook, string | null>
  for (const hook of DETAIL_HOOKS) {
    const node = preview.getByTestId(hook)
    detail[hook] = (await node.count()) === 0 ? null : flat(await node.first().innerText())
  }

  const subject = preview.getByTestId("email-subject")

  return {
    status: await preview.getAttribute("data-status"),
    pillStatus: pillCount > 0 ? await pill.first().getAttribute("data-status") : null,
    pillText: pillCount > 0 ? flat(await pill.first().innerText()) : null,
    detail,
    subject: (await subject.count()) > 0 ? flat(await subject.first().innerText()) : null,
  }
}

/**
 * Every row on the caller's own `/outbox`, in DOM order. Filtered by `email-to`
 * so that a globally-scoped outbox and a caller-scoped one are both readable —
 * the same indifference ms-1's and #49's slices build in.
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
 * Wait until the caller's outbox holds exactly `expected` rows, then return
 * them. A send is DECIDED asynchronously (#14 is "digest-first, not instant"),
 * and that decision is #14's job, not the drain's — so this poll runs before any
 * drain is fired and its failure means the row was never queued at all.
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

// ── the drain ───────────────────────────────────────────────────────────────

/**
 * Fire the Cron Trigger once. Contract § "Triggering the drain": this is the
 * whole seam. A non-2xx here is not an assertion failure about #50's behaviour —
 * it means the trigger does not exist, so the message says exactly what to do.
 */
async function runDrain(request: APIRequestContext): Promise<void> {
  const res = await request.get(DRAIN)
  expect(res.ok(), `${DRAIN_UNAVAILABLE} (got HTTP ${res.status()})`).toBe(true)
}

/**
 * Fire the drain repeatedly, with the short pauses contract § "Retry/backoff
 * budget" bounds ("brief, e.g. ≤2s, pauses between calls"), until every row on
 * `to`'s outbox satisfies `done`, or the contract's 60-second budget expires.
 *
 * The budget is the contract's, not this slice's invention: "Backoff between
 * attempts must stay short enough that a sealed test polling `/__scheduled`…
 * observes a `mailfail`-addressed row reach `failed` well inside a **60-second**
 * total budget."
 */
async function drainUntil(
  page: Page,
  request: APIRequestContext,
  to: string,
  done: (rows: Row[]) => boolean,
  what: string,
  budgetMs = 60_000,
): Promise<Row[]> {
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

  const seen = rows
    .map((row, i) => `row ${i + 1}: ${row.status ?? "<no data-status>"}`)
    .join("; ")
  throw new Error(
    `${what} — not reached within the contract's 60s budget after ${ticks} \`GET ${DRAIN}\` ` +
      `calls at ~1s intervals (contract § "Retry/backoff budget"). Last seen for ${to}: ` +
      `${seen || "<no outbox rows>"}. If the states above look permanently \`queued\`, the ` +
      "drain is not claiming rows; if a non-`mailfail` recipient reached `failed`, the " +
      "acceptance environment is probably running the REAL provider path with no " +
      "`RESEND_API_KEY` instead of #51's fake — contract § \"The provider seam\" pins " +
      "`env.MAIL_PROVIDER=\"fake\"` for `serve:acceptance`.",
  )
}

/** Contract § hooks — the presence rules, as a per-status invariant. */
function assertPresenceRules(row: Row, where: string) {
  const status = row.status as DeliveryStatus
  expect(
    Object.keys(STATUS_TEXT),
    `${where}: contract § vocabulary is a fixed set of three slugs`,
  ).toContain(status)
  expect(row.pillStatus, `${where}: the pill's slug must agree with the row's`).toBe(status)
  expect(
    row.pillText,
    `${where}: contract § vocabulary pins \`${status}\` ⇒ pill text exactly "${STATUS_TEXT[status]}"`,
  ).toBe(STATUS_TEXT[status])

  for (const hook of DETAIL_HOOKS) {
    if (PRESENT_FOR[status].includes(hook)) {
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
        `${where}: contract § hooks — \`${hook}\` must be absent on a \`${status}\` row`,
      ).toBeNull()
    }
  }
}

// ── the slice ───────────────────────────────────────────────────────────────

test.describe("ms-3 issue 50 the drain", () => {
  test("the scheduled drain can be triggered at all", async ({ request }) => {
    // Contract Notes item 6 flags this as a Gate-A-level blocker rather than a
    // Fix-round detail: "every one of #50's acceptance assertions depends on it
    // existing". So it is asserted once, on its own, first — a worker who sees
    // only this test fail knows the wiring is missing, not the behaviour.
    const res = await request.get(DRAIN)
    expect(res.ok(), `${DRAIN_UNAVAILABLE} (got HTTP ${res.status()})`).toBe(true)

    // Firing the trigger against an empty (or already-drained) queue must be a
    // no-op, not an error: a Cron Trigger runs on a schedule whether or not
    // there is anything to do, and #50's whole point is that a failure in the
    // sending path "cannot reach the customer's request".
    const again = await request.get(DRAIN)
    expect(
      again.ok(),
      "a drain run with nothing to claim must still succeed — the cron fires on a schedule, " +
        "not on demand, and most of its runs have an empty queue",
    ).toBe(true)
  })

  test("a queued row stays queued until the drain runs", async ({ page, request }) => {
    // Issue #50, its own heading "Why a cron and not the request path": #14
    // "shipped three separate defects that all trace back to doing notification
    // work inside the request path… The outbox exists precisely so sending
    // happens somewhere a failure cannot reach the customer's request. Do not
    // call the provider from a request handler."
    //
    // Black-box, that is exactly this: the write that DECIDES a send (a bridge
    // push) must leave the row `queued`, and repeated reads of `/outbox` — which
    // are themselves request-path traffic — must not move it either.
    test.setTimeout(120_000)
    await asCustomer(page, INBOX.untouched)
    const reference = await seedSubmission(page, 0)

    expect(
      (await pushFields(request, reference, 5000, signoffFields())).outcome,
      "a design round is entirely coord-owned",
    ).toBe("applied")

    const [queued] = await awaitOutbox(page, INBOX.untouched, 1)
    expect(
      queued.status,
      "the push decided a send; per #49 the row is born `queued` and #50 has not run",
    ).toBe("queued")

    // Five more reads of the customer-facing screen over ~5s. If any of them
    // (or the push above) called the provider inline, the row moves without the
    // cron ever having been fired — the defect class #50 exists to prevent.
    for (let i = 0; i < 5; i++) {
      await sleep(1_000)
      const [row] = await readOutbox(page, INBOX.untouched)
      expect(
        row.status,
        `read ${i + 1}: no \`GET ${DRAIN}\` has been fired for this row, so nothing may have ` +
          "sent it — sending belongs to the cron, never to a request handler",
      ).toBe("queued")
      assertPresenceRules(row, `read ${i + 1}`)
    }

    // TODO(test-author): this is necessarily a bounded negative — five seconds
    // of nothing happening. Neither #50 nor the contract pins how promptly the
    // real Cron Trigger fires in production, and `wrangler dev` does not run
    // cron schedules by itself (which is the entire reason `/__scheduled`
    // exists), so a longer wait would buy confidence about the harness, not
    // about the code.
  })

  test("the drain claims a queued row and records it sent", async ({ page, request }) => {
    // Issue #50 Scope: the loop "claims `queued` rows, calls the provider (via
    // the `MailProvider` interface from #C, using its fake in test), records the
    // outcome — `sent` + `provider_message_id`". Contract § vocabulary:
    // `queued → sent` is one of the only two transitions that exist.
    //
    // `mocks/02-outbox-sent.html` is the screen this produces: the pill reads
    // "Sent" and `delivery-sent-at` appears — the hook #49's own slice could
    // write presence rules for but could never actually reach, because nothing
    // in #49 moves a row.
    test.setTimeout(120_000)
    await asCustomer(page, INBOX.moves)
    const reference = await seedSubmission(page, 1)

    expect(
      (await pushFields(request, reference, 5010, { question: QUESTION, status: "needs-input" }))
        .outcome,
      "coord owns both `question` and `status`",
    ).toBe("applied")

    const [before] = await awaitOutbox(page, INBOX.moves, 1)
    expect(before.status, "positive control: the row starts `queued`").toBe("queued")
    const subject = before.subject

    const rows = await drainUntil(
      page,
      request,
      INBOX.moves,
      (current) => current.length === 1 && current[0].status === "sent",
      "a queued row addressed to a recipient the fake accepts must reach `sent`",
    )

    const [sent] = rows
    expect(sent.status, "contract § vocabulary: the provider accepted it, so the row is `sent`").toBe(
      "sent",
    )
    assertPresenceRules(sent, "the drained row")
    expect(
      sent.detail["delivery-sent-at"],
      'contract § hooks: `delivery-sent-at` is present iff `data-status="sent"`, and non-empty',
    ).not.toBeNull()

    // The transition records an outcome; it does not eat the email. #14's DOM
    // survives its own delivery.
    expect(
      sent.subject,
      "the drain records delivery state on the existing row — it does not replace the email",
    ).toBe(subject)

    // Terminal. Contract § vocabulary: "there is no path back out of either
    // terminal state", and a re-claimed `sent` row is a double-send by another
    // name.
    await runDrain(request)
    await sleep(1_000)
    const after = await readOutbox(page, INBOX.moves)
    expect(after.length, "draining again invents no second row").toBe(1)
    expect(
      after[0].status,
      "contract § vocabulary: `sent` is terminal — a later drain run must not re-claim it",
    ).toBe("sent")

    // TODO(test-author): `provider_message_id` is NOT asserted. #50's Scope
    // requires it to be recorded, but contract § hooks is explicit that
    // `delivery-provider-id` is "**not part of this contract**… no test in this
    // milestone should require it" on the customer page, and nothing black-box
    // can read a D1 column the portal does not render. A real gap, deliberately
    // left — closing it needs a contract amendment (see contract Notes item 8,
    // which argues #55's `/deliveries` is where it should surface).
  })

  test("the drain empties the whole queue, not just one row", async ({ page, request }) => {
    // #50's Scope says "claims `queued` rows", plural. A drain that claims one
    // row per run and is then never fired again leaves a customer's other
    // notifications stuck forever — the "stuck notification" #49's own
    // motivating text names. This does not pin a batch size (nothing in #50 or
    // the contract does): it fires the trigger repeatedly within the contract's
    // 60s budget and insists the queue empties.
    test.setTimeout(120_000)
    await asCustomer(page, INBOX.queue)
    const reference = await seedSubmission(page, 2)

    let revision = 5020
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
      await awaitOutbox(page, INBOX.queue, index + 1)
    }

    const queued = await readOutbox(page, INBOX.queue)
    expect(queued.length, "three sending states decided three sends").toBe(3)
    for (const row of queued) {
      expect(row.status, "positive control: all three start `queued`").toBe("queued")
    }

    const rows = await drainUntil(
      page,
      request,
      INBOX.queue,
      (current) => current.length === 3 && current.every((row) => row.status === "sent"),
      "every queued row for one recipient must reach `sent`, not just the first",
    )

    expect(rows.length, "the drain neither duplicates nor drops rows").toBe(3)
    for (const [index, row] of rows.entries()) {
      expect(row.status, `row ${index + 1} of 3 must have been claimed and sent`).toBe("sent")
      assertPresenceRules(row, `row ${index + 1} of 3`)
    }
  })

  test("one provider failure is a retry, not a give-up", async ({ page, request }) => {
    // #50 Scope: "records the outcome — `sent` + `provider_message_id`, or an
    // incremented `attempts` and `last_error`, retries with backoff and gives up
    // after N attempts". Contract § "The provider seam", on the fail-closed
    // path, reads that as: a failure "does not skip straight to `failed` on the
    // first attempt, it just can never succeed, so it reaches `failed` on
    // schedule like any other permanently-failing row."
    //
    // And the mid-retry row is the case #49's slice explicitly could not reach
    // (its own TODO says so): contract § vocabulary pins that `attempts > 0`
    // with `status` still `queued` "renders **identically** to
    // `01-outbox-queued.html`" — no attempt count, no error copy, nothing that
    // reads as alarming flicker to a customer.
    test.setTimeout(120_000)
    await asCustomer(page, INBOX.retry)
    const reference = await seedSubmission(page, 0)

    expect(
      (await pushFields(request, reference, 5030, signoffFields())).outcome,
      "a design round is entirely coord-owned",
    ).toBe("applied")

    const [before] = await awaitOutbox(page, INBOX.retry, 1)
    expect(before.status, "positive control: the row starts `queued`").toBe("queued")

    await runDrain(request)
    await sleep(1_000)

    const [row] = await readOutbox(page, INBOX.retry)
    expect(
      row.status,
      "the `mailfail` recipient fails deterministically at #51's fake, but ONE failure is a " +
        "retry: the row must still be `queued`, not `failed` (contract § \"The provider seam\": " +
        "a failure \"does not skip straight to `failed` on the first attempt\") and certainly " +
        "not `sent`",
    ).toBe("queued")
    assertPresenceRules(row, "the mid-retry row")

    // Said again, directly against the mocks: a retrying row is visually a
    // queued row. This is the assertion #49's slice wrote the rules for and
    // could not exercise.
    for (const hook of DETAIL_HOOKS) {
      expect(
        row.detail[hook],
        `contract § vocabulary: a \`queued\` row renders identically regardless of \`attempts\`, ` +
          `so \`${hook}\` must not appear mid-retry`,
      ).toBeNull()
    }

    // TODO(test-author): this reads "one `GET /__scheduled` call" as "at most
    // one delivery attempt". Neither #50 nor the contract states that a single
    // scheduled invocation performs at most one attempt per row — the contract
    // only implies it, by describing a sealed test that POLLS `/__scheduled`
    // with pauses to watch a row reach `failed` (§ "Retry/backoff budget"), and
    // by requiring "backoff" between attempts at all, which an in-handler loop
    // would not provide. If an implementer burns every attempt inside one cron
    // tick, this test fails while arguably meeting #50's letter — that is a
    // contract amendment to settle, not something to work around here.
  })

  test("a permanently failing send gives up visibly, and stays given up", async ({
    page,
    request,
  }) => {
    // The "gives up visibly" half of #50's own title, and `mocks/03-outbox-
    // failed.html`'s screen: a terminal `failed` pill reading "Delivery failed",
    // an attempt count, and customer-safe copy — not a row that silently retries
    // forever, and not one that quietly disappears.
    test.setTimeout(180_000)
    await asCustomer(page, INBOX.giveup)
    const reference = await seedSubmission(page, 1)

    expect(
      (await pushFields(request, reference, 5040, { question: QUESTION, status: "needs-input" }))
        .outcome,
      "coord owns both `question` and `status`",
    ).toBe("applied")

    const [before] = await awaitOutbox(page, INBOX.giveup, 1)
    expect(before.status, "positive control: the row starts `queued`").toBe("queued")

    const rows = await drainUntil(
      page,
      request,
      INBOX.giveup,
      (current) => current.length === 1 && current[0].status === "failed",
      "a row the provider always rejects must stop retrying and become visibly `failed`",
    )

    const [failed] = rows
    expect(failed.status, "contract § vocabulary: every retry exhausted ⇒ `failed`").toBe("failed")
    expect(
      failed.status,
      "a permanently rejected send must never be recorded as delivered",
    ).not.toBe("sent")
    assertPresenceRules(failed, "the failed row")

    const attempts = failed.detail["delivery-attempts"] as string
    expect(
      attempts,
      'contract § hooks: `delivery-attempts` "Must contain at least one base-10 integer"',
    ).toMatch(/\d+/)
    expect(
      Number(/\d+/.exec(attempts)?.[0]),
      "#50 gives up AFTER N attempts, so the count it shows is a real one",
    ).toBeGreaterThan(0)

    // The wall between the operator's error string and the customer's screen.
    // #49's slice wrote this check but could never reach a row that had a real
    // `outbox.last_error` in it; the drain is what puts one there.
    const copy = failed.detail["delivery-last-error"] as string
    for (const [pattern, why] of [...FORBIDDEN, ...INFRA_FORBIDDEN]) {
      expect(
        copy,
        "contract § \"Customer-safe error copy\": `delivery-last-error` renders customer copy, " +
          `not \`outbox.last_error\` verbatim — ${why}`,
      ).not.toMatch(pattern)
    }

    // Terminal, and quiet about it: two more drain runs must neither resurrect
    // the row nor keep incrementing its attempt count. "There is no path back
    // out of either terminal state" (contract § vocabulary), and #50 gives up
    // "after N attempts" — a drain that keeps trying has not given up.
    await runDrain(request)
    await sleep(1_000)
    await runDrain(request)
    await sleep(1_000)

    const after = await readOutbox(page, INBOX.giveup)
    expect(after.length, "later drain runs invent no second row").toBe(1)
    expect(
      after[0].status,
      "contract § vocabulary: `failed` is terminal — no path back out, and no manual retry " +
        "surface anywhere in this milestone",
    ).toBe("failed")
    expect(
      after[0].detail["delivery-attempts"],
      "the attempt count must be frozen at give-up — a row that keeps accumulating attempts " +
        "after it reports `Delivery failed` has not actually given up",
    ).toBe(attempts)

    // TODO(test-author): the exact N is NOT asserted. Contract § "Retry/backoff
    // budget" pins 5 as its own default while saying in the same breath that an
    // implementer may pick a different N and "should say so in the PR" — so this
    // asserts what the contract actually commits to (an integer, > 0, reached
    // inside the 60s budget, then frozen), not the number.
  })

  test("two overlapping drain runs leave exactly one send behind", async ({ page, request }) => {
    // #50's own "The thing to get right": "Claiming must be safe against two
    // overlapping invocations. A read-then-write will double-send when a
    // scheduled run overlaps a retry… A double-send is a customer-visible
    // defect, not a cosmetic one."
    //
    // Contract § "Claiming safety" pins the black-box form: fire two
    // `GET /__scheduled` requests concurrently and assert the row "reaches
    // exactly the outcome consistent with **one** send — e.g. `status="sent"`
    // with `delivery-attempts` absent (a first-try success renders no attempts
    // block per the vocabulary above) rather than any doubled side effect."
    test.setTimeout(120_000)
    await asCustomer(page, INBOX.overlap)
    const reference = await seedSubmission(page, 2)

    expect(
      (await pushFields(request, reference, 5050, { status: "shipped" })).outcome,
      "`status` is coord-owned",
    ).toBe("applied")

    const [before] = await awaitOutbox(page, INBOX.overlap, 1)
    expect(before.status, "positive control: the row is `queued` and unclaimed").toBe("queued")

    // The overlap itself: two invocations in flight at once, neither awaited
    // before the other starts.
    const [first, second] = await Promise.all([request.get(DRAIN), request.get(DRAIN)])
    expect(
      first.ok() && second.ok(),
      `${DRAIN_UNAVAILABLE} (overlapping runs answered HTTP ${first.status()} and ${second.status()}) — ` +
        "note that a run which finds nothing to claim because the other run claimed it first " +
        "must still SUCCEED, not error: losing the race is the normal case, not a fault",
    ).toBe(true)

    const rows = await drainUntil(
      page,
      request,
      INBOX.overlap,
      (current) => current.length === 1 && current[0].status !== "queued",
      "the row two overlapping drains raced over must settle into a terminal state",
    )

    expect(
      rows.length,
      "a doubled claim must not leave a doubled row on the customer's screen",
    ).toBe(1)
    const [row] = rows
    expect(
      row.status,
      "the recipient contains no `mailfail` substring, so #51's fake accepts it: two overlapping " +
        "claims of one queued row must settle as exactly one successful send",
    ).toBe("sent")
    assertPresenceRules(row, "the raced row")
    expect(
      row.detail["delivery-attempts"],
      "contract § \"Claiming safety\": a first-try success renders no attempts block — an " +
        "attempt count surfacing here is evidence the row was claimed twice",
    ).toBeNull()
    expect(
      row.detail["delivery-last-error"],
      "a row that both runs sent successfully has no error to report",
    ).toBeNull()

    // And the screen as a whole: one pill for this recipient's one send.
    const pills = page.getByTestId("delivery-status")
    expect(
      await pills.count(),
      "one delivery pill per row — an overlapping claim must not duplicate the row either",
    ).toBe(1)

    // TODO(test-author): this is the strongest assertion available, and it is
    // still indirect. A true double-send (two provider calls, one row, one
    // `sent` state) is invisible from outside — contract § "The provider seam"
    // says the sealed suite "never imports or calls `MailProvider` directly" and
    // #53's own framing is that "nothing in this repo can observe a real inbox".
    // The contract acknowledges this and asks only for "no evidence of a
    // double-send"; a counter on #51's fake, exposed on a dev-only route, is
    // what would close the gap, and no issue asks for one. Flagged, not
    // invented.
  })
})
