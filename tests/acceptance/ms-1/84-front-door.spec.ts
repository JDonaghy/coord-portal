import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test"

/**
 * ms-1 sealed acceptance slice — issue #84
 * "[portal] A signed-in customer lands on 'Nothing is built yet' — the root
 *  page is still the day-one placeholder"
 *
 * Written from `tests/acceptance/ms-1/contract.md` and issue #84, without sight
 * of any implementation.
 *
 * SCOPE. #84 is about ONE route — `GET /` — and what a customer finds there
 * after Cloudflare Access has proved who they are. The issue names three
 * states and one hard constraint:
 *
 *   1. signed in, with submissions → their list, or straight through to it,
 *      "without knowing any URL";
 *   2. signed in, with none → say so plainly and point at `/intake`;
 *   3. not signed in → what the site is and how to start, in the customer's
 *      language — no engineer vocabulary, no health-endpoint link, no repo link;
 *   4. `/api/health` must stay reachable at its own path ("remove the *link*,
 *      not the endpoint").
 *
 * Everything below is an assertion about `/` and about whatever screen `/`
 * delivers the customer to. That last part matters: the issue explicitly allows
 * "their list, **or straight through to it**", so a redirect to `/submissions`
 * and a real landing page with a link on it are BOTH conformant. No test here
 * asserts which one was chosen — they assert the customer arrives.
 *
 * CONTRACT TENSION, recorded rather than resolved.
 * `contract.md`'s pinned route surface lists `GET /` as "existing skeleton page
 * (unchanged by this milestone)", and no file under `mocks/` renders a front
 * door. Issue #84 was filed later (2026-08-14, walking the first real customer
 * through sign-in) and supersedes that row for this route: the skeleton page is
 * the defect. Where #84 and the contract's route table disagree, this slice
 * follows #84; where #84 is silent on DOM detail, the contract's pinned global
 * hooks and its "no engineer-side identifier" invariant (note 6) are the only
 * things asserted. Nothing here invents copy — see the TODOs.
 *
 * NOT COVERED HERE, deliberately:
 *  - Ownership scoping of `/submissions` (issue #12's slice already owns it).
 *    #84 says `/submissions` "already exists and is ownership-scoped … this is
 *    a routing and copy problem"; re-asserting the scope here would
 *    double-report one behaviour.
 *  - The intake form's own contents (issue #9's slice). The empty-state test
 *    below asserts only that the customer is ROUTED to `/intake`.
 *  - Access application / policy configuration. #84's constraints put that
 *    explicitly out of scope, and a sealed `wrangler dev` run has no Access in
 *    front of it anyway.
 *  - Which vocabulary the "not signed in" screen SHOULD use. #84 pins only what
 *    it must not say; that negative is what is asserted.
 *
 * IDENTITY MECHANISM. As in the peer slices (`09-intake`, `12-access-auth`):
 * local `wrangler dev` has no Access in front of it, so the verified identity
 * is injected the way Access injects it in production, via
 * `Cf-Access-Authenticated-User-Email`.
 *
 * SYNTHETIC DATA. Per CLAUDE.md rule 1 and the contract's "Synthetic data"
 * section, every email and phrase below is invented.
 */

const ACCESS_HEADER = "Cf-Access-Authenticated-User-Email"

/** Contract: `identity-email` text = `signed in as {email}`. */
const signedInAs = (email: string) => `signed in as ${email}`

/** Contract: the customer-visible reference minted by the portal. */
const REFERENCE = /SUB-[A-Z0-9]{6}/

/**
 * The vocabulary #84 forbids on a page a customer can see. Every entry is
 * quoted from, or named by, the issue itself:
 *
 *   "No engineer-facing vocabulary: not 'coord-portal', not 'fleet', not 'the
 *    stack is wired', and no link to a health endpoint or a git repository on a
 *    page a customer can see."
 *
 * plus contract note 6, which makes any coord-side identifier absolute.
 */
const FORBIDDEN_COPY: Array<[RegExp, string]> = [
  [/coord[‑-]?portal/i, "the internal component name"],
  [/claude[‑–-]?coordinator/i, "the internal component name"],
  [/\bcoordinator fleet\b/i, "engineer vocabulary"],
  [/\bfleet\b/i, "engineer vocabulary"],
  [/nothing is built yet/i, "the day-one placeholder copy"],
  [/the stack is wired/i, "the day-one placeholder copy"],
  [/\/api\/health/i, "a health endpoint"],
  [/\bgithub\b/i, "a source repository"],
  [/\bwrangler\b/i, "engineer vocabulary"],
  [/\bcloudflare worker/i, "engineer vocabulary"],
  [/\bD1\b/, "engineer vocabulary"],
  [/\bR2\b/, "engineer vocabulary"],
]

/** Assert none of the forbidden vocabulary appears in a customer-visible text. */
function expectCustomerLanguage(text: string, where: string) {
  for (const [pattern, why] of FORBIDDEN_COPY) {
    expect(
      text,
      `${where} must not name ${why} (matched ${pattern}) — issue #84: ` +
        `"Nothing on any customer-visible page names an internal component, ` +
        `a health endpoint, or a repository."`,
    ).not.toMatch(pattern)
  }
}

/**
 * Assert no anchor on the page points at the health endpoint or a code host.
 * Checked as links as well as text, because an unlabelled or icon-only link
 * would slip past a text scan while still being exactly the thing #84 says to
 * remove ("Remove the *link*, not the endpoint").
 */
async function expectNoEngineerLinks(page: Page, where: string) {
  await expect(
    page.locator('a[href*="/api/health"]'),
    `${where} must not link the health endpoint`,
  ).toHaveCount(0)
  await expect(
    page.locator('a[href*="github.com"], a[href*="gitlab.com"]'),
    `${where} must not link a source repository`,
  ).toHaveCount(0)
}

function identity(tag: string): string {
  return `wren-${tag}@example.test`
}

async function asCustomer(
  browser: Browser,
  baseURL: string | undefined,
  email: string,
): Promise<BrowserContext> {
  return browser.newContext({
    baseURL,
    extraHTTPHeaders: { [ACCESS_HEADER]: email },
  })
}

async function asNobody(
  browser: Browser,
  baseURL: string | undefined,
): Promise<BrowserContext> {
  return browser.newContext({ baseURL })
}

/** Open the bare domain and return the page it settles on (redirect or not). */
async function openFrontDoor(context: BrowserContext): Promise<Page> {
  const page = await context.newPage()
  await page.goto("/")
  return page
}

/**
 * Create one submission through the pinned intake surface (#9) — the only way
 * this milestone lets a customer author a fact — and return its reference.
 *
 * NOTE for whoever inherits this slice: this helper depends on #9's intake
 * screen existing. That is unavoidable; #84's acceptance is literally "a
 * customer who signs in and goes to the bare domain reaches their submission",
 * and a submission has to come from somewhere. Only the "with submissions" test
 * uses it; the empty-state, placeholder-removal and vocabulary tests do not, so
 * they stay measurable while #9 is still open.
 */
async function createSubmission(context: BrowserContext): Promise<string> {
  const page = await context.newPage()
  await page.goto("/intake")
  await page
    .getByTestId("field-outcome")
    .fill("A one-page rota for the village hall key-holders.")
  await page.getByTestId("field-audience").fill("the hall booking volunteers")
  await page
    .getByTestId("field-done-definition")
    .fill("Every key-holder sees this week's slot without asking anyone.")
  await page.getByTestId("submit-intake").click()

  await expect(page.getByTestId("intake-receipt")).toBeVisible()
  const referenceText = await page.getByTestId("submission-reference").innerText()
  const match = referenceText.match(REFERENCE)
  expect(
    match,
    `intake receipt should carry a SUB-XXXXXX reference, got: ${referenceText}`,
  ).not.toBeNull()
  await page.close()
  return match![0]
}

/**
 * Follow the front door to the customer's submissions the way a customer would:
 * either it took them there itself, or there is something on the page to click.
 * Deliberately tolerant of BOTH shapes #84 allows.
 *
 * TODO(test-author): the contract pins `nav-dashboard` as a global header hook
 * but pins nothing about a front-door page, so this accepts the pinned nav hook
 * OR any anchor resolving to `/submissions`. If a worker adds a distinct
 * front-door `data-testid`, it should be pinned in the contract first.
 */
async function reachSubmissions(page: Page): Promise<void> {
  if (new URL(page.url()).pathname.startsWith("/submissions")) return

  const nav = page.getByTestId("nav-dashboard")
  const anchor = page.locator('a[href="/submissions"], a[href$="/submissions"]')
  const choices = (await nav.count()) > 0 ? nav : anchor
  expect(
    await choices.count(),
    "the bare domain must either take a signed-in customer to their " +
      "submissions or offer them a route there — issue #84: they must reach " +
      "their submission 'without knowing any URL'",
  ).toBeGreaterThan(0)

  await choices.first().click()
  await page.waitForURL(/\/submissions/)
}

test.describe("ms-1 issue 84 portal front door", () => {
  test("the bare domain no longer serves the day-one placeholder", async ({
    browser,
    baseURL,
  }) => {
    const email = identity("placeholder")
    const context = await asCustomer(browser, baseURL, email)
    const page = await openFrontDoor(context)

    // The exact strings the issue quotes from `public/index.html`. This is the
    // defect itself: "It is now the first thing a paying customer sees after
    // proving their identity, and it tells them the product does not exist."
    const text = await page.locator("body").innerText()
    expect(text, "the bare domain must not tell a customer the product does not exist")
      .not.toMatch(/nothing is built yet/i)
    expect(text).not.toMatch(/this page exists to prove the stack is wired/i)

    // Nor the engineer-facing status readout the placeholder carried.
    expectCustomerLanguage(text, "the bare domain")
    await expectNoEngineerLinks(page, "the bare domain")

    await page.close()
    await context.close()
  })

  test("a signed-in customer reaches their submission from the bare domain", async ({
    browser,
    baseURL,
  }) => {
    const email = identity("has-work")
    const context = await asCustomer(browser, baseURL, email)
    const reference = await createSubmission(context)

    // #84's acceptance, verbatim: "A customer who signs in and goes to the bare
    // domain reaches their submission without knowing any URL."
    const page = await openFrontDoor(context)
    await reachSubmissions(page)

    await expect(page.getByTestId("submission-list")).toBeVisible()
    const text = await page.locator("body").innerText()
    expect(
      text,
      "the customer's own submission must be reachable from the bare domain",
    ).toContain(reference)

    await page.close()
    await context.close()
  })

  test("a signed-in customer with no submissions is pointed at the intake form", async ({
    browser,
    baseURL,
  }) => {
    // A fresh identity that has never submitted anything. `serve:acceptance`
    // wipes the database per run, so "this customer has none" is stable.
    const email = identity("no-work")
    const context = await asCustomer(browser, baseURL, email)
    const page = await openFrontDoor(context)

    // #84 scope 2: "Signed in, with none → say so plainly and point at
    // `/intake`." The pointer is the assertable half.
    // TODO(test-author): neither the contract nor #84 pins the empty-state
    // WORDING ("say so plainly" is a quality bar, not a string), and no mock
    // renders a front door, so no copy is asserted here — only that the
    // customer is not left at a dead end. If the wording should be pinned, it
    // belongs in `contract.md` first.
    const nav = page.getByTestId("nav-new")
    const cta = page.getByTestId("nav-new-cta")
    const anchor = page.locator('a[href="/intake"], a[href$="/intake"]')
    const routes =
      (await nav.count()) > 0 ? nav : (await cta.count()) > 0 ? cta : anchor
    expect(
      await routes.count(),
      "a customer with no submissions must be pointed at /intake — issue #84: " +
        "arriving at the bare domain must not be 'a dead end that also insults " +
        "the work'",
    ).toBeGreaterThan(0)

    // And the pointer must actually go there.
    await routes.first().click()
    await page.waitForURL(/\/intake/)

    await page.close()
    await context.close()
  })

  test("the front door names the signed-in customer", async ({
    browser,
    baseURL,
  }) => {
    const email = identity("named")
    const context = await asCustomer(browser, baseURL, email)
    const page = await openFrontDoor(context)

    // Contract, pinned global hooks: `identity-email` (text `signed in as
    // {email}`) is "present in the header on every authenticated screen". Once
    // #84 lands, whatever `/` settles on for a signed-in customer IS an
    // authenticated screen — a redirect to `/submissions` satisfies this just as
    // a purpose-built landing page does.
    await expect(page.getByTestId("identity-email")).toHaveText(signedInAs(email))

    await page.close()
    await context.close()
  })

  test("the front door links no health endpoint and no repository", async ({
    browser,
    baseURL,
  }) => {
    const email = identity("no-links")
    const context = await asCustomer(browser, baseURL, email)
    const page = await openFrontDoor(context)

    // #84: "The only links on it are `/api/health` and the GitHub repository."
    // Both must go — as links. The endpoint itself is asserted alive by the
    // control test below.
    await expectNoEngineerLinks(page, "the front door")
    expectCustomerLanguage(await page.locator("body").innerText(), "the front door")

    await page.close()
    await context.close()
  })

  test("an anonymous visitor at the bare domain sees no engineer-facing page", async ({
    browser,
    baseURL,
  }) => {
    // #84 scope 3 ("Not signed in → what the site is and how to start, in the
    // customer's language") together with its constraint to "keep whatever the
    // static site does for genuinely unauthenticated visitors working".
    //
    // In production `/` sits behind the site Access app, so this state may be
    // unreachable there; under `serve:acceptance` there is no Access at all, so
    // an identity-less request is exactly what this harness can measure. Either
    // way the invariant is the same and is the only thing asserted: whatever is
    // served must not be the engineer-facing placeholder, and must not leak
    // another customer's material.
    //
    // TODO(test-author): #84 does not pin whether `/` should redirect an
    // anonymous visitor, render a marketing page, or refuse — and the contract
    // is silent too — so no status code and no copy are asserted, only the
    // negative.
    const context = await asNobody(browser, baseURL)
    const page = await openFrontDoor(context)

    const text = await page.locator("body").innerText()
    expectCustomerLanguage(text, "the bare domain seen by an anonymous visitor")
    await expectNoEngineerLinks(page, "the bare domain seen by an anonymous visitor")
    expect(
      text,
      "an anonymous visitor must not be shown any customer's submission",
    ).not.toMatch(REFERENCE)
    expect(text).not.toContain("@example.test")

    await page.close()
    await context.close()
  })

  test("the health endpoint stays reachable at its own path", async ({ request }) => {
    // CONTROL — expected GREEN today and after #84 lands. #84's first
    // constraint: "`/api/health` must stay reachable at its own path — it is an
    // Access Bypass application and monitoring depends on it. Remove the
    // *link*, not the endpoint." A worker who deletes the endpoint along with
    // the link fails here.
    const response = await request.get("/api/health", { failOnStatusCode: false })
    expect(response.status()).toBe(200)

    const body = await response.text()
    expect(body.length, "the health endpoint must still report something").toBeGreaterThan(0)
    // It is not a customer-visible page, so engineer vocabulary is fine here —
    // but it must not have become a data leak on the way.
    expect(body).not.toMatch(REFERENCE)
    expect(body).not.toContain("@example.test")
  })
})
