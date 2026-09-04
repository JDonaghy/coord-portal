import { expect, test } from "@playwright/test"

/**
 * Black-box coverage for issue #12 ([portal] Auth — Cloudflare Access in
 * front of Pages + Worker), driving the real Worker under `wrangler dev` —
 * see `playwright.config.ts`. This is the project's own `e2e/` tier, not the
 * sealed acceptance suite under `tests/acceptance/`; per CLAUDE.md this repo
 * still ships its own coverage for behaviour-changing work.
 *
 * SCOPE. #12 puts Cloudflare Access in front of the portal so the Worker can
 * read a verified identity with no login code of its own, and requires that a
 * customer only ever sees their own submissions. Locally there is no Access in
 * front of `wrangler dev`, so — same position `e2e/intake.spec.ts` already
 * takes — the verified identity is supplied the way Access injects it in
 * production: `Cf-Access-Authenticated-User-Email`.
 *
 * Every string below is invented — see CLAUDE.md rule 1.
 */

const ACCESS_HEADER = "Cf-Access-Authenticated-User-Email"

/**
 * `serve:test` (unlike `serve:acceptance`) does not wipe `.wrangler/state`
 * between runs — see the "WRITTEN FOR A SHARED, CONCURRENT DATABASE" note in
 * `e2e/bridge.spec.ts`. A static synthetic email would accumulate rows across
 * repeated local runs and break a `toHaveCount` assertion that isn't scoped to
 * a single test's own data, so every identity here is tagged unique per run.
 */
function uniqueEmail(local: string): string {
  const tag = Math.random().toString(36).slice(2, 10)
  return `${local}-${tag}@example.test`
}

async function createSubmission(page: import("@playwright/test").Page, nonce: string) {
  await page.goto("/intake")
  await page.getByTestId("field-outcome").fill(`A synthetic outcome for e2e access coverage (${nonce}).`)
  await page.getByTestId("field-audience").fill("synthetic e2e readers")
  await page.getByTestId("field-done-definition").fill("The e2e access suite goes green.")
  await page.getByTestId("submit-intake").click()
  await expect(page.getByTestId("intake-receipt")).toBeVisible()
  const reference = (await page.getByTestId("submission-reference").innerText()).replace(
    /^Reference\s+/,
    "",
  )
  return { url: page.url(), reference }
}

test("the dashboard lists only the signed-in customer's own submissions", async ({ browser, baseURL }) => {
  const ada = uniqueEmail("ada-e2e-access")
  const bo = uniqueEmail("bo-e2e-access")

  const adaContext = await browser.newContext({
    baseURL,
    extraHTTPHeaders: { [ACCESS_HEADER]: ada },
  })
  const boContext = await browser.newContext({
    baseURL,
    extraHTTPHeaders: { [ACCESS_HEADER]: bo },
  })

  const adaPage = await adaContext.newPage()
  const adaSubmission = await createSubmission(adaPage, "ADA-E2E-1")

  const boPage = await boContext.newPage()
  await createSubmission(boPage, "BO-E2E-1")

  await boPage.goto("/submissions")
  await expect(boPage.getByTestId("identity-email")).toHaveText(`signed in as ${bo}`)
  await expect(boPage.getByTestId("submission-row")).toHaveCount(1)
  const boText = await boPage.locator("body").innerText()
  expect(boText).not.toContain(adaSubmission.reference)

  await adaContext.close()
  await boContext.close()
})

test("a customer cannot open another customer's submission or round history by URL", async ({
  browser,
  baseURL,
}) => {
  const ada = uniqueEmail("ada-e2e-detail")
  const bo = uniqueEmail("bo-e2e-detail")

  const adaContext = await browser.newContext({
    baseURL,
    extraHTTPHeaders: { [ACCESS_HEADER]: ada },
  })
  const boContext = await browser.newContext({
    baseURL,
    extraHTTPHeaders: { [ACCESS_HEADER]: bo },
  })

  const adaPage = await adaContext.newPage()
  const adaSubmission = await createSubmission(adaPage, "ADA-E2E-2")

  const boPage = await boContext.newPage()
  const detailResponse = await boPage.goto(adaSubmission.url)
  expect(detailResponse?.status()).toBe(404)

  const roundsResponse = await boPage.goto(`${adaSubmission.url}/rounds`)
  expect(roundsResponse?.status()).toBe(404)

  // The owner's own read of both routes still works.
  const ownDetail = await adaPage.goto(adaSubmission.url)
  expect(ownDetail?.status()).toBe(200)
  const ownRounds = await adaPage.goto(`${adaSubmission.url}/rounds`)
  expect(ownRounds?.status()).toBe(200)
  await expect(adaPage.getByTestId("identity-email")).toHaveText(`signed in as ${ada}`)

  await adaContext.close()
  await boContext.close()
})

/**
 * Issue #306: the not-found copy used to offer two causes ("submitted
 * somewhere else" or "the link is wrong") and neither is true for the
 * likeliest real one — the reader is signed in as a different address than
 * the submission belongs to. The fix names the caller's own signed-in
 * address (or the lack of one) without touching `isOwnedBy`, the status
 * code, or whether the response varies by whether the id is real.
 */
test("a non-owner is told which address they're signed in as, and to try the address the request was sent to", async ({
  browser,
  baseURL,
}) => {
  const ada = uniqueEmail("ada-e2e-notfound-owner")
  const bo = uniqueEmail("bo-e2e-notfound-nonowner")

  const adaContext = await browser.newContext({
    baseURL,
    extraHTTPHeaders: { [ACCESS_HEADER]: ada },
  })
  const boContext = await browser.newContext({
    baseURL,
    extraHTTPHeaders: { [ACCESS_HEADER]: bo },
  })

  const adaPage = await adaContext.newPage()
  const adaSubmission = await createSubmission(adaPage, "ADA-E2E-NOTFOUND")
  await adaContext.close()

  const boPage = await boContext.newPage()
  const response = await boPage.goto(adaSubmission.url)
  expect(response?.status()).toBe(404) // never a 403 — knowing the URL is still not authorisation

  const body = await boPage.locator("body").innerText()
  expect(body).toContain("We can't find that request")
  expect(body).toContain(bo) // names Bo's own signed-in address
  expect(body).not.toContain(ada) // never Ada's — that would confirm whose submission it is
  expect(body.toLowerCase()).toContain("sign in with that")

  await boContext.close()
})

test("an unauthenticated visitor is not told the link is wrong, and is not named as signed in", async ({
  browser,
  baseURL,
}) => {
  const ada = uniqueEmail("ada-e2e-notfound-anon")
  const adaContext = await browser.newContext({
    baseURL,
    extraHTTPHeaders: { [ACCESS_HEADER]: ada },
  })
  const adaPage = await adaContext.newPage()
  const adaSubmission = await createSubmission(adaPage, "ADA-E2E-NOTFOUND-ANON")
  await adaContext.close()

  const nobody = await browser.newContext({ baseURL })
  const nobodyPage = await nobody.newPage()
  const response = await nobodyPage.goto(adaSubmission.url)
  expect(response?.status()).toBe(404)

  const body = await nobodyPage.locator("body").innerText()
  expect(body).toContain("We can't find that request")
  // The old copy stated flatly "the link is wrong"; the new copy only offers
  // that as one of several possibilities, never the stated cause.
  expect(body).not.toContain("the link is wrong")
  expect(body).not.toContain("signed in as")
  expect(body.toLowerCase()).toContain("not signed in")

  await nobody.close()
})

test("a non-existent submission and someone else's real submission render byte-identical 404s for the same caller", async ({
  browser,
  baseURL,
  request,
}) => {
  const ada = uniqueEmail("ada-e2e-notfound-real")
  const adaContext = await browser.newContext({
    baseURL,
    extraHTTPHeaders: { [ACCESS_HEADER]: ada },
  })
  const adaPage = await adaContext.newPage()
  const adaSubmission = await createSubmission(adaPage, "ADA-E2E-NOTFOUND-REAL")
  await adaContext.close()

  const bo = uniqueEmail("bo-e2e-notfound-real")
  const boHeaders = { [ACCESS_HEADER]: bo }

  const realButNotOwned = await request.get(adaSubmission.url, { headers: boHeaders })
  const neverExisted = await request.get("/submissions/sub_does_not_exist", { headers: boHeaders })
  expect(realButNotOwned.status()).toBe(404)
  expect(neverExisted.status()).toBe(404)
  expect(await realButNotOwned.text()).toBe(await neverExisted.text())

  // Same property, unauthenticated.
  const realAnon = await request.get(adaSubmission.url)
  const neverExistedAnon = await request.get("/submissions/sub_does_not_exist")
  expect(realAnon.status()).toBe(404)
  expect(neverExistedAnon.status()).toBe(404)
  expect(await realAnon.text()).toBe(await neverExistedAnon.text())
})

/**
 * Issue #46: `request.formData()` throws a raw `TypeError` — an unhandled
 * 500 — when a POST carries no `Content-Type` at all (a bot, a broken
 * client, a redirect replayed as a bare POST). That is a malformed request,
 * not a server error, and per the fix it has to render the same house-style
 * 404 the non-owner refusal just above renders — same status, same shape,
 * never a 5xx that would tell a prober "the id exists, the body was just
 * wrong."
 *
 * Before issue #306 this was a byte-for-byte comparison. #306 makes the 404
 * page name the caller's own signed-in address, so Ada's malformed POST (her
 * own submission) and Bo's ownership refusal (also Ada's submission) now
 * differ in exactly that one line — each names its own caller, never
 * anything about the submission. What still has to hold, and is asserted
 * below, is that both are the same 404 template and neither leaks the
 * *other* caller's identity.
 */
test("a POST with no Content-Type gets the same 404 shape a non-owner gets, never a 500", async ({
  browser,
  baseURL,
  request,
}) => {
  const ada = uniqueEmail("ada-e2e-ct")
  const adaContext = await browser.newContext({
    baseURL,
    extraHTTPHeaders: { [ACCESS_HEADER]: ada },
  })
  const adaPage = await adaContext.newPage()
  const adaSubmission = await createSubmission(adaPage, "ADA-E2E-CT")
  await adaContext.close()

  // The owner themself, but with a bodyless / content-type-less POST — the
  // exact repro from the issue.
  const ownerResponse = await request.post(adaSubmission.url, {
    headers: { [ACCESS_HEADER]: ada },
  })
  expect(ownerResponse.status()).toBe(404)

  // A stranger posting the same way gets the same house-style refusal — no
  // oracle that distinguishes "your body was wrong" from "not your id".
  const bo = uniqueEmail("bo-e2e-ct")
  const strangerResponse = await request.post(adaSubmission.url, {
    headers: { [ACCESS_HEADER]: bo },
  })
  expect(strangerResponse.status()).toBe(404)

  const [ownerBody, strangerBody] = await Promise.all([
    ownerResponse.text(),
    strangerResponse.text(),
  ])
  expect(ownerBody).toContain("We can't find that request")
  expect(strangerBody).toContain("We can't find that request")
  // Each names only its own caller (issue #306) — never the other one's.
  expect(ownerBody).toContain(ada)
  expect(ownerBody).not.toContain(bo)
  expect(strangerBody).toContain(bo)
  expect(strangerBody).not.toContain(ada)
})

/**
 * Issue #46 follow-up: a `Content-Type: multipart/form-data` header with no
 * (or a malformed) `boundary=` passes the cheap prefix pre-check but still
 * throws inside `request.formData()` itself. Only the real owner can reach
 * this — the ownership check runs first — but it is the same "never a 5xx"
 * bar the issue sets, so it still has to come back as the house-style 404,
 * not a 500.
 */
test("a POST with a malformed multipart boundary gets a 404, never a 500", async ({
  browser,
  baseURL,
  request,
}) => {
  const ada = uniqueEmail("ada-e2e-boundary")
  const adaContext = await browser.newContext({
    baseURL,
    extraHTTPHeaders: { [ACCESS_HEADER]: ada },
  })
  const adaPage = await adaContext.newPage()
  const adaSubmission = await createSubmission(adaPage, "ADA-E2E-BOUNDARY")
  await adaContext.close()

  const response = await request.post(adaSubmission.url, {
    headers: {
      [ACCESS_HEADER]: ada,
      "content-type": "multipart/form-data",
    },
    data: "this is not valid multipart data",
  })
  expect(response.status()).toBe(404)
})

test("an identity-less request to /submissions or a submission URL gets no customer data", async ({
  browser,
  baseURL,
}) => {
  const ada = uniqueEmail("ada-e2e-anon")
  const adaContext = await browser.newContext({
    baseURL,
    extraHTTPHeaders: { [ACCESS_HEADER]: ada },
  })
  const adaPage = await adaContext.newPage()
  const adaSubmission = await createSubmission(adaPage, "ADA-E2E-3")
  await adaContext.close()

  const nobody = await browser.newContext({ baseURL })
  const nobodyPage = await nobody.newPage()

  const dashboardResponse = await nobodyPage.goto("/submissions")
  expect(dashboardResponse?.status()).toBe(200)
  const dashboardText = await nobodyPage.locator("body").innerText()
  expect(dashboardText).not.toContain(adaSubmission.reference)

  const detailResponse = await nobodyPage.goto(adaSubmission.url)
  expect(detailResponse?.status()).toBe(404)

  await nobody.close()
})

test("the portal renders no login, password or signup affordance", async ({ page }) => {
  await page.goto("/intake", {
    // No Access header at all — the front door with nobody signed in yet.
  })
  await expect(page.locator('input[type="password"]')).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: /log ?in|sign ?in|sign ?up/i }),
  ).toHaveCount(0)
  await expect(
    page.locator('a[href*="/login"], a[href*="/signin"], a[href*="/sign-in"]'),
  ).toHaveCount(0)
})
