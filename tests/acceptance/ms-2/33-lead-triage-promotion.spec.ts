import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test"

/**
 * ms-2 sealed acceptance slice — issue #33
 * "[portal] Lead triage — promote a lead to a submission, and issue the Access seat"
 *
 * Written from `tests/acceptance/ms-2/contract.md` and the three operator mocks
 * it pins (`mocks/04-leads-inbox.html`, `mocks/05-lead-detail.html`,
 * `mocks/06-lead-promoted.html`), without sight of any implementation.
 *
 * SCOPE. Issue #33's own Scope section names four things, and they are what this
 * slice asserts:
 *
 *  1. **An operator-facing list of leads with enough of each to decide** —
 *     `GET /leads`, the row hooks the contract pins, and the operator topbar
 *     that distinguishes this surface from ms-1's customer one.
 *  2. **The promote action** — `POST /leads/:id/promote`, producing a submission
 *     *owned by the lead's email*, idempotent under a double-click, a retried
 *     request and two concurrent promotes.
 *  3. **The lead records its promotion and the submission it produced** —
 *     `data-status="promoted"`, the Promoted pill, and
 *     `promoted-submission-reference`.
 *  4. **The in-flow reminder that the Access seat is a manual step** — the
 *     contract calls this "issue #33's one non-negotiable" and says a test may
 *     treat its absence on a promoted lead as a failure on its own. It is
 *     asserted here twice: `access-seat-reminder` *before* the operator acts
 *     (mock `05`) and `access-seat-manual-step` *after* (mock `06`), the second
 *     with the exact pinned wording.
 *
 * Plus the two cross-cutting invariants the contract attaches to this issue:
 *  - **Operator access** ("Operator access", pinned by the contract, not by any
 *    issue): anonymous and non-operator callers get a 404, never a 403 and never
 *    a login redirect.
 *  - **Coord never sees leads** (issue #33; contract note 7): no `lead.*` event
 *    on `GET /api/bridge/pull`, and promotion's only bridge-visible trace is the
 *    ordinary `submission.created` event ms-1 already pins.
 *
 * NOT COVERED HERE, deliberately:
 *  - **The public form itself (#31)** and **the bot gate / rate limit (#32)**.
 *    Leads are seeded here through the pinned `POST /start` because that is the
 *    only way a lead can come into existence black-box, but nothing about that
 *    screen is asserted — #31's slice owns it.
 *  - **Declining / archiving a lead.** Contract note 3: this contract pins no
 *    decline `data-testid`, no such route, and no such mock. A worker who builds
 *    one is additive to the contract, so this slice neither requires nor forbids
 *    it.
 *  - **The empty leads inbox (`leads-list-empty`).** The contract pins the hook
 *    in prose, but it is unassertable from this slice: the acceptance database is
 *    wiped per *run*, not per *test*, and `31-public-lead-form.spec.ts` sorts
 *    before this file and creates leads of its own. By the time `/leads` is first
 *    reachable here the inbox is never empty. Left to whoever can seed a run that
 *    contains only this file.
 *
 * SYNTHETIC DATA. Per CLAUDE.md rule 1 and the contract's "Synthetic data"
 * section, every email, name and phrase below is invented.
 */

const ACCESS_HEADER = "Cf-Access-Authenticated-User-Email"

/**
 * The operator identity.
 *
 * TODO(test-author): this is the least-pinned thing in the slice, and it is
 * flagged loudly because a mismatch here fails every test in the file for a
 * reason that has nothing to do with issue #33's behaviour.
 *
 * The contract's "Operator access" section resolves that `/leads*` is gated on
 * an allowlist of Access identities, and says explicitly that only the
 * *behaviour* is pinned — "read the implementation's actual env var name rather
 * than assuming this contract's suggested one shipped unchanged". This slice is
 * sealed and written without sight of the implementation, so it cannot do that.
 * It takes the only address the contract actually shows: `ops@example.test`,
 * which is what all three operator mocks render in `identity-email`.
 *
 * Two things the implementer must therefore do for this slice to run at all:
 *  - make `ops@example.test` an operator in the acceptance environment (the
 *    `serve:acceptance` server, i.e. a `[vars]` entry in `wrangler.toml` or a
 *    `.dev.vars` the local run picks up) — `playwright.acceptance.config.ts` and
 *    the `serve:acceptance` script are outside this slice's writable surface, so
 *    the test author cannot configure it from here;
 *  - or export `COORD_PORTAL_OPERATOR_EMAIL` for the run, the same escape hatch
 *    ms-1's bridge slice uses for its service-token pair.
 */
const OPERATOR_EMAIL = process.env.COORD_PORTAL_OPERATOR_EMAIL ?? "ops@example.test"

/** Contract: `lead-reference` text pattern `LEAD-XXXXXX`. */
const LEAD_REFERENCE = /LEAD-[A-Z0-9]{6}/
/** ms-1's customer-visible submission reference, which promotion mints one of. */
const SUBMISSION_REFERENCE = /SUB-[A-Z0-9]{6}/
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

/** Contract, "Bot gate + rate limit": the literal token a test sitekey mints. */
const TURNSTILE_DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX"
const TURNSTILE_FIELD = "cf-turnstile-response"

/**
 * The daemon's service-token credential — same convention, same defaults and
 * same escape hatch as `tests/acceptance/ms-1/15-sync-bridge.spec.ts`, so the
 * bridge test below stays runnable under exactly the environment that slice
 * already runs under. Invented values, not a real credential.
 */
const SERVICE_TOKEN = {
  "CF-Access-Client-Id":
    process.env.COORD_BRIDGE_CLIENT_ID ?? "9f2c17b4a8de40518c6b3ad0e75f1c62.access",
  "CF-Access-Client-Secret":
    process.env.COORD_BRIDGE_CLIENT_SECRET ??
    "4d1e9c07b35a2f68e4c81079ba6d35f2c9017e4ab8d562309fc71ea48b0d63a5",
}

/** ms-1's customer topbar hooks. The operator topbar is "distinct from" it. */
const CUSTOMER_TOPBAR = ["nav-dashboard", "nav-new", "nav-new-cta"]

interface LeadInput {
  summary: string
  email: string
  name?: string
}

interface SeededLead extends LeadInput {
  reference: string
}

/**
 * A distinct synthetic lead per test, so no assertion depends on test order and
 * no `hasText` filter can match a neighbouring test's row.
 *
 * TODO(test-author): every lead here is created through `POST /start`, which
 * #32 puts a per-IP rate limit in front of. The contract pins neither the
 * threshold nor the window, so this slice cannot know how many leads a single
 * acceptance run may seed from 127.0.0.1 before the gate trips — it keeps the
 * count deliberately low (one or two per test) but that is a guess, not a
 * guarantee. If `seedLead` starts failing with "no receipt" once #32 lands, the
 * rate limit is the first thing to look at, not this slice's logic.
 */
function leadInput(tag: string): Required<LeadInput> {
  return {
    summary:
      `A shared allotment watering rota (${tag.toUpperCase()}-33) — right now it ` +
      `lives on a whiteboard and nobody off-site can read it.`,
    email: `noor.${tag}.33@example.test`,
    name: "Noor",
  }
}

// ── identities ──────────────────────────────────────────────────────────────

/** Local `wrangler dev` has no Access in front of it, so identity arrives as the header. */
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

// ── seeding, through the pinned public surface ──────────────────────────────

/**
 * If #32's widget is on the page, let it mint its token before we submit; if it
 * is not, do nothing. Failures are swallowed on purpose — this removes a race,
 * it does not assert anything about Turnstile, which is another issue's slice.
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

/** Create one lead the way a stranger does, and return it with its reference. */
async function seedLead(
  browser: Browser,
  baseURL: string | undefined,
  values: Required<LeadInput> | LeadInput,
): Promise<SeededLead> {
  const context = await asStranger(browser, baseURL)
  const page = await context.newPage()
  await page.goto("/start")
  await page.getByTestId("field-lead-summary").fill(values.summary)
  await page.getByTestId("field-lead-email").fill(values.email)
  if (values.name !== undefined) {
    await page.getByTestId("field-lead-name").fill(values.name)
  }
  await settleBotGate(page)
  await page.getByTestId("submit-lead").click()
  await expect(
    page.getByTestId("lead-receipt"),
    "seeding a lead needs POST /start to render its receipt (#31); if this is " +
      "failing, check #32's rate limit before suspecting #33",
  ).toBeVisible()
  const receipt = (await page.getByTestId("lead-reference").innerText()).trim()
  const match = receipt.match(LEAD_REFERENCE)
  expect(match, `POST /start should mint a LEAD-XXXXXX reference, got: ${receipt}`).not.toBeNull()
  await context.close()
  return { ...values, reference: match![0] }
}

// ── operator surface navigation ─────────────────────────────────────────────

/** The `/leads/:id` path for a seeded lead, taken from its inbox row's `review-lead`. */
async function leadPath(operator: Page, lead: SeededLead): Promise<string> {
  await operator.goto("/leads")
  const row = operator.getByTestId("lead-row").filter({ hasText: lead.email })
  await expect(row, `exactly one inbox row for ${lead.email}`).toHaveCount(1)
  const href = await row.getByTestId("review-lead").getAttribute("href")
  expect(href, "`review-lead` links to the lead's own detail screen").toMatch(/^\/leads\/[^/]+$/)
  return href!
}

/** Assert the operator topbar the contract pins for screens `04`, `05`, `06`. */
async function expectOperatorTopbar(page: Page) {
  await expect(page.getByTestId("brand-home")).toBeVisible()
  await expect(page.getByTestId("nav-leads")).toBeVisible()
  await expect(page.getByTestId("nav-leads")).toHaveAttribute("aria-current", "page")
  await expect(page.getByTestId("identity-email")).toHaveText(`signed in as ${OPERATOR_EMAIL}`)
  // "distinct from ms-1's customer topbar" — the operator is not a customer and
  // has no dashboard of their own to be offered. All three operator mocks carry
  // exactly `brand-home`, `nav-leads`, `identity-email` and nothing else.
  for (const hook of CUSTOMER_TOPBAR) {
    await expect(
      page.getByTestId(hook),
      `the operator topbar must not carry ms-1's ${hook}`,
    ).toHaveCount(0)
  }
}

/** Promote through the pinned form, the way an operator does. */
async function promoteViaUi(operator: Page, path: string) {
  await operator.goto(path)
  await expect(operator.getByTestId("lead-detail")).toHaveAttribute("data-status", "new")
  await operator.getByTestId("promote-button").click()
  // Contract route table: the promote POST redirects back to `GET /leads/:id`.
  await expect(operator.getByTestId("lead-detail")).toHaveAttribute("data-status", "promoted")
  expect(new URL(operator.url()).pathname, "promotion lands back on the lead").toBe(path)
}

/** The `SUB-XXXXXX` promotion recorded on the lead. */
async function promotedReference(operator: Page): Promise<string> {
  const text = await operator.getByTestId("promoted-submission-reference").innerText()
  const match = text.match(SUBMISSION_REFERENCE)
  expect(
    match,
    `a promoted lead records the submission it produced, got: ${text}`,
  ).not.toBeNull()
  return match![0]
}

/** A raw form POST to the promote route, never following the redirect. */
function postPromote(request: APIRequestContext, path: string) {
  return request.post(`${path}/promote`, {
    form: {},
    maxRedirects: 0,
    failOnStatusCode: false,
  })
}

// ── ms-1 surfaces this slice reads across into ──────────────────────────────

/** The lead's own customer dashboard: what they will see once they have a seat. */
async function submissionRows(
  browser: Browser,
  baseURL: string | undefined,
  email: string,
): Promise<{ count: number; hrefs: string[]; text: string }> {
  const context = await withIdentity(browser, baseURL, email)
  const page = await context.newPage()
  await page.goto("/submissions")
  const rows = page.getByTestId("submission-row")
  const count = await rows.count()
  const hrefs: string[] = []
  for (let i = 0; i < count; i++) {
    const href = await rows.nth(i).getAttribute("href")
    if (href) hrefs.push(href)
  }
  const text = await page.locator("body").innerText()
  await context.close()
  return { count, hrefs, text }
}

interface BridgeEvent {
  id: string
  revision: number
  type: string
  submission_id: string
  occurred_at: string
  payload: unknown
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
    const body = (await res.json()) as {
      events: BridgeEvent[]
      cursor: string | null
      has_more: boolean
    }
    events.push(...body.events)
    if (typeof body.cursor === "string" && body.cursor.length > 0) at = body.cursor
    if (!body.has_more) return { events, cursor: at }
    expect(body.events.length, "`has_more: true` with no events would page forever").toBeGreaterThan(
      0,
    )
  }
  throw new Error("pull never reported has_more:false — the cursor is not advancing")
}

// ── tests ───────────────────────────────────────────────────────────────────

test.describe("ms-2 issue 33 lead triage and promotion", () => {
  test("the leads inbox gives an operator enough of each lead to decide", async ({
    browser,
    baseURL,
  }) => {
    const lead = await seedLead(browser, baseURL, leadInput("inbox"))

    const context = await asOperator(browser, baseURL)
    const page = await context.newPage()
    const response = await page.goto("/leads")
    expect(response?.status(), "the operator reaches their own inbox").toBe(200)
    await expectOperatorTopbar(page)

    await expect(page.getByTestId("leads-list")).toBeVisible()
    const row = page.getByTestId("lead-row").filter({ hasText: lead.email })
    await expect(row, "the lead a stranger just sent is in the inbox").toHaveCount(1)

    // Contract, leads inbox (`04`): each row carries what triage needs.
    await expect(row.getByTestId("lead-summary")).toContainText("INBOX-33")
    await expect(row.getByTestId("lead-contact-email")).toHaveText(lead.email)
    expect(await row.getByTestId("lead-submitted-at").innerText()).toMatch(ISO_8601)
    await expect(row).toHaveAttribute("data-status", "new")
    await expect(row.getByTestId("lead-status-pill")).toHaveAttribute("data-status", "new")
    await expect(row.getByTestId("lead-status-pill")).toHaveText("New")
    await expect(row.getByTestId("review-lead")).toHaveAttribute("href", /^\/leads\/[^/]+$/)

    // "There is no `declined`, `archived`, or `spam` status in this contract."
    for (const status of await page
      .getByTestId("lead-status-pill")
      .evaluateAll((pills) => pills.map((p) => p.getAttribute("data-status")))) {
      expect(["new", "promoted"], "the lead lifecycle has exactly two states").toContain(status)
    }

    await context.close()
  })

  test("the inbox is ordered newest first", async ({ browser, baseURL }) => {
    // TODO(test-author): contract note 4 flags "newest first" as this contract's
    // own inference rather than something issue #33 pins ("enough of each to
    // decide" is all the issue says). It is asserted here because the route
    // table states it outright; a worker who reads note 4 as licence to sort
    // some other way is diverging from the contract, not from the issue.
    const older = await seedLead(browser, baseURL, leadInput("order-a"))
    // Second-resolution timestamps would tie if these were sent back to back.
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    const newer = await seedLead(browser, baseURL, leadInput("order-b"))

    const context = await asOperator(browser, baseURL)
    const page = await context.newPage()
    await page.goto("/leads")

    const emails = await page
      .getByTestId("lead-row")
      .locator('[data-testid="lead-contact-email"]')
      .allInnerTexts()
    const trimmed = emails.map((e) => e.trim())
    expect(trimmed).toContain(older.email)
    expect(trimmed).toContain(newer.email)
    expect(
      trimmed.indexOf(newer.email),
      "the most recently sent lead is nearer the top",
    ).toBeLessThan(trimmed.indexOf(older.email))

    await context.close()
  })

  test("a lead's detail screen shows what the stranger actually sent", async ({
    browser,
    baseURL,
  }) => {
    const lead = await seedLead(browser, baseURL, leadInput("detail"))
    const context = await asOperator(browser, baseURL)
    const page = await context.newPage()
    const path = await leadPath(page, lead)

    const response = await page.goto(path)
    expect(response?.status()).toBe(200)
    await expectOperatorTopbar(page)

    // Contract, lead detail (`05`), both statuses.
    const detail = page.getByTestId("lead-detail")
    await expect(detail).toHaveAttribute("data-status", "new")
    await expect(page.getByTestId("back-to-leads")).toHaveAttribute("href", "/leads")
    await expect(page.getByTestId("lead-status-pill")).toHaveAttribute("data-status", "new")
    await expect(page.getByTestId("lead-status-pill")).toHaveText("New")
    await expect(page.getByTestId("lead-reference")).toContainText(lead.reference)
    expect(await page.getByTestId("lead-submitted-at").innerText()).toMatch(ISO_8601)
    await expect(page.getByTestId("lead-contact-email")).toHaveText(lead.email)
    await expect(page.getByTestId("lead-name")).toHaveText(lead.name!)

    // "Enough of each to decide" — the summary is shown in full here, not
    // truncated the way the inbox row may be.
    await expect(page.getByTestId("lead-summary-full")).toHaveText(lead.summary)

    // A promoted lead's hooks must not be on a `new` one.
    await expect(page.getByTestId("access-seat-manual-step")).toHaveCount(0)
    await expect(page.getByTestId("promoted-submission-reference")).toHaveCount(0)

    await context.close()
  })

  test("a lead sent without a name renders no name at all", async ({ browser, baseURL }) => {
    // Contract: `lead-name` is "present only when the optional name was given".
    const values = leadInput("anon")
    const lead = await seedLead(browser, baseURL, {
      summary: values.summary,
      email: values.email,
    })
    const context = await asOperator(browser, baseURL)
    const page = await context.newPage()
    await page.goto(await leadPath(page, lead))

    await expect(page.getByTestId("lead-name")).toHaveCount(0)
    // ...and the screen does not invent one, or leak the local part as a stand-in.
    await expect(page.getByTestId("lead-contact-email")).toHaveText(lead.email)

    await context.close()
  })

  test("the promote surface warns, before the operator acts, that the seat is manual", async ({
    browser,
    baseURL,
  }) => {
    const lead = await seedLead(browser, baseURL, leadInput("premise"))
    const context = await asOperator(browser, baseURL)
    const page = await context.newPage()
    await page.goto(await leadPath(page, lead))

    // Contract, lead detail `new` only: shown BEFORE the operator acts, warning
    // that promoting does not grant sign-in. Issue #33: "the promote surface
    // must tell the operator, in the flow".
    const reminder = page.getByTestId("access-seat-reminder")
    await expect(reminder, "a new lead warns about the Access seat before promotion").toBeVisible()

    // Issue #33: "show the exact address the seat will be issued to, prominently
    // enough that entering the wrong one is a deliberate act". The address the
    // operator is asked to confirm is the one the lead typed — so it must be the
    // address on screen, verbatim, not a re-derivation of it.
    await expect(reminder, "the reminder names the exact seat address").toContainText(lead.email)

    const form = page.getByTestId("promote-lead-form")
    await expect(form).toHaveAttribute("method", /post/i)
    await expect(form).toHaveAttribute("action", /^\/leads\/[^/]+\/promote$/)
    await expect(page.getByTestId("promote-button")).toBeVisible()
    await expect(page.getByTestId("promote-button")).toHaveText("Promote to submission")

    // Out of scope for #33: "Any Cloudflare API call." The seam is manual by
    // design — "the thing that grants access to customer data should not be
    // reachable from the application that serves it" — so the promote surface
    // must not offer a button that claims to do it.
    await expect(
      page.getByRole("button", { name: /add to access|grant access|issue seat|invite/i }),
      "the Access seat is a manual step, not an action this app offers",
    ).toHaveCount(0)

    await context.close()
  })

  test("promotion tells the operator the Access seat is still a manual step", async ({
    browser,
    baseURL,
  }) => {
    // The contract calls this issue #33's one non-negotiable and says a test may
    // treat its absence as a failure on its own, independent of anything else on
    // the page. This test therefore asserts nothing else.
    const lead = await seedLead(browser, baseURL, leadInput("manual"))
    const context = await asOperator(browser, baseURL)
    const page = await context.newPage()
    const path = await leadPath(page, lead)
    await promoteViaUi(page, path)

    const alert = page.getByTestId("access-seat-manual-step")
    await expect(alert, "a promoted lead must say the customer cannot sign in yet").toBeVisible()
    await expect(alert).toHaveAttribute("role", "alert")
    // Contract, lead detail `promoted` only — the pinned instruction, verbatim,
    // with the lead's own address interpolated.
    await expect(alert).toHaveText(
      `This customer cannot sign in yet. Add ${lead.email} to the Access policy by hand to finish onboarding them.`,
    )

    // Mock `06`'s comment, pinned by the contract as deliberate: "the app has no
    // way to know whether the manual Access-policy step was ever done ... so the
    // reminder is NOT dismissible and is NOT shown only once." A promoted
    // submission the customer cannot reach is a silent dead end, so a revisit
    // days later must still say so.
    await page.goto("/leads")
    await page.goto(path)
    await expect(
      page.getByTestId("access-seat-manual-step"),
      "the instruction survives a revisit — it is not a one-time flash message",
    ).toBeVisible()
    await expect(page.getByTestId("access-seat-manual-step")).toContainText(lead.email)

    await context.close()
  })

  test("promotion creates one submission owned by the lead's email", async ({
    browser,
    baseURL,
  }) => {
    const lead = await seedLead(browser, baseURL, leadInput("owner"))

    // Before promotion the lead is inert: nothing exists for that address.
    const before = await submissionRows(browser, baseURL, lead.email)
    expect(before.count, "an unpromoted lead owns no submission").toBe(0)

    const context = await asOperator(browser, baseURL)
    const page = await context.newPage()
    const path = await leadPath(page, lead)
    await promoteViaUi(page, path)
    const reference = await promotedReference(page)

    // Issue #33: "Promotion creates a submission owned by that lead's email —
    // the same submission model #9 built and #12 scoped — and from that point
    // the existing loop takes over unchanged."
    const after = await submissionRows(browser, baseURL, lead.email)
    expect(after.count, "promotion creates exactly one submission for the lead").toBe(1)
    expect(after.text, "the submission the lead's dashboard shows is the one recorded").toContain(
      reference,
    )

    // Contract, "Interaction with ms-1": an ordinary ms-1 submission at status
    // `describing`. "This milestone adds no new submission fields and no new
    // status."
    const detailContext = await withIdentity(browser, baseURL, lead.email)
    const detail = await detailContext.newPage()
    await detail.goto(after.hrefs[0])
    await expect(detail.getByTestId("submission-detail")).toHaveAttribute(
      "data-status",
      "describing",
    )
    await expect(detail.getByTestId("status-pill")).toHaveText("Describing")
    await expect(detail.getByTestId("submission-reference")).toContainText(reference)
    await detailContext.close()

    // "The only thing connecting a person to their submission" is that address —
    // so nobody else acquires it. A different synthetic customer sees nothing.
    const bystander = await submissionRows(browser, baseURL, "kwame.bystander.33@example.test")
    expect(bystander.count, "promotion gives no one else a submission").toBe(0)
    expect(bystander.text).not.toContain(reference)

    await context.close()
  })

  test("promoting the same lead twice creates one submission", async ({ browser, baseURL }) => {
    const lead = await seedLead(browser, baseURL, leadInput("idem"))
    const context = await asOperator(browser, baseURL)
    const page = await context.newPage()
    const path = await leadPath(page, lead)

    await promoteViaUi(page, path)
    const first = await promotedReference(page)

    // "A double-click, a retried request, or an operator who forgot they already
    // did it must all converge on the same submission."
    const retry = await postPromote(context.request, path)
    expect(
      retry.status(),
      "a retried promote is not an error — it converges on the same submission",
    ).toBeLessThan(400)

    // ...and two concurrent promotes race onto the same one.
    const raced = await Promise.all([
      postPromote(context.request, path),
      postPromote(context.request, path),
    ])
    for (const response of raced) {
      expect(response.status(), "a concurrent promote is not an error either").toBeLessThan(400)
    }

    await page.goto(path)
    expect(await promotedReference(page), "every promote lands on the same reference").toBe(first)

    const rows = await submissionRows(browser, baseURL, lead.email)
    expect(rows.count, "four promotes of one lead create one submission").toBe(1)
    expect(rows.text).toContain(first)

    // The inbox still shows one row for this lead, not one per promote.
    await page.goto("/leads")
    await expect(page.getByTestId("lead-row").filter({ hasText: lead.email })).toHaveCount(1)

    await context.close()
  })

  test("a promoted lead records what it produced and offers no second promote", async ({
    browser,
    baseURL,
  }) => {
    const lead = await seedLead(browser, baseURL, leadInput("record"))
    const context = await asOperator(browser, baseURL)
    const page = await context.newPage()
    const path = await leadPath(page, lead)
    await promoteViaUi(page, path)
    const reference = await promotedReference(page)

    // Issue #33: "the lead must record that it was promoted, and to what, so the
    // trail from first contact to shipped work is readable end to end."
    await expect(page.getByTestId("lead-detail")).toHaveAttribute("data-status", "promoted")
    await expect(page.getByTestId("lead-status-pill")).toHaveAttribute("data-status", "promoted")
    await expect(page.getByTestId("lead-status-pill")).toHaveText("Promoted")
    await expect(page.getByTestId("lead-reference")).toContainText(lead.reference)
    expect(reference).toMatch(SUBMISSION_REFERENCE)

    // Contract: "No `promote-lead-form` / `promote-button` on this screen —
    // promotion is a one-way transition in the UI."
    await expect(page.getByTestId("promote-lead-form")).toHaveCount(0)
    await expect(page.getByTestId("promote-button")).toHaveCount(0)
    await expect(page.getByTestId("access-seat-reminder")).toHaveCount(0)

    // The trail is readable from the inbox too, without opening the lead.
    await page.goto("/leads")
    const row = page.getByTestId("lead-row").filter({ hasText: lead.email })
    await expect(row).toHaveAttribute("data-status", "promoted")
    await expect(row.getByTestId("lead-status-pill")).toHaveText("Promoted")

    await context.close()
  })

  test("the promoted submission reference is plain text the operator cannot open", async ({
    browser,
    baseURL,
  }) => {
    const lead = await seedLead(browser, baseURL, leadInput("plaintext"))
    const context = await asOperator(browser, baseURL)
    const page = await context.newPage()
    const path = await leadPath(page, lead)
    await promoteViaUi(page, path)

    // Contract, "Interaction with ms-1": `promoted-submission-reference` is plain
    // text, never a link — "a worker who adds a clickable link here would ship a
    // link that 404s for the only person who ever clicks it."
    const element = page.getByTestId("promoted-submission-reference")
    await expect(element).toBeVisible()
    expect(
      (await element.evaluate((node) => node.tagName)).toLowerCase(),
      "the reference is not itself an anchor",
    ).not.toBe("a")
    await expect(element.locator("a"), "the reference wraps no anchor").toHaveCount(0)
    await expect(
      page.locator('a[href*="/submissions"]'),
      "the operator is offered no link into a customer's submission",
    ).toHaveCount(0)

    // And the reason it is plain text holds: ms-1's #12 scoping is unchanged, so
    // the submission 404s for the operator even though they created it.
    const rows = await submissionRows(browser, baseURL, lead.email)
    expect(rows.count).toBe(1)
    const asOperatorResponse = await context.request.get(rows.hrefs[0], {
      maxRedirects: 0,
      failOnStatusCode: false,
    })
    expect(
      asOperatorResponse.status(),
      "ms-1's ownership scoping is not reopened for the operator",
    ).toBe(404)

    await context.close()
  })

  test("a lead nobody promotes stays new", async ({ browser, baseURL }) => {
    // "A lead that was not promoted stays inert forever. There is no timeout that
    // promotes, no batch job, no 'auto-accept if it looks good'."
    //
    // TODO(test-author): the contract says a test may assert this "however it's
    // simulated", but pins no way to move the portal's clock black-box — a
    // `wrangler dev` Worker has no test-only time control this contract names.
    // So this asserts real elapsed time plus repeated reads, which can only
    // catch an auto-promotion on a short timer or one that fires on read. A
    // nightly batch job would slip past it.
    const lead = await seedLead(browser, baseURL, leadInput("inert"))
    const context = await asOperator(browser, baseURL)
    const page = await context.newPage()
    const path = await leadPath(page, lead)

    for (let attempt = 0; attempt < 4; attempt++) {
      await page.goto(path)
      await expect(
        page.getByTestId("lead-detail"),
        "time passing alone never promotes a lead",
      ).toHaveAttribute("data-status", "new")
      await expect(page.getByTestId("promoted-submission-reference")).toHaveCount(0)
      await new Promise((resolve) => setTimeout(resolve, 750))
    }

    const rows = await submissionRows(browser, baseURL, lead.email)
    expect(rows.count, "an unpromoted lead never becomes a submission").toBe(0)

    await context.close()
  })

  test("the leads surface is a 404 to anyone who is not the operator", async ({
    browser,
    baseURL,
  }) => {
    const lead = await seedLead(browser, baseURL, leadInput("gate"))
    const operatorContext = await asOperator(browser, baseURL)
    const operatorPage = await operatorContext.newPage()
    const path = await leadPath(operatorPage, lead)

    const strangerContext = await asStranger(browser, baseURL)
    // "A synthetic customer identity ... must be rejected from `/leads*` exactly
    // like an anonymous caller." The lead's own address is the sharpest case:
    // the person the lead is about still may not read the operator's inbox.
    const customerContext = await withIdentity(browser, baseURL, lead.email)

    for (const [who, ctx] of [
      ["an anonymous caller", strangerContext],
      ["a customer identity", customerContext],
    ] as const) {
      for (const target of ["/leads", path]) {
        const response = await ctx.request.get(target, {
          maxRedirects: 0,
          failOnStatusCode: false,
        })
        // "No Access identity, or an identity not on that allowlist, gets exactly
        // the same response as a not-found lead — a 404, never a login redirect,
        // never a 403 that confirms `/leads` exists."
        expect(response.status(), `${who} gets a 404 from ${target}`).toBe(404)
        const body = await response.text()
        expect(body, `${who} learns nothing about the lead`).not.toContain(lead.email)
        expect(body, `${who} learns nothing about the lead`).not.toContain(lead.reference)
        expect(body, `${who} is not told the operator surface exists`).not.toContain(
          'data-testid="leads-list"',
        )
      }

      // Nor may a non-operator drive the transition the UI won't show them.
      const promote = await ctx.request.post(`${path}/promote`, {
        form: {},
        maxRedirects: 0,
        failOnStatusCode: false,
      })
      expect(promote.status(), `${who} cannot promote a lead`).toBe(404)
    }

    // "Nothing crosses from the public surface into the pipeline without it" —
    // the human gate held: the lead is untouched and no submission exists.
    await operatorPage.goto(path)
    await expect(operatorPage.getByTestId("lead-detail")).toHaveAttribute("data-status", "new")
    const rows = await submissionRows(browser, baseURL, lead.email)
    expect(rows.count, "a rejected promote creates nothing").toBe(0)

    await strangerContext.close()
    await customerContext.close()
    await operatorContext.close()
  })

  test("coord never sees leads — promotion looks like an ordinary submission", async ({
    browser,
    baseURL,
    request,
  }) => {
    // Issue #33: "A lead is portal-owned end to end. Coord never sees leads;
    // they are pre-pipeline by construction, and the sync bridge (#15) must not
    // learn about them." Contract note 7 makes this directly assertable.
    const baseline = await pullSince(request, null)

    const lead = await seedLead(browser, baseURL, leadInput("bridge"))
    const afterLead = await pullSince(request, baseline.cursor)
    expect(
      afterLead.events,
      "a lead arriving is pre-pipeline — the daemon never hears about it",
    ).toHaveLength(0)

    const context = await asOperator(browser, baseURL)
    const page = await context.newPage()
    const path = await leadPath(page, lead)
    await promoteViaUi(page, path)
    const reference = await promotedReference(page)

    const afterPromote = await pullSince(request, afterLead.cursor ?? baseline.cursor)
    expect(
      afterPromote.events,
      "promotion's only bridge-visible trace is one ordinary submission.created",
    ).toHaveLength(1)
    const event = afterPromote.events[0]
    // "Promotion must produce exactly the same event shape, from the daemon's
    // point of view, as if the customer had filled out `/intake` directly."
    expect(event.type).toBe("submission.created")
    expect(event.submission_id).toBe(reference)
    expect(typeof event.revision).toBe("number")

    // Nothing lead-shaped anywhere in the stream, at any point in the run.
    const whole = await pullSince(request, null)
    for (const each of whole.events) {
      expect(each.type, "there is no lead.* event type").not.toMatch(/lead/i)
      expect(each.submission_id, "a LEAD reference is never a bridge id").not.toMatch(
        LEAD_REFERENCE,
      )
    }
    const serialised = JSON.stringify(whole.events)
    expect(serialised, "the lead's reference never crosses the bridge").not.toContain(
      lead.reference,
    )
    expect(serialised, "the lead's contact email never crosses the bridge").not.toContain(
      lead.email,
    )

    await context.close()
  })
})
