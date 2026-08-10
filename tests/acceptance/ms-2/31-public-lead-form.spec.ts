import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test"

/**
 * ms-2 sealed acceptance slice — issue #31
 * "[portal] Public lead form — first contact with no account"
 *
 * Written from `tests/acceptance/ms-2/contract.md` and the three public mocks it
 * pins (`mocks/01-start-form.html`, `mocks/02-start-receipt.html`,
 * `mocks/03-start-rejected.html`), without sight of any implementation.
 *
 * SCOPE. Issue #31 names exactly two routes and calls them "the whole surface":
 * `GET /start` (a short public form) and `POST /start` (records a **lead** and
 * renders a receipt carrying a quotable reference). Three things about that are
 * black-box observable, and they are what this slice asserts:
 *
 *  1. **It is public.** It works with no Access identity at all — no 500, no
 *     redirect to a login, no empty personalised shell — and it never
 *     authenticates, so an Access identity that happens to be present changes
 *     nothing about what renders.
 *  2. **It leaks nothing.** "A public route must expose nothing about existing
 *     submissions, customers, or the fleet." Asserted against a portal that
 *     genuinely holds another customer's submission, so the assertions cannot
 *     pass merely because the database is empty.
 *  3. **A lead is inert.** It "creates no submission, enters no pipeline, and
 *     dispatches nothing" — promotion is a deliberate operator act (#33).
 *
 * NOT COVERED HERE, deliberately:
 *  - **The bot gate and the rate limit (#32).** Issue #31's Out of scope says
 *    "Do not build ahead into them", so this slice asserts neither the presence
 *    of `turnstile-widget` nor any rejection banner — an implementation that
 *    ships #31 alone, with no Turnstile at all, must pass this slice. The
 *    pinned `lead-error` / `03-start-rejected.html` surface belongs to #32's.
 *  - **The operator surface (`/leads*`) and promotion (#33).** Out of scope for
 *    #31 by its own Out of scope section, and unreachable from a stranger's
 *    side. Note that this makes "no lead was created" *unassertable by counting*
 *    from inside this slice — the only lead-count surface the contract pins is
 *    `/leads`, which is #33's. Where this slice needs "nothing was created" it
 *    asserts the parts it can see: no receipt, no reference, no submission.
 *  - **The `leads` migration.** Portal-internal schema is implementation, not
 *    black-box surface (contract note 6); its effect is observable only as
 *    "a lead survives the write", which the receipt tests cover.
 *
 * TURNSTILE INTERACTION (important for whoever inherits this suite). #32 lands
 * on the same `POST /start` this slice drives, so these tests are written to
 * survive it rather than to be invalidated by it:
 *  - Browser submissions wait for a Turnstile token to appear *if and only if*
 *    the widget the contract pins is on the page, then submit. Before #32 there
 *    is no widget and the wait is skipped entirely.
 *  - Request-level submissions always carry the documented dummy token
 *    `XXXX.DUMMY.TOKEN.XXXX` in the conventional `cf-turnstile-response` field.
 *    Before #32 it is an ignored extra field; after #32 it is the token the
 *    contract's always-pass test pair accepts.
 *  TODO(test-author): the contract pins the test *key pair* but not the request
 *  field name the token arrives in (`cf-turnstile-response` is Turnstile's own
 *  convention, not something #31–#34 name), and does not pin that the
 *  acceptance environment is configured to the always-pass member of the pair —
 *  it only says a run "must configure ... the matching member of one pair,
 *  never mixed", and `mocks/01` renders the always-pass sitekey. If #32 ships
 *  wired to the always-*fail* pair under `serve:acceptance`, the successful-lead
 *  tests here become unreachable through no fault of #31's implementation.
 *
 * SYNTHETIC DATA. Per CLAUDE.md rule 1 and the contract's "Synthetic data"
 * section, every email, name and phrase below is invented.
 */

const ACCESS_HEADER = "Cf-Access-Authenticated-User-Email"

/** Contract: `lead-reference` text pattern `Reference LEAD-XXXXXX` (mock: `LEAD-9F2A6C`). */
// TODO(test-author): as in ms-1's `SUB-XXXXXX`, the contract pins neither the
// alphabet nor a fixed length. Read here literally as six upper-case
// alphanumerics, which is what both the pattern and the mock show.
const LEAD_REFERENCE = /LEAD-[A-Z0-9]{6}/
const RECEIPT_REFERENCE_TEXT = /^Reference LEAD-[A-Z0-9]{6}$/

/** ms-1's customer-minted reference, which must never surface on a public screen. */
const SUBMISSION_REFERENCE = /SUB-[A-Z0-9]{6}/

/** Contract, "Bot gate + rate limit": the literal token a test sitekey mints. */
const TURNSTILE_DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX"
const TURNSTILE_FIELD = "cf-turnstile-response"

/** ms-1's authenticated-topbar hooks. Their presence on a public screen is itself a leak. */
const AUTHENTICATED_TOPBAR = ["nav-dashboard", "nav-new", "identity-email"]

/** Hooks from every other pinned surface in this repo — none may appear on `/start`. */
const NON_PUBLIC_HOOKS = [
  ...AUTHENTICATED_TOPBAR,
  "nav-new-cta",
  "submission-list",
  "submission-row",
  "submission-detail",
  "status-pill",
  "leads-list",
  "lead-row",
  "nav-leads",
]

/** ms-1's full customer status vocabulary (that contract's pinned table). */
const STATUS_VOCABULARY = [
  "Describing",
  "In design",
  "Awaiting your sign-off",
  "Planned",
  "In progress",
  "Quality check",
  "Needs your input",
  "On hold",
  "Shipped",
]

interface Lead {
  summary: string
  email: string
  name?: string
}

/** A distinct synthetic lead per test, so no assertion depends on test order. */
function lead(tag: string): Required<Lead> {
  return {
    summary: `A printable rota for our volunteer drivers (${tag.toUpperCase()}-NONCE).`,
    email: `priya-${tag}@example.test`,
    name: "Priya",
  }
}

async function fillLead(page: Page, values: Lead) {
  await page.getByTestId("field-lead-summary").fill(values.summary)
  await page.getByTestId("field-lead-email").fill(values.email)
  if (values.name !== undefined) {
    await page.getByTestId("field-lead-name").fill(values.name)
  }
}

/**
 * If #32's widget is on the page, give it a chance to mint its token before we
 * submit; if it is not (a #31-only implementation), do nothing at all. Failures
 * here are swallowed on purpose — this helper exists to remove a race, not to
 * assert anything about Turnstile, which is another issue's slice.
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

/** Submit the pinned form and wait for the receipt `POST /start` renders directly. */
async function submitLead(page: Page): Promise<string> {
  await settleBotGate(page)
  await page.getByTestId("submit-lead").click()
  await expect(page.getByTestId("lead-receipt")).toBeVisible()
  const reference = (await page.getByTestId("lead-reference").innerText()).trim()
  expect(reference).toMatch(RECEIPT_REFERENCE_TEXT)
  return reference.match(LEAD_REFERENCE)![0]
}

/** A form-encoded `POST /start`, never following a redirect, so a 303 stays visible as one. */
async function postStart(
  request: APIRequestContext,
  fields: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const response = await request.post("/start", {
    form: { [TURNSTILE_FIELD]: TURNSTILE_DUMMY_TOKEN, ...fields },
    maxRedirects: 0,
    failOnStatusCode: false,
  })
  return { status: response.status(), body: await response.text() }
}

async function bodyText(context: BrowserContext, url: string): Promise<string> {
  const page = await context.newPage()
  await page.goto(url)
  const text = await page.locator("body").innerText()
  await page.close()
  return text
}

/** A browser context carrying an injected Access identity (ms-1's mechanism). */
async function asCustomer(
  browser: Browser,
  baseURL: string | undefined,
  email: string,
): Promise<BrowserContext> {
  return browser.newContext({ baseURL, extraHTTPHeaders: { [ACCESS_HEADER]: email } })
}

/**
 * Create one ms-1 submission through the pinned intake form, so the leak
 * assertions run against a portal that actually holds customer material.
 */
async function createSubmission(
  context: BrowserContext,
  nonce: string,
): Promise<{ reference: string; nonce: string }> {
  const page = await context.newPage()
  await page.goto("/intake")
  await page
    .getByTestId("field-outcome")
    .fill(`A seed-swap roster for allotment members (${nonce}).`)
  await page.getByTestId("field-audience").fill("our allotment committee")
  await page
    .getByTestId("field-done-definition")
    .fill("The roster prints on one page with every plot number listed once.")
  await page.getByTestId("submit-intake").click()
  await expect(page.getByTestId("intake-receipt")).toBeVisible()
  const referenceText = await page.getByTestId("submission-reference").innerText()
  const match = referenceText.match(SUBMISSION_REFERENCE)
  expect(
    match,
    `ms-1 intake should mint a SUB-XXXXXX reference, got: ${referenceText}`,
  ).not.toBeNull()
  await page.close()
  return { reference: match![0], nonce }
}

/** Assert a public screen carries nothing from the authenticated portal. */
async function expectNoPortalSurface(page: Page) {
  await expect(page.getByTestId("brand-home")).toBeVisible()
  for (const hook of NON_PUBLIC_HOOKS) {
    await expect(
      page.getByTestId(hook),
      `a public screen must not render the ${hook} hook`,
    ).toHaveCount(0)
  }
}

test.describe("ms-2 issue 31 public lead form", () => {
  test("the start form is public — a stranger with no account reaches it", async ({
    page,
  }) => {
    // The default fixture context injects no Access identity: this is a
    // stranger who has never heard of Cloudflare Access.
    const response = await page.goto("/start")

    // Issue #31: "It must not 500, redirect to a login, or render an empty
    // personalised shell."
    expect(response?.status(), "GET /start must serve the form to a stranger").toBe(200)
    await expect(page).toHaveURL(/\/start$/)
    await expect(page.getByTestId("lead-form")).toBeVisible()

    // Nor may it grow an application-level front door of its own: ms-1's #12
    // recorded "no self-serve signup", and this route answers that limit with a
    // contact form, not with a registration page.
    await expect(page.locator('input[type="password"]')).toHaveCount(0)
    await expect(
      page.getByRole("button", { name: /log ?in|sign ?in|sign ?up|register/i }),
    ).toHaveCount(0)
    await expect(
      page.locator('a[href*="/login"], a[href*="/signin"], a[href*="/sign-in"]'),
    ).toHaveCount(0)

    // Contract: `01` carries `brand-home` in a header that carries nothing else.
    await expectNoPortalSurface(page)
  })

  test("the form asks only what first contact needs", async ({ page }) => {
    await page.goto("/start")

    // Contract, pinned hooks: the root form POSTs to /start.
    await expect(page.getByTestId("lead-form")).toHaveAttribute("action", "/start")
    await expect(page.getByTestId("lead-form")).toHaveAttribute("method", /post/i)

    // "What they want, some way to reach them, and nothing that feels like an
    // application": summary and email required, name optional.
    const summary = page.getByTestId("field-lead-summary")
    const email = page.getByTestId("field-lead-email")
    const name = page.getByTestId("field-lead-name")
    for (const field of [summary, email, name]) {
      await expect(field).toBeVisible()
      await expect(field).toBeEditable()
    }
    await expect(summary).toHaveAttribute("required", /.*/)
    await expect(email).toHaveAttribute("required", /.*/)
    await expect(email).toHaveAttribute("type", "email")
    await expect(name).not.toHaveAttribute("required", /.*/)

    await expect(page.getByTestId("submit-lead")).toBeVisible()
    await expect(page.getByTestId("submit-lead")).toHaveText("Send")

    // "Deliberately short: this is first contact, not intake proper." None of
    // ms-1's five intake fields belongs here.
    for (const intakeField of [
      "field-outcome",
      "field-audience",
      "field-done-definition",
      "field-constraints",
      "field-project-scope",
      "submit-intake",
    ]) {
      await expect(
        page.getByTestId(intakeField),
        `${intakeField} is ms-1's intake surface, not first contact`,
      ).toHaveCount(0)
    }
  })

  test("sending the form returns a receipt with a quotable reference", async ({
    page,
  }) => {
    const values = lead("receipt")
    await page.goto("/start")
    await fillLead(page, values)
    const reference = await submitLead(page)

    // Contract: `02-start-receipt.html` is the literal 200 response body of a
    // successful POST — the receipt, its reference, and one way back.
    await expect(page.getByTestId("lead-receipt")).toBeVisible()
    expect(reference).toMatch(LEAD_REFERENCE)
    await expect(page.getByTestId("back-home")).toHaveAttribute("href", "/")

    // Still public, still nothing personalised: the receipt is screen `02`,
    // which shares `01`'s header rule.
    await expectNoPortalSurface(page)

    // "A reference the person can quote in an email" — so it must survive into
    // the rendered page, not just into a header or a cookie.
    expect(await page.locator("body").innerText()).toContain(reference)
  })

  test("the name field really is optional", async ({ page }) => {
    const values = lead("noname")
    await page.goto("/start")
    await fillLead(page, { summary: values.summary, email: values.email })
    const reference = await submitLead(page)
    expect(reference).toMatch(LEAD_REFERENCE)
  })

  test("an incomplete form creates no lead and redisplays the form", async ({
    page,
    request,
  }) => {
    const values = lead("incomplete")

    // The browser is stopped by the pinned `required` attributes before a
    // request is ever made — no receipt, no navigation away from the form.
    await page.goto("/start")
    await page.getByTestId("submit-lead").click()
    await page.waitForTimeout(1000) // no navigation to wait for; give one a chance
    await expect(page).toHaveURL(/\/start$/)
    await expect(page.getByTestId("lead-receipt")).toHaveCount(0)

    // And the server does not rely on that: contract, "Validation failure
    // (missing `summary` or `email`) ... status 400", form redisplayed.
    // TODO(test-author): the contract puts both failure families on
    // `03-start-rejected.html`'s content but describes the validation one as a
    // "plain 'fill in the required fields' style error" rather than pinning the
    // `lead-error` banner's exact wording for it — so no error copy is asserted
    // here, only the status, the redisplayed form, and the absent reference.
    for (const incomplete of [
      { summary: values.summary },
      { email: values.email },
      { summary: "", email: "" },
    ]) {
      const { status, body } = await postStart(request, incomplete as Record<string, string>)
      expect(status, `POST /start ${JSON.stringify(incomplete)} must be rejected`).toBe(400)
      expect(body, "a rejected POST mints no reference").not.toMatch(LEAD_REFERENCE)
      expect(body, "the form is redisplayed so the person can fix it").toContain(
        'data-testid="lead-form"',
      )
    }
  })

  test("each lead gets its own reference", async ({ page }) => {
    await page.goto("/start")
    await fillLead(page, lead("unique-one"))
    const first = await submitLead(page)

    await page.goto("/start")
    await fillLead(page, lead("unique-two"))
    const second = await submitLead(page)

    expect(second).not.toBe(first)
  })

  test("the receipt is the response to POST /start, not a redirect to a lead page", async ({
    page,
    request,
  }) => {
    // Contract, "`POST /start` does not redirect": there is no `GET /start/:id`
    // for a stranger to be redirected to, and `02` is the 200 body itself.
    const values = lead("noredirect")
    const { status, body } = await postStart(request, {
      summary: values.summary,
      email: values.email,
      name: values.name,
    })
    expect(status, "POST /start renders the receipt directly, at 200").toBe(200)
    expect(body).toMatch(LEAD_REFERENCE)
    expect(body).toContain('data-testid="lead-receipt"')

    // Same thing from the browser's side: the person is still on /start.
    await page.goto("/start")
    await fillLead(page, lead("noredirect-ui"))
    const reference = await submitLead(page)
    await expect(page).toHaveURL(/\/start$/)

    // "A lead has no screen a stranger ever revisits" — the reference is
    // something to quote in an email, not a URL to come back to.
    // TODO(test-author): the contract pins the route table but not what an
    // *unpinned* path returns, so no status code is asserted for these probes —
    // only that no lead material is served from one.
    for (const probe of [`/start/${reference}`, `/start?ref=${reference}`]) {
      const response = await request.get(probe, { failOnStatusCode: false })
      expect(
        await response.text(),
        `${probe} must not resurrect the lead`,
      ).not.toContain(values.summary)
    }
  })

  test("the public surface exposes nothing about submissions, customers, or the fleet", async ({
    browser,
    baseURL,
    page,
  }) => {
    // Give the portal real customer material first, so every assertion below is
    // about non-disclosure rather than about an empty database.
    const customer = "ada-leak@example.test"
    const customerContext = await asCustomer(browser, baseURL, customer)
    const submission = await createSubmission(customerContext, "LEAK-PROBE-4417")
    await customerContext.close()

    const values = lead("leak")
    await page.goto("/start")
    const formText = await page.locator("body").innerText()
    await fillLead(page, values)
    await submitLead(page)
    const receiptText = await page.locator("body").innerText()
    await expectNoPortalSurface(page)

    for (const [screen, text] of [
      ["GET /start", formText],
      ["POST /start receipt", receiptText],
    ] as const) {
      // "No hint that other customers exist."
      expect(text, `${screen} must not name a customer`).not.toContain(customer)
      expect(text, `${screen} must not leak submission material`).not.toContain(
        submission.nonce,
      )
      expect(text, `${screen} must not leak a submission reference`).not.toMatch(
        SUBMISSION_REFERENCE,
      )
      expect(text, `${screen} must not hint that other customers exist`).not.toMatch(
        /other (customers?|clients?)|existing (customers?|clients?)/i,
      )

      // "No counts."
      expect(text, `${screen} must not report a count`).not.toMatch(
        /\b\d+\s+(open\s+|active\s+|other\s+)?(submissions?|customers?|clients?|leads?|projects?|requests?|jobs?)\b/i,
      )

      // "No status vocabulary."
      for (const status of STATUS_VOCABULARY) {
        expect(
          text,
          `${screen} must not use the customer status vocabulary (${status})`,
        ).not.toContain(status)
      }

      // "No engineer-side identifiers" — ms-1's contract note 6, unchanged.
      for (const pattern of [/#\d+/, /\bbranch\b/i, /\bpull request\b/i, /\bPR\s*#/i]) {
        expect(text, `${screen} must carry no engineer-side identifier`).not.toMatch(
          pattern,
        )
      }
    }
  })

  test("a lead is inert — it creates no submission and enters no pipeline", async ({
    browser,
    baseURL,
    page,
  }) => {
    const values = lead("inert")
    await page.goto("/start")
    await fillLead(page, values)
    const reference = await submitLead(page)

    // "A lead is inert: it creates no submission, enters no pipeline, and
    // dispatches nothing." The one place that would show is ms-1's dashboard
    // for the very address the stranger gave — if the lead had become a
    // submission, it would be theirs. (Being on `/leads` is #33's surface and
    // is deliberately not asserted from here.)
    const leadContext = await asCustomer(browser, baseURL, values.email)
    const dashboard = await leadContext.newPage()
    await dashboard.goto("/submissions")
    await expect(
      dashboard.getByTestId("submission-row"),
      "posting a lead must not create a submission",
    ).toHaveCount(0)
    const dashboardText = await dashboard.locator("body").innerText()
    expect(dashboardText).not.toContain(values.summary)
    expect(dashboardText).not.toContain(reference)
    await dashboard.close()

    // Nor does the lead's address acquire any other authenticated material.
    const intakeText = await bodyText(leadContext, "/intake")
    expect(intakeText).not.toContain(values.summary)
    await leadContext.close()

    // The health check the CI gate reads is untouched by any of this.
    const health = await page.request.get("/api/health", { failOnStatusCode: false })
    expect(health.status()).toBe(200)
    expect(await health.text()).not.toMatch(LEAD_REFERENCE)
  })

  test("an Access identity changes nothing on the public route", async ({
    browser,
    baseURL,
  }) => {
    // "Access stays exactly as it is for the authenticated portal; this route
    // simply never authenticates." So a signed-in caller sees the same public
    // screen — in particular, no `identity-email`, which the contract calls a
    // leak in its own right ("a stranger would learn they're signed in as
    // someone").
    const signedIn = await asCustomer(browser, baseURL, "bo-public@example.test")
    const page = await signedIn.newPage()
    const response = await page.goto("/start")
    expect(response?.status()).toBe(200)
    await expect(page.getByTestId("lead-form")).toBeVisible()
    await expectNoPortalSurface(page)
    expect(await page.locator("body").innerText()).not.toContain(
      "bo-public@example.test",
    )

    // And it still records a lead — the route does not become a different route
    // when an identity happens to be attached.
    await fillLead(page, lead("identity"))
    const reference = await submitLead(page)
    expect(reference).toMatch(LEAD_REFERENCE)
    await expectNoPortalSurface(page)

    await signedIn.close()
  })
})
