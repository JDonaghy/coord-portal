import { expect, test, type APIRequestContext, type Page } from "@playwright/test"

/**
 * ms-1 sealed acceptance slice — issue #74
 * "[portal] On hold never reaches a customer — collapse it into In progress"
 *
 * Written from `tests/acceptance/ms-1/contract.md` (as amended 2026-08-14) and
 * issue #74, without sight of any implementation.
 *
 * WHAT THE CONTRACT NOW PINS. Note 1 was an open question at the first Gate-A
 * ("does On hold surface to customers at all?"); the amendment closed it and
 * made the answer binding:
 *
 *   - § "Customer status vocabulary": the `on-hold` row's visible text is
 *     *(none — collapses to `in-progress`)*.
 *   - § "The one deliberate exception": a stored `status: "on-hold"` "does not
 *     render its own word at all. It renders with `data-status="in-progress"`
 *     and pill text **In progress** — the exact `04-submission-in-design.html`
 *     rollup template already pinned for the `in-progress` slug, byte-for-byte,
 *     not a lookalike."
 *   - § "`data-testid` hooks / On-hold": "There is no `onhold-*` hook anywhere
 *     in this contract and no dedicated on-hold screen to hook into."
 *   - Note 1: "`on-hold` itself is untouched as a stored status and a valid
 *     bridge-push target — only its customer-visible rendering collapsed."
 *   - § "`POST /api/bridge/push`": a push setting `on-hold` "resolves `applied`
 *     / `already_applied` exactly like any other status value — never
 *     `rejected` for being `on-hold`, and never a transport failure".
 *   - `mocks/09-submission-onhold.html` is deleted; `mocks/03-dashboard.html`
 *     now renders its stored-`on-hold` row as `data-status="in-progress"` with
 *     pill text `In progress`.
 *
 * SCOPE OF THIS SLICE — exactly issue #74's four scope points, no more:
 *  1. a stored `on-hold` renders as In progress, through the pinned rollup
 *     template, with the In-progress timeline step current;
 *  2. `on-hold` stays a valid stored status and a valid bridge push (a CONTROL:
 *     it must be green before this change and stay green after it);
 *  3. the On-hold detail branch and its `onhold-*` hooks are gone — no such
 *     hook resolves anywhere in the app;
 *  4. exactly one status is mapped — no other status's slug, wording, template
 *     or timeline changes (a RATCHET on the other eight words).
 *
 * NOT COVERED HERE, deliberately:
 *  - **Whether the stored `status` really still reads `on-hold` in D1.** The
 *    portal exposes no customer-visible or bridge-visible read of a stored
 *    `status` (`GET /api/bridge/pull` carries customer-authored events only, per
 *    the contract's pinned `type` set), so "the stored value is unaffected" is
 *    not black-box observable from this repo. The closest observable proxy —
 *    that the write was accepted and is idempotent by `(submission_id,
 *    revision)` — IS asserted. See the TODO in the bridge test.
 *  - **`.status-pill[data-status="on-hold"]` in `src/render.ts`** (scope point
 *    4 of the issue). That is a source-level question about operator surfaces,
 *    which a black-box acceptance suite cannot see and must not assert on. The
 *    customer-visible consequence — nothing renders a pill carrying that slug —
 *    IS asserted.
 *  - **The business-time On-hold threshold.** Contract note 2 keeps it
 *    unresolved as a computation and pins no customer-visible display of it at
 *    all: "`onhold-since` is no longer a pinned hook … nothing today reads it."
 *  - **Every other status's own slice.** Issue #10's sealed slice owns the
 *    vocabulary as a whole and was deliberately written to hold under either
 *    resolution of this question; it is the regression net for this change and
 *    is not touched. The ratchet below overlaps it only where issue #74's own
 *    scope point 1 demands it ("no other status's rendering or wording changes
 *    at all").
 *
 * MECHANISM. `status` is coord-owned, so the only black-box way to put a
 * submission into a stored state is a bridge push (contract § "Sync bridge");
 * the only way to author a submission is the pinned intake form. Both are other
 * issues' surfaces, used here as instruments, not as subjects.
 *
 * SYNTHETIC DATA. Per CLAUDE.md rule 1 and the contract's "Synthetic data"
 * section, every string below is invented.
 */

// ── the pinned vocabulary ───────────────────────────────────────────────────

/**
 * Contract § "Customer status vocabulary", verbatim and in its pinned order.
 * `on-hold` is present as a stored slug but carries NO visible text of its own
 * — it is rendered through `in-progress`. That mapping is the whole subject of
 * this slice, so it is spelled out here rather than folded into the table.
 */
const VOCABULARY: Array<{ slug: string; text: string }> = [
  { slug: "describing", text: "Describing" },
  { slug: "in-design", text: "In design" },
  { slug: "awaiting-signoff", text: "Awaiting your sign-off" },
  { slug: "planned", text: "Planned" },
  { slug: "in-progress", text: "In progress" },
  { slug: "quality-check", text: "Quality check" },
  { slug: "needs-input", text: "Needs your input" },
  { slug: "shipped", text: "Shipped" },
]

/** The stored status that has no customer-visible word of its own. */
const COLLAPSED_FROM = "on-hold"
/** …and the one it is drawn as. Contract § "The one deliberate exception". */
const COLLAPSED_TO = "in-progress"
const COLLAPSED_TEXT = "In progress"

/** Every slug the customer may ever see on a `data-status`. */
const RENDERABLE_SLUGS = VOCABULARY.map((v) => v.slug)

/** The three hooks note 1 removed along with `09-submission-onhold.html`. */
const REMOVED_HOOKS = ["onhold-copy", "onhold-since", "onhold-provisional-note"]

/** Every affordance the contract pins as a *demand* on the customer. */
const DEMAND_TESTIDS = [
  "approve-button",
  "request-changes-button",
  "request-changes-form",
  "submit-changes",
  "changes-comment",
  "pause-banner",
  "question-thread",
  "answer-field",
  "submit-answer",
]

/**
 * The word itself, in every spelling a renderer might produce. Contract note 1:
 * "There is no customer-visible On hold."
 */
const ON_HOLD_WORDING = [
  /\bon[\s _-]?hold\b/i,
  /\bonhold\b/i,
  /\bpaused by the (team|fleet)\b/i,
]

const REFERENCE = /^SUB-[A-Z0-9]{6}$/

// ── bridge transport (the instrument, not the subject) ──────────────────────

/**
 * TODO(test-author): identical to the note in `15-sync-bridge.spec.ts` and
 * `10-up-mapping.spec.ts` — the contract pins the two header names and pins
 * missing/invalid ⇒ 401, but not how a Worker running without Access in front
 * of it (which is what `npm run serve:acceptance` boots) learns which pair is
 * valid. Same escape hatch, same invented defaults: these are not a credential.
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

/**
 * Push one update and return its single result.
 *
 * Contract trap: ownership violations and stale revisions are per-item
 * `outcome` values inside a 200, never transport failures. A `status` push is
 * coord-owned, so the only outcomes in scope here are `applied` /
 * `already_applied`.
 */
async function pushStatus(
  request: APIRequestContext,
  submissionId: string,
  status: string,
  revision: number,
): Promise<PushResult> {
  const res = await request.post("/api/bridge/push", {
    data: { updates: [{ submission_id: submissionId, revision, fields: { status } }] },
    headers: SERVICE_TOKEN,
  })
  expect(
    res.status(),
    `pushing \`${status}\` with a valid service token is 200, not a transport failure`,
  ).toBe(200)
  const body = (await res.json()) as { results: PushResult[] }
  expect(body.results, "one result per update").toHaveLength(1)
  return body.results[0]
}

/** Push a status and require it to have landed. */
async function setStatus(
  request: APIRequestContext,
  submissionId: string,
  status: string,
  revision: number,
): Promise<void> {
  const result = await pushStatus(request, submissionId, status, revision)
  expect(
    result.outcome,
    `\`${status}\` is a pinned stored status and coord owns \`status\``,
  ).toBe("applied")
}

// ── seeding and reading, through the pinned customer surface ────────────────

/**
 * Synthetic intake seeds. Chosen so no seed's own copy contains any spelling of
 * the forbidden word — otherwise the whole-body scans below would fail against
 * a correct implementation, which reads as a wall breach and is not one.
 */
const SEEDS = [
  {
    outcome: "A printable sign-out sheet for the tool library.",
    audience: "our Thursday evening volunteers",
    doneDefinition: "A volunteer can see which tools are out without asking.",
  },
  {
    outcome: "A weekly tally of how many bikes were repaired.",
    audience: "the workshop lead",
    doneDefinition: "The lead sees one number each Monday morning.",
  },
  {
    outcome: "A one-page map of which storage bays are free.",
    audience: "new members of the makerspace",
    doneDefinition: "A new member can claim a free bay unaided.",
  },
  {
    outcome: "A note when the fabric delivery date moves.",
    audience: "our textiles group",
    doneDefinition: "The group hears about a date change the same day.",
  },
  {
    outcome: "A printable roster for the Saturday welcome desk.",
    audience: "the front desk planner",
    doneDefinition: "Next month's roster prints without editing a spreadsheet.",
  },
  {
    outcome: "A summary of which evening classes filled up.",
    audience: "our classes coordinator",
    doneDefinition: "The coordinator sees last term's fill rates at a glance.",
  },
  {
    outcome: "A reminder when a materials order is unacknowledged.",
    audience: "our purchasing volunteer",
    doneDefinition: "An unacknowledged order is flagged after five days.",
  },
  {
    outcome: "A shared list of which sewing machines need a service.",
    audience: "the maintenance rota",
    doneDefinition: "A machine due a service is visible before it is booked.",
  },
  {
    outcome: "A monthly count of visitors to the seed library.",
    audience: "our trustees",
    doneDefinition: "The trustees see one number per month, no spreadsheet.",
  },
]

/** The verified-identity mechanism the contract's screens assume is present. */
function asCustomer(page: Page, email: string) {
  return page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": email })
}

interface Seeded {
  url: string
  reference: string
}

/** Author one submission through the pinned intake form (#9's surface). */
async function seedSubmission(page: Page, n: number): Promise<Seeded> {
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
  return { url: page.url(), reference }
}

interface RenderedStatus {
  root: string | null
  pill: string | null
  pillText: string
}

/** Read the status the customer is actually shown on a detail screen. */
async function readDetailStatus(page: Page, url: string): Promise<RenderedStatus> {
  await page.goto(url)
  const detail = page.getByTestId("submission-detail")
  await expect(detail, `${url} renders a submission detail`).toBeVisible()
  const pill = page.getByTestId("status-pill")
  await expect(pill, "a detail screen carries exactly one status pill").toHaveCount(1)
  return {
    root: await detail.getAttribute("data-status"),
    pill: await pill.getAttribute("data-status"),
    pillText: (await pill.innerText()).trim(),
  }
}

/** Seed a submission, put it in a stored status, and return it. */
async function seedInStatus(
  page: Page,
  request: APIRequestContext,
  n: number,
  status: string,
  revision: number,
): Promise<Seeded> {
  const seeded = await seedSubmission(page, n)
  await setStatus(request, seeded.reference, status, revision)
  return seeded
}

/** Every `data-testid` present on the current page, sorted and de-duplicated. */
async function testidSkeleton(page: Page): Promise<string[]> {
  const ids = await page.locator("[data-testid]").evaluateAll((nodes) =>
    nodes.map((n) => n.getAttribute("data-testid") ?? ""),
  )
  return [...new Set(ids)].sort()
}

// ── the slice ───────────────────────────────────────────────────────────────

test.describe("ms-1 issue 74 on-hold collapses into In progress", () => {
  test("a submission stored as on-hold renders as In progress", async ({
    page,
    request,
  }) => {
    await asCustomer(page, "collapse-detail@example.test")

    // Contract § "The one deliberate exception": a stored `status: "on-hold"`
    // "does not render its own word at all. It renders with
    // `data-status="in-progress"` and pill text **In progress**".
    const seeded = await seedInStatus(page, request, 0, COLLAPSED_FROM, 1000)

    const shown = await readDetailStatus(page, seeded.url)
    expect(shown.pill, "a stored on-hold pill carries the in-progress slug").toBe(
      COLLAPSED_TO,
    )
    expect(shown.root, "the detail root carries the in-progress slug too").toBe(
      COLLAPSED_TO,
    )
    expect(shown.pillText, "the pinned customer wording is In progress").toBe(
      COLLAPSED_TEXT,
    )

    // No element anywhere on the screen claims the collapsed-away slug — not a
    // pill, not the root, not a timeline step, not a hidden attribute.
    await expect(
      page.locator(`[data-status="${COLLAPSED_FROM}"]`),
      "nothing renders a data-status of the collapsed-away slug",
    ).toHaveCount(0)
    await expect(
      page.locator(`[data-step="${COLLAPSED_FROM}"]`),
      "the timeline has no step for the collapsed-away slug",
    ).toHaveCount(0)
  })

  test("a stored on-hold submission uses the rollup template with the In progress step current", async ({
    page,
    request,
  }) => {
    await asCustomer(page, "collapse-template@example.test")

    // Issue #74 scope 1: "The pinned rollup template
    // (`04-submission-in-design.html`), `data-status="in-progress"`, pill text
    // `In progress`, the In-progress timeline step."
    const seeded = await seedInStatus(page, request, 1, COLLAPSED_FROM, 1010)
    const shown = await readDetailStatus(page, seeded.url)
    expect(shown.pill).toBe(COLLAPSED_TO)

    // Contract, rollup hooks: `status-timeline`, repeated `timeline-step` each
    // with `data-step` (a slug), `data-current="true"` on exactly one, and
    // `rollup-copy`.
    await expect(
      page.getByTestId("status-timeline"),
      "a stored on-hold submission uses the rollup template",
    ).toBeVisible()

    const steps = page.getByTestId("timeline-step")
    const stepCount = await steps.count()
    expect(stepCount, "the rollup timeline has steps").toBeGreaterThan(0)

    const stepSlugs: string[] = []
    for (let s = 0; s < stepCount; s++) {
      stepSlugs.push((await steps.nth(s).getAttribute("data-step")) ?? "")
    }
    for (const step of stepSlugs) {
      expect(
        RENDERABLE_SLUGS,
        "every timeline step is a slug the customer may see",
      ).toContain(step)
    }

    await expect(
      page.locator('[data-testid="timeline-step"][data-current="true"]'),
      "exactly one step is current",
    ).toHaveCount(1)
    expect(
      stepSlugs,
      "the pinned rollup timeline carries an In-progress step to highlight",
    ).toContain(COLLAPSED_TO)
    await expect(
      page.locator(`[data-testid="timeline-step"][data-step="${COLLAPSED_TO}"]`),
      "the In-progress step is the highlighted one",
    ).toHaveAttribute("data-current", "true")

    const copy = page.getByTestId("rollup-copy")
    await expect(copy, "the rollup screen explains itself").toBeVisible()
    expect((await copy.innerText()).trim().length).toBeGreaterThan(0)

    // `in-progress` is not customer-actionable, so the collapsed screen may not
    // ask the customer for anything either.
    for (const testid of DEMAND_TESTIDS) {
      await expect(
        page.getByTestId(testid),
        `a rollup screen asks the customer for nothing — no \`${testid}\``,
      ).toHaveCount(0)
    }
  })

  test("a stored on-hold submission and a stored in-progress submission render the same screen", async ({
    page,
    request,
  }) => {
    await asCustomer(page, "collapse-identical@example.test")

    // Contract: "the exact `04-submission-in-design.html` rollup template
    // already pinned for the `in-progress` slug, byte-for-byte, not a
    // lookalike." Two submissions, identical seed copy, differing only in the
    // stored status — the customer must not be able to tell them apart.
    const held = await seedInStatus(page, request, 2, COLLAPSED_FROM, 1020)
    const running = await seedInStatus(page, request, 2, COLLAPSED_TO, 1021)

    // Read both screens through the same helper, so a screen that never renders
    // the rollup surface at all fails as a readable assertion rather than as a
    // 30-second `innerHTML` timeout on a locator that will never resolve.
    async function readRollup(url: string, where: string) {
      await page.goto(url)
      const timeline = page.getByTestId("status-timeline")
      await expect(timeline, `${where} renders the pinned rollup template`).toBeVisible()
      const pill = page.getByTestId("status-pill")
      await expect(pill, `${where} renders exactly one status pill`).toHaveCount(1)
      return {
        skeleton: await testidSkeleton(page),
        timeline: await timeline.innerHTML(),
        pill: await pill.innerHTML(),
      }
    }

    const heldRollup = await readRollup(held.url, "a stored on-hold submission")
    const runningRollup = await readRollup(
      running.url,
      "a stored in-progress submission",
    )

    // TODO(test-author): "byte-for-byte" is asserted over the status-bearing
    // elements and the hook skeleton, not over the whole document. The two
    // screens legitimately differ in their reference and their timestamps, so a
    // whole-body HTML diff would fail against a correct implementation. If the
    // contract ever pins the rollup copy's exact wording, this can tighten.
    expect(
      runningRollup.skeleton,
      "both stored statuses render the same set of pinned hooks",
    ).toEqual(heldRollup.skeleton)
    expect(
      runningRollup.timeline,
      "both stored statuses render the same timeline, with the same step current",
    ).toBe(heldRollup.timeline)
    expect(runningRollup.pill, "both stored statuses render the same pill").toBe(
      heldRollup.pill,
    )
  })

  test("the dashboard renders a stored on-hold submission as In progress", async ({
    page,
    request,
  }) => {
    // One identity of its own: the acceptance database is wiped per run, not per
    // test, so a row count is only stable for a customer nobody else seeds for.
    await asCustomer(page, "collapse-board@example.test")

    // `mocks/03-dashboard.html`, as amended: the stored-`on-hold` row renders
    // `data-status="in-progress"` with pill text `In progress`.
    const held = await seedInStatus(page, request, 3, COLLAPSED_FROM, 1030)

    await page.goto("/submissions")
    await expect(page.getByTestId("submission-list")).toBeVisible()

    const row = page.getByTestId("submission-row").filter({ hasText: held.reference })
    await expect(row, `${held.reference} has exactly one row`).toHaveCount(1)
    expect(
      await row.getAttribute("data-status"),
      "the dashboard row carries the in-progress slug",
    ).toBe(COLLAPSED_TO)

    const pill = row.getByTestId("status-pill")
    await expect(pill, "one pill per row").toHaveCount(1)
    expect(await pill.getAttribute("data-status")).toBe(COLLAPSED_TO)
    expect((await pill.innerText()).trim(), "pinned wording on the dashboard too").toBe(
      COLLAPSED_TEXT,
    )

    await expect(
      page.locator(`[data-status="${COLLAPSED_FROM}"]`),
      "no dashboard row or pill claims the collapsed-away slug",
    ).toHaveCount(0)
  })

  test("the words On hold never reach the customer", async ({ page, request }) => {
    const CUSTOMER = "collapse-wording@example.test"
    await asCustomer(page, CUSTOMER)

    // Self-check on the fixture, not on the app: issue #12 pins that every
    // authenticated screen names the signed-in customer, so this address is part
    // of every body scanned below. A collision would fail the scan while the
    // implementation is behaving correctly. Fail loudly and specifically first.
    for (const pattern of ON_HOLD_WORDING) {
      expect(
        CUSTOMER,
        "fixture defect, not an app defect: the signed-in address itself matches " +
          `${pattern}, which the whole-body scan below cannot distinguish from a ` +
          "real leak. Choose another address.",
      ).not.toMatch(pattern)
    }

    const held = await seedInStatus(page, request, 4, COLLAPSED_FROM, 1040)

    for (const [where, url] of [
      ["the detail screen", held.url],
      ["the dashboard", "/submissions"],
    ] as const) {
      await page.goto(url)

      // Positive control FIRST: "the copy leaks nothing" proves nothing about a
      // screen that failed to render. The submission must really be on it.
      const body = await page.locator("body").innerText()
      expect(body, `${where} really rendered this submission`).toContain(held.reference)
      expect(body, `${where} shows the collapsed wording`).toContain(COLLAPSED_TEXT)

      for (const pattern of ON_HOLD_WORDING) {
        expect(
          body,
          `${where}: contract note 1 — "There is no customer-visible On hold"`,
        ).not.toMatch(pattern)
      }

      // …and no status pill anywhere reads anything but the collapsed word.
      const pills = page.getByTestId("status-pill")
      const pillCount = await pills.count()
      expect(pillCount, `${where} renders at least one status pill`).toBeGreaterThan(0)
      for (let i = 0; i < pillCount; i++) {
        const slug = await pills.nth(i).getAttribute("data-status")
        const text = (await pills.nth(i).innerText()).trim()
        expect(
          RENDERABLE_SLUGS,
          `${where}: every rendered slug is one the customer may see`,
        ).toContain(slug)
        expect(text, `${where}: the pill wording matches its slug`).toBe(
          VOCABULARY.find((v) => v.slug === slug)?.text,
        )
      }
    }
  })

  test("no onhold-* hook resolves anywhere in the app", async ({ page, request }) => {
    await asCustomer(page, "collapse-hooks@example.test")

    // Issue #74 scope 3: "Delete the On-hold detail branch and its hooks rather
    // than leaving them unreachable: `onHoldDetail`, `onhold-copy`,
    // `onhold-since`, `onhold-provisional-note`." Contract § "`data-testid`
    // hooks / On-hold": "There is no `onhold-*` hook anywhere in this contract
    // and no dedicated on-hold screen to hook into."
    const held = await seedInStatus(page, request, 5, COLLAPSED_FROM, 1050)
    const running = await seedInStatus(page, request, 6, COLLAPSED_TO, 1051)

    const screens: Array<[string, string]> = [
      ["the stored-on-hold detail", held.url],
      ["a stored-in-progress detail", running.url],
      ["the dashboard", "/submissions"],
      ["the intake form", "/intake"],
    ]

    for (const [where, url] of screens) {
      await page.goto(url)
      await expect(page.locator("body"), `${where} rendered`).toBeVisible()

      for (const hook of REMOVED_HOOKS) {
        await expect(
          page.getByTestId(hook),
          `${where}: \`${hook}\` was removed by contract note 1`,
        ).toHaveCount(0)
      }
      // Not just the three named hooks — the whole prefix is gone, so a renamed
      // survivor (`onhold-banner`, `onhold-note`, …) is caught too.
      await expect(
        page.locator('[data-testid^="onhold"]'),
        `${where}: no \`onhold-*\` hook survives anywhere`,
      ).toHaveCount(0)
    }
  })

  test("on-hold stays a valid bridge push — applied, then already_applied", async ({
    page,
    request,
  }) => {
    await asCustomer(page, "collapse-bridge@example.test")

    // CONTROL. Issue #74 scope 2 and contract § "`POST /api/bridge/push`":
    // "`status: "on-hold"` is an ordinary member of the pinned vocabulary and a
    // push setting it resolves `applied` / `already_applied` exactly like any
    // other status value — never `rejected` for being `on-hold`, and never a
    // transport failure (no 4xx/5xx)." This clause must be GREEN before this
    // change and stay green after it: it is what stops the collapse being
    // implemented by refusing the write instead of by mapping the render.
    const seeded = await seedSubmission(page, 7)

    const first = await pushStatus(request, seeded.reference, COLLAPSED_FROM, 1060)
    expect(first.outcome, "the first push of `on-hold` is applied").toBe("applied")

    // "Idempotent by `(submission_id, revision)`: a revision less than or equal
    // to the stored one is `already_applied` — not an error. Assume every
    // request arrives twice."
    const replay = await pushStatus(request, seeded.reference, COLLAPSED_FROM, 1060)
    expect(replay.outcome, "the same push replayed is already_applied").toBe(
      "already_applied",
    )
    expect(
      replay.reason,
      "a replayed push is not a rejection, so it carries no reason",
    ).toBeUndefined()

    // A later revision setting the same value is a fresh, ordinary write.
    const later = await pushStatus(request, seeded.reference, COLLAPSED_FROM, 1061)
    expect(
      ["applied", "already_applied"],
      "`on-hold` is never rejected for being `on-hold`",
    ).toContain(later.outcome)

    // TODO(test-author): that the STORED value really still reads `on-hold` is
    // not black-box observable — `GET /api/bridge/pull` carries only the four
    // customer-authored event types the contract pins, none of which report a
    // coord-owned `status`. The accepted-and-idempotent outcomes above are the
    // closest proxy this suite can reach. If the bridge ever exposes a
    // stored-state read, this test should assert the value directly.
  })

  test("no other status's rendering or wording changes", async ({ page, request }) => {
    await asCustomer(page, "collapse-ratchet@example.test")

    // RATCHET. Issue #74 scope 1: "Exactly one status is mapped; no other
    // status's rendering or wording changes at all." Green today, and the point
    // is that it stays green — a collapse implemented as a broad rewrite of the
    // status map would break here rather than quietly ship.
    let revision = 1100
    for (const [i, entry] of VOCABULARY.entries()) {
      const seeded = await seedInStatus(page, request, i, entry.slug, revision++)

      const shown = await readDetailStatus(page, seeded.url)
      expect(shown.pill, `\`${entry.slug}\`: the pill still carries its own slug`).toBe(
        entry.slug,
      )
      expect(shown.root, `\`${entry.slug}\`: the detail root agrees`).toBe(entry.slug)
      expect(shown.pillText, `\`${entry.slug}\`: pinned wording is unchanged`).toBe(
        entry.text,
      )
    }
  })

  test("the collapse applies to on-hold only and is not sticky", async ({
    page,
    request,
  }) => {
    await asCustomer(page, "collapse-transitions@example.test")

    // The map is applied "at the render boundary only" (contract § "The one
    // deliberate exception"), so it must not leave residue: a submission that
    // moves off `on-hold` renders the status it moved to, and one that moves
    // back collapses again. A cached or persisted rewrite of the stored value
    // would fail one of these.
    const seeded = await seedSubmission(page, 8)

    await setStatus(request, seeded.reference, COLLAPSED_FROM, 1200)
    let shown = await readDetailStatus(page, seeded.url)
    expect(shown.pill, "stored on-hold draws as in-progress").toBe(COLLAPSED_TO)
    expect(shown.pillText).toBe(COLLAPSED_TEXT)

    await setStatus(request, seeded.reference, "quality-check", 1201)
    shown = await readDetailStatus(page, seeded.url)
    expect(shown.pill, "moving off on-hold renders the new status").toBe("quality-check")
    expect(shown.pillText).toBe("Quality check")

    await setStatus(request, seeded.reference, COLLAPSED_FROM, 1202)
    shown = await readDetailStatus(page, seeded.url)
    expect(shown.pill, "moving back onto on-hold collapses again").toBe(COLLAPSED_TO)
    expect(shown.pillText).toBe(COLLAPSED_TEXT)

    await setStatus(request, seeded.reference, "shipped", 1203)
    shown = await readDetailStatus(page, seeded.url)
    expect(shown.pill, "a terminal status after on-hold is its own word").toBe("shipped")
    expect(shown.pillText).toBe("Shipped")
  })
})
