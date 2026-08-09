import { expect, test } from "@playwright/test"

/**
 * Black-box coverage for issue #9 (async intake), driving the real Worker
 * under `wrangler dev` — see `playwright.config.ts`. This is the project's own
 * `e2e/` tier, not the sealed acceptance suite under `tests/acceptance/`; per
 * CLAUDE.md this repo still ships its own coverage for behaviour-changing
 * work. Every string below is invented — see CLAUDE.md rule 1.
 */

test.use({
  extraHTTPHeaders: { "Cf-Access-Authenticated-User-Email": "e2e-customer@example.test" },
})

test("submitting the intake form creates a durable submission", async ({ page }) => {
  await page.goto("/intake")
  await expect(page.getByTestId("intake-form")).toBeVisible()

  await page.getByTestId("field-outcome").fill("A synthetic outcome for e2e coverage.")
  await page.getByTestId("field-audience").fill("synthetic test readers")
  await page.getByTestId("field-done-definition").fill("The e2e suite goes green.")
  await page.getByTestId("submit-intake").click()

  await expect(page.getByTestId("intake-receipt")).toBeVisible()
  await expect(page).toHaveURL(/\/submissions\/[^/?#]+$/)
  await expect(page.getByTestId("status-pill")).toHaveText("Describing")

  const reference = (await page.getByTestId("submission-reference").innerText()).trim()
  expect(reference).toMatch(/^Reference SUB-[A-Z0-9]{6}$/)

  // Durable: a fresh navigation to the same URL still shows the same record.
  const url = page.url()
  await page.goto(url)
  await expect(page.getByTestId("submission-reference")).toHaveText(reference)
})

test("the intake form's required fields block an empty submit", async ({ page }) => {
  await page.goto("/intake")
  await page.getByTestId("submit-intake").click()
  await expect(page).toHaveURL(/\/intake$/)
  await expect(page.getByTestId("intake-receipt")).toHaveCount(0)
})

test("visiting an unknown submission id 404s instead of fabricating a record", async ({
  page,
}) => {
  const response = await page.goto("/submissions/sub_does_not_exist")
  expect(response?.status()).toBe(404)
})
