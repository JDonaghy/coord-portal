import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test"

/**
 * ms-4 sealed acceptance slice — issue #132
 * "Operator 'start work' override: skip sign-off, go straight to planned"
 *
 * Written from `tests/acceptance/ms-4/contract.md` and the mocks it pins for
 * this issue (`mocks/02-lead-promoted-existing-client.html`, the "override is
 * still available" state, and `mocks/04-lead-promoted-work-started.html`, the
 * state after it has been used), without sight of any implementation.
 *
 * SCOPE. Issue #132 asks for one operator action that skips the whole
 * `Describe → In design → Awaiting sign-off → Signed off` loop and lands the
 * submission on the bridge-visible equivalent of *planned*. The contract turns
 * that into a black-box surface, and it is what this slice asserts:
 *
 *  1. **The override exists, on a promoted lead, while there is something to
 *     start** — `start-work-card` / `start-work-note` / `start-work-form`
 *     (`POST /leads/:id/start-work`) / `start-work-button` ("Start work"),
 *     alongside `attached-submission-status` reading `describing`.
 *  2. **Using it moves the submission to Planned**, and retires the card —
 *     mock `04`: `attached-submission-status` flips to `planned` and
 *     `start-work-card` "is gone entirely", the same one-way-in-the-UI
 *     convention `promote-lead-form` already established in ms-2.
 *  3. **The customer sees it too, immediately** — the contract pins this
 *     precisely: `/submissions/:id`, ms-1's unmodified rollup template,
 *     `data-status="planned"`, pill text `Planned` — reached *without* a design
 *     round and *without* a sign-off click, which is the entire point of the
 *     override.
 *  4. **Retry safety** — the button's absence is not the guarantee; the backend
 *     is. A second POST converges rather than erroring or double-advancing.
 *  5. **The operator gate** — `/leads/:id/start-work` "sits next to
 *     `/leads/:id/promote` … same operator gate (`readOperator`)", so a
 *     stranger and a customer both get ms-2's pinned 404, and the submission is
 *     untouched.
 *  6. **The bridge learns something happened** — see the TODO on that test; the
 *     *kind* of event is deliberately not asserted.
 *
 * NOT COVERED HERE, deliberately:
 *  - **Which bridge event kind fires.** Issue #132's own "one real design
 *    decision" section offers two options (reuse `signoff.approved`'s shape, or
 *    add a new kind such as `work.requested`) and the contract records that the
 *    copy of the issue it was authored against was truncated before naming the
 *    pick — "implementers must resolve this against issue #132's actual,
 *    complete text, not against this contract". This slice faces the identical
 *    gap and, as the contract instructs, flags it rather than inventing an
 *    answer. See `TODO(test-author)` in the bridge test below for exactly what
 *    it does and does not assert.
 *  - **The #835 ordering guard** the issue asks for ("if 'start work' is itself
 *    an announcing status, don't let the announcement outrun whatever it
 *    announces"). TODO(test-author): the contract pins no notification, email,
 *    `outbox` row or `email-preview` for this action at all — ms-1's sending
 *    vocabulary is `awaiting-signoff` / `needs-input` / `quality-check` /
 *    `shipped`, and `planned` is not in it. With nothing announced, there is no
 *    announcement to order, and this slice will not invent one. If the
 *    implementation chooses to announce, the guard belongs to whatever issue
 *    pins that announcement.
 *  - **`client-attachment`, `client-match-*` (#129), `reassign-*` (#130) and
 *    `/account` (#131).** Those hooks share mocks 02–05 with this issue but are
 *    other slices' subjects. The only cross-check here is negative and cheap:
 *    starting work must not disturb ms-2's already-pinned hooks on the same
 *    screen.
 *  - **Whether the start-work POST redirects (PRG) or renders in place.** The
 *    contract's route table pins the path and the resulting screen state, not a
 *    303; its PRG paragraph is written about `POST /account`. So the assertions
 *    below are written to hold either way, and re-`goto` the lead to prove the
 *    new state is durable rather than a one-shot flash.
 *
 * SYNTHETIC DATA. Per CLAUDE.md rule 1 and the contract's "Synthetic data"
 * section, every email, name and phrase below is invented and sits on RFC
 * 6761's reserved `.test` TLD.
 */

const ACCESS_HEADER = "Cf-Access-Authenticated-User-Email"

/**
 * The operator identity — same convention, same escape hatch and the same
 * caveat as `tests/acceptance/ms-2/33-lead-triage-promotion.spec.ts`, whose
 * long comment on this applies verbatim: the contract pins operator *behaviour*
 * and not the env var name, and a sealed slice cannot read the implementation
 * to find out. `ops@example.test` is the address every operator mock renders in
 * `identity-email`, including ms-4's own mocks 02 and 04.
 */
const OPERATOR_EMAIL = process.env.COORD_PORTAL_OPERATOR_EMAIL ?? "ops@example.test"

/** ms-2: `lead-reference` text pattern. */
const LEAD_REFERENCE = /LEAD-[A-Z0-9]{6}/
/** ms-1: the customer-visible submission reference promotion mints. */
const SUBMISSION_REFERENCE = /SUB-[A-Z0-9]{6}/

/** Contract, "Bot gate + rate limit" (ms-2): the token a test sitekey mints. */
const TURNSTILE_FIELD = "cf-turnstile-response"

/**
 * The daemon's service-token credential — identical defaults and escape hatch
 * to ms-1's `15-sync-bridge.spec.ts` and ms-2's `33-…` slice, so the bridge
 * test below runs under exactly the environment those already run under.
 * Invented values, not a real credential.
 */
const SERVICE_TOKEN = {
  "CF-Access-Client-Id":
    process.env.COORD_BRIDGE_CLIENT_ID ?? "9f2c17b4a8de40518c6b3ad0e75f1c62.access",
  "CF-Access-Client-Secret":
    process.env.COORD_BRIDGE_CLIENT_SECRET ??
    "4d1e9c07b35a2f68e4c81079ba6d35f2c9017e4ab8d562309fc71ea48b0d63a5",
}

interface SeededLead {
  summary: string
  email: string
  name: string
  reference: string
}

/**
 * A distinct synthetic lead per test, so nothing here depends on test order or
 * on rows another slice in the same run wrote.
 *
 * TODO(test-author): leads can only be created black-box through `POST /start`,
 * which #32 puts a per-IP rate limit in front of; ms-2's contract pins neither
 * the threshold nor the window. This slice seeds exactly one lead per test for
 * that reason. If seeding starts failing, look at the rate limit before
 * suspecting #132.
 */
function leadInput(tag: string) {
  return {
    summary:
      `A pre-agreed tidy-up of our volunteer rota page (${tag.toUpperCase()}-132) — ` +
      `we already talked this one through, it just needs doing.`,
    email: `imani.${tag}.132@example.test`,
    name: "Imani",
  }
}

// ── identities ──────────────────────────────────────────────────────────────

/** Local `wrangler dev` has no Access in front of it, so identity is the header. */
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

function asStranger(browser: Browser, baseURL: string | undefined): Promise<BrowserContext> {
  return browser.newContext({ baseURL })
}

// ── seeding, through the pinned public surface ──────────────────────────────

/**
 * Let #32's widget mint its token before submitting, if it is on the page.
 * Failures are swallowed: this removes a race, it asserts nothing.
 */
async function settleBotGate(page: Page) {
  if ((await page.getByTestId("turnstile-widget").count()) === 0) return
  await page
    .waitForFunction(
      (field) => {
        const input = document.querySelector(
          `input[name="${field}"]`,
        ) as HTMLInputElement | null
        return !!input && input.value.length > 0
      },
      TURNSTILE_FIELD,
      { timeout: 15_000 },
    )
    .catch(() => {})
}

/** Create one lead the way a stranger does (ms-2 `POST /start`). */
async function seedLead(
  browser: Browser,
  baseURL: string | undefined,
  tag: string,
): Promise<SeededLead> {
  const values = leadInput(tag)
  const context = await asStranger(browser, baseURL)
  const page = await context.newPage()
  await page.goto("/start")
  await page.getByTestId("field-lead-summary").fill(values.summary)
  await page.getByTestId("field-lead-email").fill(values.email)
  await page.getByTestId("field-lead-name").fill(values.name)
  await settleBotGate(page)
  await page.getByTestId("submit-lead").click()
  await expect(
    page.getByTestId("lead-receipt"),
    "seeding a lead needs POST /start to render its receipt (ms-2 #31)",
  ).toBeVisible()
  const receipt = (await page.getByTestId("lead-reference").innerText()).trim()
  const match = receipt.match(LEAD_REFERENCE)
  expect(match, `POST /start should mint a LEAD-XXXXXX reference, got: ${receipt}`).not.toBeNull()
  await context.close()
  return { ...values, reference: match![0] }
}

/** The `/leads/:id` path for a seeded lead, from its inbox row (ms-2 `review-lead`). */
async function leadPath(operator: Page, lead: SeededLead): Promise<string> {
  await operator.goto("/leads")
  const row = operator.getByTestId("lead-row").filter({ hasText: lead.email })
  await expect(row, `exactly one inbox row for ${lead.email}`).toHaveCount(1)
  const href = await row.getByTestId("review-lead").getAttribute("href")
  expect(href, "`review-lead` links to the lead's own detail screen").toMatch(/^\/leads\/[^/]+$/)
  return href!
}

/**
 * Promote through the pinned form, the way an operator does.
 *
 * Every lead this slice seeds uses an address no other test uses, so no
 * `clients` row matches it and #129's `client-project-list` radios are absent —
 * `promote-button` alone is the whole form, exactly as ms-2 pins it. That is
 * deliberate: this slice must not become a test of #129's matching.
 */
async function promoteViaUi(operator: Page, path: string) {
  await operator.goto(path)
  await expect(operator.getByTestId("lead-detail")).toHaveAttribute("data-status", "new")
  await operator.getByTestId("promote-button").click()
  await expect(operator.getByTestId("lead-detail")).toHaveAttribute("data-status", "promoted")
}

/** The `SUB-XXXXXX` reference a promotion recorded on the lead (ms-2). */
async function promotedReference(operator: Page): Promise<string> {
  const text = await operator.getByTestId("promoted-submission-reference").innerText()
  const match = text.match(SUBMISSION_REFERENCE)
  expect(match, `a promoted lead records the submission it produced, got: ${text}`).not.toBeNull()
  return match![0]
}

/** Seed a lead and promote it, returning the operator's page, path and reference. */
async function promotedLead(
  browser: Browser,
  baseURL: string | undefined,
  tag: string,
): Promise<{
  lead: SeededLead
  context: BrowserContext
  page: Page
  path: string
  reference: string
}> {
  const lead = await seedLead(browser, baseURL, tag)
  const context = await asOperator(browser, baseURL)
  const page = await context.newPage()
  const path = await leadPath(page, lead)
  await promoteViaUi(page, path)
  return { lead, context, page, path, reference: await promotedReference(page) }
}

/** A raw form POST to the start-work route, never following the redirect. */
function postStartWork(request: APIRequestContext, path: string) {
  return request.post(`${path}/start-work`, {
    form: {},
    maxRedirects: 0,
    failOnStatusCode: false,
  })
}

// ── the customer's own side of the wall ─────────────────────────────────────

/** The customer's submission detail path, read from their own ms-1 dashboard. */
async function customerSubmissionPath(
  browser: Browser,
  baseURL: string | undefined,
  email: string,
): Promise<{ href: string; count: number }> {
  const context = await withIdentity(browser, baseURL, email)
  const page = await context.newPage()
  await page.goto("/submissions")
  const rows = page.getByTestId("submission-row")
  const count = await rows.count()
  const href = count > 0 ? await rows.nth(0).getAttribute("href") : null
  await context.close()
  return { href: href ?? "", count }
}

/** What the customer's own `/submissions/:id` says right now. */
async function customerStatus(
  browser: Browser,
  baseURL: string | undefined,
  email: string,
  href: string,
): Promise<{ slug: string | null; pill: string }> {
  const context = await withIdentity(browser, baseURL, email)
  const page = await context.newPage()
  await page.goto(href)
  const slug = await page.getByTestId("submission-detail").getAttribute("data-status")
  const pill = (await page.getByTestId("status-pill").innerText()).trim()
  await context.close()
  return { slug, pill }
}

interface BridgeEvent {
  id: string
  revision: number
  type: string
  submission_id: string
  occurred_at: string
  payload: unknown
}

/** Read `GET /api/bridge/pull` to its end from `cursor` (ms-1's pinned shape). */
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
    const body = (await res.json()) as {
      events: BridgeEvent[]
      cursor: string | null
      has_more: boolean
    }
    events.push(...body.events)
    if (typeof body.cursor === "string" && body.cursor.length > 0) at = body.cursor
    if (!body.has_more) return { events, cursor: at }
    expect(
      body.events.length,
      "`has_more: true` with no events would page forever",
    ).toBeGreaterThan(0)
  }
  throw new Error("pull never reported has_more:false — the cursor is not advancing")
}

// ── tests ───────────────────────────────────────────────────────────────────

test.describe("ms-4 issue 132 operator start work override", () => {
  test("a promoted lead offers the start-work override while its submission is still describing", async ({
    browser,
    baseURL,
  }) => {
    const { context, page, path } = await promotedLead(browser, baseURL, "offer")

    // Contract, "After promotion": `attached-submission-status` is a
    // `.status-pill`-shaped element carrying the attached submission's
    // customer-facing status — `describing` at first (mock 02).
    const status = page.getByTestId("attached-submission-status")
    await expect(status, "a promoted lead shows where its submission actually is").toBeVisible()
    await expect(status).toHaveAttribute("data-status", "describing")
    // ms-1's status vocabulary table: `describing` → exactly "Describing".
    await expect(status).toHaveText("Describing")

    // Contract, "#132 — Rendered only while the attached submission's status has
    // not yet been moved forward by this action".
    const card = page.getByTestId("start-work-card")
    await expect(card, "the override is offered while there is work to start").toBeVisible()

    const form = page.getByTestId("start-work-form")
    await expect(form).toHaveAttribute("method", /post/i)
    await expect(form).toHaveAttribute("action", /^\/leads\/[^/]+\/start-work$/)
    // The route is this lead's own, not some other lead's.
    await expect(form).toHaveAttribute("action", `${path}/start-work`)

    const button = page.getByTestId("start-work-button")
    await expect(button).toBeVisible()
    await expect(button, "the pinned button text").toHaveText("Start work")
    await expect(
      form.getByTestId("start-work-button"),
      "the button submits the start-work form, not some other form",
    ).toHaveCount(1)

    // Contract: `start-work-note` is "not pinned verbatim beyond conveying
    // 'skips sign-off, moves to Planned, only for pre-agreed work'". Asserted as
    // those three facts being present, not as the mock's exact sentence.
    const note = page.getByTestId("start-work-note")
    await expect(note, "the note says what is being skipped").toContainText(/sign-?off/i)
    await expect(note, "the note says where it lands").toContainText(/planned/i)

    await context.close()
  })

  test("an unpromoted lead offers no start-work override and nothing to start work on", async ({
    browser,
    baseURL,
  }) => {
    // Contract, mock inventory: every screen carrying `start-work-*` is
    // `data-status="promoted"` (mocks 02–05). Mock 01 and ms-2's
    // `05-lead-detail.html` — the two `new` renderings — carry neither the
    // override nor `attached-submission-status`, because before promotion there
    // is no attached submission for either to be about.
    const lead = await seedLead(browser, baseURL, "unpromoted")
    const context = await asOperator(browser, baseURL)
    const page = await context.newPage()
    const path = await leadPath(page, lead)
    await page.goto(path)

    await expect(page.getByTestId("lead-detail")).toHaveAttribute("data-status", "new")
    for (const hook of [
      "start-work-card",
      "start-work-note",
      "start-work-form",
      "start-work-button",
      "attached-submission-status",
    ]) {
      await expect(
        page.getByTestId(hook),
        `an unpromoted lead has no submission, so no ${hook}`,
      ).toHaveCount(0)
    }

    // TODO(test-author): the contract does not pin a status code for
    // `POST /leads/:id/start-work` against a lead that was never promoted (its
    // route table pins the path and the operator gate, and nothing else), so
    // this asserts the *consequence* rather than the code: an unpromotable
    // start-work must not conjure a submission or promote the lead behind the
    // operator's back. A worker may answer that POST with a 404, a 400, or a
    // redirect back to the unchanged screen.
    await postStartWork(context.request, path)
    await page.goto(path)
    await expect(
      page.getByTestId("lead-detail"),
      "starting work on nothing does not promote the lead",
    ).toHaveAttribute("data-status", "new")
    const rows = await customerSubmissionPath(browser, baseURL, lead.email)
    expect(rows.count, "starting work on nothing creates no submission").toBe(0)

    await context.close()
  })

  test("start work moves the attached submission to Planned and retires the card", async ({
    browser,
    baseURL,
  }) => {
    const { context, page, path, reference } = await promotedLead(browser, baseURL, "override")

    await page.getByTestId("start-work-button").click()

    // Contract, mock 04: `attached-submission-status` reads
    // `data-status="planned"` — the whole point of the override, reached with no
    // design round and no customer sign-off in between.
    const status = page.getByTestId("attached-submission-status")
    await expect(status, "the override lands the submission on planned").toHaveAttribute(
      "data-status",
      "planned",
    )
    await expect(status, "ms-1's vocabulary: `planned` reads exactly Planned").toHaveText("Planned")

    // Contract: "After use (mock 04): `start-work-card` is gone entirely" — the
    // same one-way-in-the-UI convention `promote-lead-form`'s disappearance
    // already establishes.
    for (const hook of ["start-work-card", "start-work-note", "start-work-form", "start-work-button"]) {
      await expect(
        page.getByTestId(hook),
        `${hook} is gone once the override has been used`,
      ).toHaveCount(0)
    }

    // Mock 04 is a *revisit*, days later from the operator's point of view — so
    // the new state is durable, not a one-shot flash on the response to the POST.
    await page.goto("/leads")
    await page.goto(path)
    await expect(page.getByTestId("lead-detail")).toHaveAttribute("data-status", "promoted")
    await expect(page.getByTestId("attached-submission-status")).toHaveAttribute(
      "data-status",
      "planned",
    )
    await expect(page.getByTestId("start-work-card")).toHaveCount(0)

    // Mock 04 versus mock 02: "Two things change ... nothing else." Everything
    // ms-2 pins on a promoted lead is still exactly where it was.
    await expect(page.getByTestId("lead-status-pill")).toHaveText("Promoted")
    await expect(page.getByTestId("promoted-submission-reference")).toContainText(reference)
    await expect(
      page.getByTestId("access-seat-manual-step"),
      "the Access seat is still a manual step — starting work does not grant sign-in",
    ).toBeVisible()

    await context.close()
  })

  test("the customer's own submission reads Planned without a design round or a sign-off", async ({
    browser,
    baseURL,
  }) => {
    const { lead, context, page } = await promotedLead(browser, baseURL, "customer")

    const { href, count } = await customerSubmissionPath(browser, baseURL, lead.email)
    expect(count, "promotion gave the customer exactly one submission").toBe(1)

    const before = await customerStatus(browser, baseURL, lead.email, href)
    expect(before.slug, "before the override the customer is at describing").toBe("describing")
    expect(before.pill).toBe("Describing")

    await page.getByTestId("start-work-button").click()
    await expect(page.getByTestId("attached-submission-status")).toHaveAttribute(
      "data-status",
      "planned",
    )

    // Contract, "What 'planned' means here, precisely": the customer's own
    // `/submissions/:id` — ms-1's existing, unmodified rollup template — reads
    // `data-status="planned"` / "Planned" *immediately* after the operator acts,
    // by the same derivation an approved design round already uses, and without
    // the portal having written the coord-owned `status` column.
    const after = await customerStatus(browser, baseURL, lead.email, href)
    expect(after.slug, "the customer sees Planned as soon as the operator acts").toBe("planned")
    expect(after.pill).toBe("Planned")

    // ...and they got there without ever being asked to sign anything off. This
    // is the override's defining property: the customer was never handed a
    // design round to approve, and `planned` is not customer-actionable in ms-1's
    // status table, so nothing is asking them to act now either.
    const customerContext = await withIdentity(browser, baseURL, lead.email)
    const customerPage = await customerContext.newPage()
    await customerPage.goto(href)
    await expect(
      customerPage.getByTestId("status-timeline"),
      "planned is a rollup status — ms-1's rollup template renders it unchanged",
    ).toBeVisible()
    for (const hook of ["approve-button", "request-changes-button", "design-round"]) {
      await expect(
        customerPage.getByTestId(hook),
        `the override skipped the sign-off loop, so there is no ${hook}`,
      ).toHaveCount(0)
    }
    await customerContext.close()

    await context.close()
  })

  test("a repeated start work is safe and converges on the same planned submission", async ({
    browser,
    baseURL,
  }) => {
    const { lead, context, page, path } = await promotedLead(browser, baseURL, "idem")

    await page.getByTestId("start-work-button").click()
    await expect(page.getByTestId("attached-submission-status")).toHaveAttribute(
      "data-status",
      "planned",
    )

    // Contract, "After use": the missing button is a courtesy, not the guarantee
    // — "the backend's idempotency is what makes a double-click or retry safe
    // ... not a second button" (quoted from ms-2's contract and adopted here).
    // A retried POST, and two concurrent ones, must all converge.
    const retry = await postStartWork(context.request, path)
    expect(retry.status(), "a retried start-work is not an error").toBeLessThan(400)
    const raced = await Promise.all([
      postStartWork(context.request, path),
      postStartWork(context.request, path),
    ])
    for (const response of raced) {
      expect(response.status(), "a concurrent start-work is not an error either").toBeLessThan(400)
    }

    await page.goto(path)
    await expect(
      page.getByTestId("attached-submission-status"),
      "four start-works land on planned, not past it",
    ).toHaveAttribute("data-status", "planned")
    await expect(page.getByTestId("start-work-card")).toHaveCount(0)

    // Nothing was duplicated on the customer's side either.
    const rows = await customerSubmissionPath(browser, baseURL, lead.email)
    expect(rows.count, "repeated start-works do not multiply submissions").toBe(1)
    const status = await customerStatus(browser, baseURL, lead.email, rows.href)
    expect(status.slug, "and the customer is still exactly at planned").toBe("planned")

    await context.close()
  })

  test("start work is refused to anyone who is not the operator", async ({ browser, baseURL }) => {
    const { lead, context, page, path } = await promotedLead(browser, baseURL, "gate")

    const strangerContext = await asStranger(browser, baseURL)
    // The sharpest case: the customer the submission belongs to still may not
    // drive an operator-only override of their own sign-off.
    const customerContext = await withIdentity(browser, baseURL, lead.email)

    for (const [who, ctx] of [
      ["an anonymous caller", strangerContext],
      ["the customer themselves", customerContext],
    ] as const) {
      const response = await postStartWork(ctx.request, path)
      // Contract, route surface: start-work "sits next to `/leads/:id/promote`
      // ... same operator gate (`readOperator`), same 'any other method on a
      // `/leads…` path gets the lead-not-found 404' rule ms-2's contract already
      // pins" — a 404, never a 403 that confirms the route exists, never a login
      // redirect.
      expect(response.status(), `${who} cannot start work`).toBe(404)
      const body = await response.text()
      expect(body, `${who} learns nothing about the lead`).not.toContain(lead.email)
    }

    await strangerContext.close()
    await customerContext.close()

    // The refusal changed nothing: the override is still on offer to the
    // operator, and the submission never moved.
    await page.goto(path)
    await expect(page.getByTestId("attached-submission-status")).toHaveAttribute(
      "data-status",
      "describing",
    )
    await expect(page.getByTestId("start-work-card")).toBeVisible()

    const { href, count } = await customerSubmissionPath(browser, baseURL, lead.email)
    expect(count).toBe(1)
    const status = await customerStatus(browser, baseURL, lead.email, href)
    expect(status.slug, "a rejected start-work moved nothing").toBe("describing")

    await context.close()
  })

  test("starting work is visible across the bridge", async ({ browser, baseURL, request }) => {
    /**
     * TODO(test-author): issue #132 sets up a choice — reuse `signoff.approved`'s
     * shape, or define a new event kind such as `work.requested` — and says "pick
     * one and document the choice here". The contract records that the copy of
     * the issue it was written against was truncated before naming the pick, and
     * states outright: "Nothing here pins a specific `type` value on
     * `GET /api/bridge/pull`'s output for a 'start work' submission ... If a
     * sealed acceptance test needs to assert on the bridge event shape, its
     * author faces the identical gap and should flag it rather than invent an
     * answer either."
     *
     * So this test asserts only what BOTH options of #132's own decision require
     * and which the issue states in its opening line — that the transition is
     * "the bridge-visible equivalent of signed off / planned", i.e. that the
     * daemon on its next poll learns *something* about this submission that it
     * did not know before. The event's `type` is deliberately NOT asserted, and
     * this test should be tightened by whoever resolves #132's decision against
     * the issue's complete text.
     */
    const { lead, context, page, reference } = await promotedLead(browser, baseURL, "bridge")

    // Everything up to and including promotion, drained — so what follows is
    // attributable to the override alone.
    const baseline = await pullSince(request, null)

    await page.getByTestId("start-work-button").click()
    await expect(page.getByTestId("attached-submission-status")).toHaveAttribute(
      "data-status",
      "planned",
    )

    const after = await pullSince(request, baseline.cursor)
    const mine = after.events.filter((event) => event.submission_id === reference)
    expect(
      mine.length,
      "the override is bridge-visible: the daemon's next poll learns the submission moved",
    ).toBeGreaterThan(0)
    for (const event of mine) {
      expect(typeof event.revision, "ms-1's pinned event shape is unchanged").toBe("number")
      expect(typeof event.type).toBe("string")
      expect(event.occurred_at, "an event carries when it happened").toBeTruthy()
    }

    // ms-1: "Replay-safe from a cursor: pulling the same cursor twice returns
    // the same events." The override must not break that.
    const replay = await pullSince(request, baseline.cursor)
    expect(
      replay.events.map((event) => event.id),
      "re-pulling the same cursor returns the same events",
    ).toEqual(after.events.map((event) => event.id))

    // CLAUDE.md rule 2 and ms-2's note 7: the lead itself stays portal-owned and
    // pre-pipeline. An operator-side override is not licence to leak it.
    const serialised = JSON.stringify(after.events)
    expect(serialised, "the lead's reference never crosses the bridge").not.toContain(
      lead.reference,
    )

    await context.close()
  })
})
