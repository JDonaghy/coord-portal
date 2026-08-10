import { expect, test } from "@playwright/test"

/**
 * Black-box coverage for issue #31 ([portal] Public lead form — first contact
 * with no account), driving the real Worker under `wrangler dev` — see
 * `playwright.config.ts`. This is the project's own `e2e/` tier, not the
 * sealed acceptance suite under `tests/acceptance/`; per CLAUDE.md this repo
 * still ships its own coverage for behaviour-changing work. The sealed slice
 * (`tests/acceptance/ms-2/31-public-lead-form.spec.ts`) is the acceptance bar
 * for this issue — this file is a lighter smoke pass over the same route.
 *
 * Every string below is invented — see CLAUDE.md rule 1.
 */

const ACCESS_HEADER = "Cf-Access-Authenticated-User-Email"

/**
 * `serve:test` does not wipe `.wrangler/state` between runs (unlike
 * `serve:acceptance`) — see the note in `e2e/access.spec.ts`. Tag every
 * synthetic lead uniquely so repeated local runs never collide.
 */
function uniqueEmail(local: string): string {
  const tag = Math.random().toString(36).slice(2, 10)
  return `${local}-${tag}@example.test`
}

test("GET /start renders the public form to a stranger with no Access identity", async ({
  page,
}) => {
  const response = await page.goto("/start")
  expect(response?.status()).toBe(200)
  await expect(page.getByTestId("lead-form")).toBeVisible()
  await expect(page.getByTestId("brand-home")).toBeVisible()

  // No login, password or signup affordance — same rule #12 pins for /intake.
  await expect(page.locator('input[type="password"]')).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: /log ?in|sign ?in|sign ?up|register/i }),
  ).toHaveCount(0)

  // No authenticated-portal hooks leak onto a public screen.
  for (const hook of ["nav-dashboard", "nav-new", "identity-email", "submission-list"]) {
    await expect(page.getByTestId(hook)).toHaveCount(0)
  }
})

test("submitting the form records a lead and shows a receipt with a reference", async ({
  page,
}) => {
  const email = uniqueEmail("priya-e2e-start")

  await page.goto("/start")
  await page.getByTestId("field-lead-summary").fill("A synthetic request for e2e coverage.")
  await page.getByTestId("field-lead-email").fill(email)
  await page.getByTestId("submit-lead").click()

  // Rendered directly at 200 — no redirect, no /start/:id.
  await expect(page).toHaveURL(/\/start$/)
  await expect(page.getByTestId("lead-receipt")).toBeVisible()

  const reference = (await page.getByTestId("lead-reference").innerText()).trim()
  expect(reference).toMatch(/^Reference LEAD-[A-Z0-9]{6}$/)
  await expect(page.getByTestId("back-home")).toHaveAttribute("href", "/")
})

test("an incomplete submission is rejected and creates no lead", async ({ page, request }) => {
  await page.goto("/start")
  await page.getByTestId("submit-lead").click()
  // Blocked client-side by the `required` attributes — still on /start, no receipt.
  await expect(page).toHaveURL(/\/start$/)
  await expect(page.getByTestId("lead-receipt")).toHaveCount(0)

  // The server re-checks too, and never relies on the browser alone.
  const response = await request.post("/start", {
    form: { summary: "Only a summary, no email." },
    maxRedirects: 0,
    failOnStatusCode: false,
  })
  expect(response.status()).toBe(400)
  const body = await response.text()
  expect(body).toContain('data-testid="lead-form"')
  expect(body).not.toMatch(/LEAD-[A-Z0-9]{6}/)
})

test("a lead is inert — it never shows up as a submission for its own email", async ({
  browser,
  baseURL,
}) => {
  const email = uniqueEmail("priya-e2e-inert")

  const anon = await browser.newContext({ baseURL })
  const anonPage = await anon.newPage()
  await anonPage.goto("/start")
  await anonPage.getByTestId("field-lead-summary").fill("A synthetic inert-lead request.")
  await anonPage.getByTestId("field-lead-email").fill(email)
  await anonPage.getByTestId("submit-lead").click()
  await expect(anonPage.getByTestId("lead-receipt")).toBeVisible()
  await anon.close()

  const asLead = await browser.newContext({
    baseURL,
    extraHTTPHeaders: { [ACCESS_HEADER]: email },
  })
  const dashboardPage = await asLead.newPage()
  await dashboardPage.goto("/submissions")
  await expect(dashboardPage.getByTestId("submission-row")).toHaveCount(0)
  await asLead.close()
})

test("an Access identity on the request changes nothing about the public route", async ({
  browser,
  baseURL,
}) => {
  const signedIn = await browser.newContext({
    baseURL,
    extraHTTPHeaders: { [ACCESS_HEADER]: uniqueEmail("bo-e2e-start-identity") },
  })
  const signedInPage = await signedIn.newPage()
  const response = await signedInPage.goto("/start")
  expect(response?.status()).toBe(200)
  await expect(signedInPage.getByTestId("lead-form")).toBeVisible()
  await expect(signedInPage.getByTestId("identity-email")).toHaveCount(0)
  await signedIn.close()
})
