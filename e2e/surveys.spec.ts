import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test"

/**
 * Black-box coverage for issue #329 ([portal] Operator view for customer
 * survey responses), driving the real Worker under `wrangler dev` with real
 * local D1 — see `playwright.config.ts`. This is the project's own `e2e/`
 * tier, not the sealed acceptance suite under `tests/acceptance/`; per
 * CLAUDE.md this repo still ships its own black-box coverage for
 * behaviour-changing work, and `GET /surveys` (`src/routes/surveys.ts`, wired
 * in `src/pages.ts`) had none before this file.
 *
 * WHAT THIS FILE PROVES, the same shape `e2e/deliveries.spec.ts` and
 * `e2e/requests.spec.ts` already prove for their own operator-only lists:
 *
 *   UNSCOPED   `GET /surveys` lists every customer's survey response on one
 *              screen, newest first, with the project/client it belongs to.
 *   GATED      the exact same indistinguishable 404 every other operator-only
 *              route on this surface returns for anyone `readOperator`
 *              rejects — an ordinary customer, or nobody at all.
 *   READ-ONLY  no edit, delete or reply control anywhere on the screen —
 *              #329's own rule that a reply to a customer is an email, sent
 *              through the existing outbound path, never from here.
 *   LINKED     each row's title (and its own "Open" link) lead to
 *              `/requests/:id` — the operator-scoped submission view — not to
 *              `/submissions/:id`, which 404s an operator by construction.
 *
 * The companion half of #329 — the rating badge on `/requests`' own row,
 * including the "Not answered" case this file's list structurally cannot
 * show (a submission with no response has no row in `submission_surveys` to
 * join against) — is covered in `e2e/requests.spec.ts`, not here.
 *
 * Every address and string below is invented — CLAUDE.md rule 1.
 * `serve:test` does not wipe `.wrangler/state` between runs, so identities
 * and comments are tagged unique per run rather than risking a row a
 * previous run left behind.
 */

const DEV_OPERATOR = "ops@example.test"

const SERVICE_TOKEN = {
  "CF-Access-Client-Id": "b58e2f4a07c1d963815d0e964d8f27a5.access",
  "CF-Access-Client-Secret":
    "3b8c6da502e7396fb24f1be962c5a8740c9de5b3d1f087a9c6bf85293f7420b",
}

function uniqueEmail(local: string): string {
  const tag = Math.random().toString(36).slice(2, 10)
  return `${local}-${tag}@example.test`
}

async function contextFor(browser: Browser, baseURL: string | undefined, email: string | null) {
  return browser.newContext({
    baseURL,
    extraHTTPHeaders: email ? { "Cf-Access-Authenticated-User-Email": email } : {},
  })
}

interface Seeded {
  reference: string
  url: string
}

async function seedSubmission(page: Page, email: string, tag: string): Promise<Seeded> {
  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": email })
  await page.goto("/intake")
  await page.getByTestId("field-outcome").fill(`A synthetic outcome for e2e surveys coverage (${tag}).`)
  await page.getByTestId("field-audience").fill("synthetic e2e readers")
  await page.getByTestId("field-done-definition").fill("The surveys e2e suite goes green.")
  await page.getByTestId("submit-intake").click()
  await expect(page.getByTestId("intake-receipt")).toBeVisible()

  const reference = (await page.getByTestId("submission-reference").innerText())
    .trim()
    .replace(/^Reference\s+/, "")
  return { reference, url: page.url() }
}

async function push(
  request: APIRequestContext,
  reference: string,
  revision: number,
  fields: Record<string, unknown>,
): Promise<{ outcome: string }> {
  const res = await request.post("/api/bridge/push", {
    data: { updates: [{ submission_id: reference, revision, fields }] },
    headers: SERVICE_TOKEN,
  })
  expect(res.status()).toBe(200)
  const body = (await res.json()) as { results: Array<{ outcome: string }> }
  const result = body.results[0]
  if (!result) throw new Error("push produced no result")
  return result
}

async function shipIt(request: APIRequestContext, reference: string, revision = 1): Promise<void> {
  const result = await push(request, reference, revision, { status: "shipped" })
  expect(result.outcome).toBe("applied")
}

async function answerSurvey(
  page: Page,
  submissionUrl: string,
  rating: number,
  comment?: string,
): Promise<void> {
  await page.goto(submissionUrl)
  await page.getByTestId("survey-open-button").click()
  await page.locator(`[data-testid="survey-rating-option"][data-value="${rating}"] input`).check()
  if (comment) await page.getByTestId("survey-comment").fill(comment)
  await page.getByTestId("survey-submit").click()
  await expect(page.getByTestId("survey-response")).toHaveAttribute("data-rating", String(rating))
}

test("the operator's /surveys lists a response with its rating, project/client, date and comment, linking back to the request", async ({
  browser,
  baseURL,
}) => {
  const email = uniqueEmail("e2e-surveys-basic")
  const context = await contextFor(browser, baseURL, email)
  const page = await context.newPage()
  const seeded = await seedSubmission(page, email, "basic")

  await shipIt(context.request, seeded.reference)
  const comment = `A synthetic comment for e2e surveys coverage, basic case (${Math.random().toString(36).slice(2, 8)}).`
  await answerSurvey(page, seeded.url, 4, comment)

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()

  await operator.goto("/surveys")
  await expect(operator.getByTestId("identity-email")).toHaveText(`signed in as ${DEV_OPERATOR}`)
  await expect(operator.getByTestId("nav-surveys")).toHaveAttribute("aria-current", "page")

  const row = operator.getByTestId("response-row").filter({ hasText: comment })
  await expect(row, `exactly one response-row carrying ${comment}`).toHaveCount(1)
  await expect(row).toHaveAttribute("data-rating", "4")
  await expect(row.getByTestId("response-rating")).toHaveText("4 stars — Happy")
  await expect(row.getByTestId("response-customer")).toHaveText(email)
  await expect(row.getByTestId("response-comment")).toHaveText(comment)
  // No project name was ever set on this submission, so the row falls back
  // to the same `titleFromOutcome` derivation `/requests` itself uses.
  await expect(row.getByTestId("response-title")).toHaveText(
    `A synthetic outcome for e2e surveys coverage (basic).`,
  )

  // Both the title and the "Open" link lead to the operator-scoped submission
  // view, `/requests/:id` — never `/submissions/:id`, which 404s an operator.
  const titleHref = await row.getByTestId("response-title").getAttribute("href")
  const openHref = await row.getByTestId("response-open-link").getAttribute("href")
  expect(titleHref).toMatch(/^\/requests\/[^/]+$/)
  expect(openHref).toBe(titleHref)

  await operator.goto(titleHref!)
  await expect(operator.getByTestId("request-detail")).toBeVisible()
  await expect(operator.getByTestId("request-detail-reference")).toHaveText(seeded.reference)

  await Promise.all([context.close(), operatorContext.close()])
})

test("a response given with no comment renders with no comment line on /surveys", async ({
  browser,
  baseURL,
}) => {
  const email = uniqueEmail("e2e-surveys-nocomment")
  const context = await contextFor(browser, baseURL, email)
  const page = await context.newPage()
  const seeded = await seedSubmission(page, email, "nocomment")

  await shipIt(context.request, seeded.reference)
  await answerSurvey(page, seeded.url, 1)

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()
  await operator.goto("/surveys")

  // With no comment given, there is no unique text to filter the row on the
  // way the test above does — scope by the customer's own email instead,
  // unique to this test's run (see `uniqueEmail`).
  const row = operator
    .getByTestId("response-row")
    .filter({ has: operator.getByTestId("response-customer").filter({ hasText: email }) })
  await expect(row, `exactly one response-row for ${email}`).toHaveCount(1)
  await expect(row).toHaveAttribute("data-rating", "1")
  await expect(row.getByTestId("response-comment")).toHaveCount(0)

  await Promise.all([context.close(), operatorContext.close()])
})

test("a response never appears twice, and no reply/edit control exists anywhere on the screen", async ({
  browser,
  baseURL,
}) => {
  const email = uniqueEmail("e2e-surveys-readonly")
  const context = await contextFor(browser, baseURL, email)
  const page = await context.newPage()
  const seeded = await seedSubmission(page, email, "readonly")

  await shipIt(context.request, seeded.reference)
  await answerSurvey(page, seeded.url, 3, "A synthetic read-only comment for e2e surveys coverage.")

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()
  await operator.goto("/surveys")

  const scoped = operator
    .getByTestId("response-row")
    .filter({ has: operator.getByTestId("response-customer").filter({ hasText: email }) })
  await expect(scoped).toHaveCount(1)

  // Read-only per #329's own rule: nothing on this screen writes anything —
  // no form, no button beyond the plain navigation link into the request.
  await expect(operator.locator("form")).toHaveCount(0)
  await expect(operator.getByRole("button")).toHaveCount(0)

  await Promise.all([context.close(), operatorContext.close()])
})

test("the surveys surface is a 404 to anyone who is not the operator, the same shape as a route that does not exist", async ({
  browser,
  baseURL,
}) => {
  const email = uniqueEmail("e2e-surveys-hidden")
  const context = await contextFor(browser, baseURL, email)
  const page = await context.newPage()
  const seeded = await seedSubmission(page, email, "hidden-404")
  await shipIt(context.request, seeded.reference)
  await answerSurvey(page, seeded.url, 5, "A synthetic comment nobody but the operator should ever list.")

  for (const identity of [email, null]) {
    const identityContext = await contextFor(browser, baseURL, identity)
    const response = await identityContext.request.get("/surveys")
    expect(response.status(), `GET /surveys as ${identity ?? "nobody"}`).toBe(404)
    const body = await response.text()
    expect(body).toContain("We can't find that")
    expect(body).not.toContain(email)
    await identityContext.close()
  }

  // Sanity: the response really is there, and the gate above — not a bug
  // that hides the whole route from everyone — is what stood in the way.
  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operatorResponse = await operatorContext.request.get("/surveys")
  expect(operatorResponse.status()).toBe(200)
  expect(await operatorResponse.text()).toContain(email)
  await operatorContext.close()

  await context.close()
})
