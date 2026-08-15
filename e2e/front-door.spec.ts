import { expect, test, type Page } from "@playwright/test"

/**
 * Black-box coverage for issue #84 ([portal] the bare domain is still the
 * day-one placeholder), driving the real Worker under `wrangler dev` — see
 * `playwright.config.ts`. This is the project's own `e2e/` tier, not the
 * sealed acceptance suite under `tests/acceptance/`; per CLAUDE.md this repo
 * still ships its own coverage for behaviour-changing work. The sealed slice
 * (`tests/acceptance/ms-1/84-front-door.spec.ts`) is the acceptance bar —
 * this file exists so a regression here shows up on every run, not only when
 * the acceptance suite is invoked.
 *
 * Every identity and string below is invented — see CLAUDE.md rule 1.
 */

const ACCESS_HEADER = "Cf-Access-Authenticated-User-Email"

/**
 * `serve:test` does not wipe `.wrangler/state` between runs (see the note in
 * `e2e/access.spec.ts`), so every identity here is tagged unique per run —
 * otherwise "this customer has no submissions" would flake once the suite
 * has run more than once locally.
 */
function uniqueEmail(local: string): string {
  const tag = Math.random().toString(36).slice(2, 10)
  return `${local}-${tag}@example.test`
}

async function createSubmission(page: Page, nonce: string): Promise<void> {
  await page.goto("/intake")
  await page.getByTestId("field-outcome").fill(`A synthetic outcome for e2e front-door coverage (${nonce}).`)
  await page.getByTestId("field-audience").fill("synthetic e2e readers")
  await page.getByTestId("field-done-definition").fill("The e2e front-door suite goes green.")
  await page.getByTestId("submit-intake").click()
  await expect(page.getByTestId("intake-receipt")).toBeVisible()
}

test("a signed-in customer with no submissions is named and pointed at /intake", async ({
  browser,
  baseURL,
}) => {
  const email = uniqueEmail("no-submissions")
  const context = await browser.newContext({ baseURL, extraHTTPHeaders: { [ACCESS_HEADER]: email } })
  const page = await context.newPage()

  await page.goto("/")

  await expect(page.getByTestId("identity-email")).toHaveText(`signed in as ${email}`)
  await page.getByTestId("nav-new-cta").click()
  await expect(page).toHaveURL(/\/intake$/)

  await context.close()
})

test("a signed-in customer with a submission reaches it from the bare domain", async ({
  browser,
  baseURL,
}) => {
  const email = uniqueEmail("has-submission")
  const context = await browser.newContext({ baseURL, extraHTTPHeaders: { [ACCESS_HEADER]: email } })
  const page = await context.newPage()

  await createSubmission(page, email)

  await page.goto("/")
  await expect(page).toHaveURL(/\/submissions$/)
  await expect(page.getByTestId("submission-list")).toBeVisible()

  await context.close()
})

test("an anonymous visitor sees a customer-language front door, not the engineer placeholder", async ({
  page,
}) => {
  await page.goto("/")

  await expect(page.getByRole("heading", { name: "coord-portal" })).toHaveCount(0)
  await expect(page.locator("body")).not.toContainText(/nothing is built yet/i)
  await expect(page.locator("a[href='/api/health']")).toHaveCount(0)
  await expect(page.locator("a[href*='github.com']")).toHaveCount(0)

  await expect(page.getByTestId("front-door-start")).toHaveAttribute("href", "/start")
})

test("the health endpoint stays reachable at its own path", async ({ request }) => {
  const response = await request.get("/api/health")
  expect(response.status()).toBe(200)
})
