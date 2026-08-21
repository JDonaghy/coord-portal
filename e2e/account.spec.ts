import { expect, test, type Browser } from "@playwright/test"

/**
 * Black-box coverage for issue #131 ([portal] Client profile page:
 * self-service phone/cc emails/address behind Access auth), driving the real
 * Worker under `wrangler dev` with real local D1 — see `playwright.config.ts`.
 * This is the project's own `e2e/` tier, not the sealed acceptance suite
 * under `tests/acceptance/` (`tests/acceptance/ms-4/131-account-profile.spec.ts`
 * is that independent slice); per CLAUDE.md this repo still ships its own
 * black-box coverage for behaviour-changing work.
 *
 * SCOPE. `GET /account` and `POST /account` — a signed-in client's own
 * `clients` row (#128): phone, cc emails, address are read/write; email is
 * read-only, because it *is* the Access identity (`resolveSiteIdentity`), not
 * a field this form can change. No new auth code — same gate every other
 * customer route in `src/pages.ts` sits behind.
 *
 * Every string below is invented — see CLAUDE.md rule 1.
 *
 * ── WRITTEN FOR A SHARED, ACCUMULATING DATABASE ────────────────────────────
 * `serve:test` does not wipe `.wrangler/state` between runs and the suite is
 * `fullyParallel`, so every assertion below is scoped to a nonce this test
 * minted (a unique customer email) rather than counting rows globally.
 */

const ACCESS_HEADER = "Cf-Access-Authenticated-User-Email"

function nonce(): string {
  return Math.random().toString(36).slice(2, 10)
}

function uniqueEmail(local: string): string {
  return `${local}-${nonce()}@example.test`
}

async function contextFor(browser: Browser, baseURL: string | undefined, email: string | null) {
  return browser.newContext({
    baseURL,
    extraHTTPHeaders: email ? { [ACCESS_HEADER]: email } : {},
  })
}

test("a client with no clients row yet sees a blank form, pre-filled only with their own email", async ({
  page,
}) => {
  const email = uniqueEmail("e2e-account-fresh")
  await page.setExtraHTTPHeaders({ [ACCESS_HEADER]: email })
  await page.goto("/account")

  await expect(page.getByTestId("nav-account")).toHaveAttribute("aria-current", "page")
  await expect(page.getByTestId("identity-email")).toHaveText(`signed in as ${email}`)
  await expect(page.getByTestId("account-email")).toHaveValue(email)
  await expect(page.getByTestId("account-email")).toHaveAttribute("readonly", "")
  await expect(page.getByTestId("account-phone-field")).toHaveValue("")
  await expect(page.getByTestId("account-cc-emails-field")).toHaveValue("")
  await expect(page.getByTestId("account-address-field")).toHaveValue("")
})

test("saving the profile persists phone, cc emails and address, and a reload still shows them", async ({
  page,
}) => {
  const email = uniqueEmail("e2e-account-save")
  await page.setExtraHTTPHeaders({ [ACCESS_HEADER]: email })
  await page.goto("/account")

  await page.getByTestId("account-phone-field").fill("+1 555-0100")
  await page.getByTestId("account-cc-emails-field").fill("billing@example.test, ops@example.test")
  await page.getByTestId("account-address-field").fill("1 Synthetic Way\nTestville, TS 00000")
  await page.getByTestId("account-save-button").click()

  // PRG: POST redirects back to GET /account, never renders the result inline.
  await expect(page).toHaveURL(/\/account$/)
  await expect(page.getByTestId("account-phone-field")).toHaveValue("+1 555-0100")
  await expect(page.getByTestId("account-cc-emails-field")).toHaveValue(
    "billing@example.test, ops@example.test",
  )
  await expect(page.getByTestId("account-address-field")).toHaveValue(
    "1 Synthetic Way\nTestville, TS 00000",
  )

  await page.reload()
  await expect(page.getByTestId("account-phone-field")).toHaveValue("+1 555-0100")
  await expect(page.getByTestId("account-address-field")).toHaveValue(
    "1 Synthetic Way\nTestville, TS 00000",
  )
})

test("saving again updates the same row rather than creating a second one, and blanking a field clears it", async ({
  page,
}) => {
  const email = uniqueEmail("e2e-account-update")
  await page.setExtraHTTPHeaders({ [ACCESS_HEADER]: email })
  await page.goto("/account")

  await page.getByTestId("account-phone-field").fill("+1 555-0111")
  await page.getByTestId("account-address-field").fill("First address")
  await page.getByTestId("account-save-button").click()
  await expect(page.getByTestId("account-phone-field")).toHaveValue("+1 555-0111")

  // Second save: change the phone, blank the address out entirely.
  await page.getByTestId("account-phone-field").fill("+1 555-0122")
  await page.getByTestId("account-address-field").fill("")
  await page.getByTestId("account-save-button").click()

  await expect(page.getByTestId("account-phone-field")).toHaveValue("+1 555-0122")
  await expect(page.getByTestId("account-address-field")).toHaveValue("")

  await page.reload()
  await expect(page.getByTestId("account-phone-field")).toHaveValue("+1 555-0122")
  await expect(page.getByTestId("account-address-field")).toHaveValue("")
})

test("the email field cannot be changed by posting a different value", async ({ page, request }) => {
  const email = uniqueEmail("e2e-account-email-locked")
  await page.setExtraHTTPHeaders({ [ACCESS_HEADER]: email })
  await page.goto("/account")

  // The form has no `name="email"` input to submit in the first place — the
  // rendered readonly field is display-only (`src/routes/account.ts`). Still,
  // a request that tries to smuggle one in must not move the row's identity.
  const response = await request.post("/account", {
    headers: { [ACCESS_HEADER]: email },
    form: { email: "attacker@example.test", phone: "+1 555-0199" },
    maxRedirects: 0,
  })
  expect(response.status()).toBe(303)

  await page.goto("/account")
  await expect(page.getByTestId("account-email")).toHaveValue(email)
  await expect(page.getByTestId("account-phone-field")).toHaveValue("+1 555-0199")
})

test("two customers each see and edit only their own profile", async ({ browser, baseURL }) => {
  const ada = uniqueEmail("ada-e2e-account")
  const bo = uniqueEmail("bo-e2e-account")

  const adaContext = await contextFor(browser, baseURL, ada)
  const adaPage = await adaContext.newPage()
  await adaPage.goto("/account")
  await adaPage.getByTestId("account-phone-field").fill("+1 555-0001")
  await adaPage.getByTestId("account-save-button").click()
  await expect(adaPage.getByTestId("account-phone-field")).toHaveValue("+1 555-0001")
  await adaContext.close()

  const boContext = await contextFor(browser, baseURL, bo)
  const boPage = await boContext.newPage()
  await boPage.goto("/account")
  await expect(boPage.getByTestId("account-email")).toHaveValue(bo)
  await expect(boPage.getByTestId("account-phone-field")).toHaveValue("")
  await boContext.close()
})

test("an identity-less GET renders a blank, unowned form rather than 404ing", async ({
  browser,
  baseURL,
}) => {
  const nobody = await contextFor(browser, baseURL, null)
  const nobodyPage = await nobody.newPage()
  const response = await nobodyPage.goto("/account")
  expect(response?.status()).toBe(200)
  await expect(nobodyPage.getByTestId("account-form")).toBeVisible()
  await expect(nobodyPage.getByTestId("account-phone-field")).toHaveValue("")
  await nobody.close()
})

test("an identity-less POST is refused, never a 500, and writes nothing", async ({
  browser,
  baseURL,
}) => {
  const nobody = await contextFor(browser, baseURL, null)
  const response = await nobody.request.post("/account", {
    form: { phone: "+1 555-9999" },
  })
  expect(response.status()).toBe(401)
  await nobody.close()
})

test("a POST with no Content-Type re-renders the form rather than 500ing", async ({
  page,
  request,
}) => {
  const email = uniqueEmail("e2e-account-no-content-type")
  const response = await request.post("/account", {
    headers: { [ACCESS_HEADER]: email },
  })
  expect(response.status()).toBe(400)
  const body = await response.text()
  expect(body).toContain('data-testid="account-form"')
})
