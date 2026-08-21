import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test"

/**
 * Black-box coverage for issue #130 ([portal] operator: reassign a
 * submission to a different (or new) project), driving the real Worker under
 * `wrangler dev` — see `playwright.config.ts`. This is the project's own
 * `e2e/` tier, not the sealed acceptance suite under `tests/acceptance/`; per
 * CLAUDE.md this repo still ships its own coverage for behaviour-changing work.
 *
 * SCOPE. Reassignment only means anything for a client that has more than one
 * project, and the only way to get one black-box is the promotion form's own
 * project choice — the client-match card #129 puts on `/leads/:id` before
 * promotion, which this branch had to land for #130 to have anywhere to move
 * a submission to. So this file also covers that card, the promotion-time
 * attachment behind it, and the one screen it is visible from that neither
 * issue owns: the customer's own `/submissions`, where a project holding a
 * single request still renders as that request's own row.
 *
 * Every string below is invented — see CLAUDE.md rule 1.
 */

const ACCESS_HEADER = "Cf-Access-Authenticated-User-Email"

/** See `DEV_OPERATOR_EMAIL` in `src/operators.ts` — honoured only off Cloudflare's edge. */
const DEV_OPERATOR = "ops@example.test"

const TURNSTILE_FIELD = "cf-turnstile-response"

function nonce(): string {
  return Math.random().toString(36).slice(2, 10)
}

async function settleBotGate(page: Page) {
  await page.waitForFunction(
    (field) => {
      const input = document.querySelector(`input[name="${field}"]`) as HTMLInputElement | null
      return !!input && input.value.length > 0
    },
    TURNSTILE_FIELD,
    { timeout: 15_000 },
  )
}

async function contextFor(browser: Browser, baseURL: string | undefined, email: string | null) {
  return browser.newContext({
    baseURL,
    extraHTTPHeaders: email ? { [ACCESS_HEADER]: email } : {},
  })
}

/** Sends one lead through the public form and opens it as the operator. */
async function seedLead(
  browser: Browser,
  baseURL: string | undefined,
  operator: Page,
  summary: string,
  email: string,
): Promise<string> {
  const strangerContext = await contextFor(browser, baseURL, null)
  const stranger = await strangerContext.newPage()
  await stranger.goto("/start")
  await stranger.getByTestId("field-lead-summary").fill(summary)
  await stranger.getByTestId("field-lead-email").fill(email)
  await settleBotGate(stranger)
  await stranger.getByTestId("submit-lead").click()
  await expect(stranger.getByTestId("lead-receipt")).toBeVisible()
  await strangerContext.close()

  await operator.goto("/leads")
  const row = operator.getByTestId("lead-row").filter({ hasText: summary })
  await row.getByTestId("review-lead").click()
  return new URL(operator.url()).pathname
}

/**
 * Seed a lead and promote it, optionally picking the promotion form's "start
 * a new project instead" radio (#129's `client-project-option-new`) — which is
 * only on the screen for an address that already names a client.
 */
async function seedPromotedLead(
  browser: Browser,
  baseURL: string | undefined,
  operator: Page,
  summary: string,
  email: string,
  choice?: "new",
): Promise<string> {
  const path = await seedLead(browser, baseURL, operator, summary, email)
  if (choice === "new") await operator.getByTestId("client-project-option-new").check()
  await operator.getByTestId("promote-button").click()
  await expect(operator.getByTestId("lead-detail")).toHaveAttribute("data-status", "promoted")
  return path
}

/** Open the no-JS disclosure the way an operator does. */
async function openReassign(page: Page) {
  await expect(page.getByTestId("reassign-open-button")).toBeVisible()
  await page.getByTestId("reassign-open-button").click()
  await expect(page.getByTestId("reassign-form")).toBeVisible()
}

async function offeredProjectIds(page: Page): Promise<string[]> {
  const options = page.getByTestId("reassign-project-option")
  const count = await options.count()
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    ids.push((await options.nth(i).getAttribute("data-project-id")) ?? "")
  }
  return ids.sort()
}

test("a promoted lead with one project offers only 'start a new project'", async ({
  browser,
  baseURL,
}) => {
  const tag = nonce()
  const summary = `A synthetic single-project reassignment check (${tag}).`
  const email = `reassign-solo-${tag}@example.test`

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()
  const path = await seedPromotedLead(browser, baseURL, operator, summary, email)

  await openReassign(operator)
  await expect(operator.getByTestId("reassign-current-project")).not.toBeEmpty()
  await expect(operator.getByTestId("reassign-project-option")).toHaveCount(0)
  await expect(operator.getByTestId("reassign-project-option-new")).toHaveCount(1)

  // Closed by default is the ms-4 contract's own pinned state, but this repo's
  // e2e tier owns nothing that duplicates that sealed assertion — just that
  // the toggle really does gate the form with no script involved.
  const toggle = operator.getByTestId("reassign-toggle")
  await expect(toggle).toHaveAttribute("type", "checkbox")
  await operator.getByTestId("reassign-cancel").click()
  await expect(toggle).not.toBeChecked()
  await expect(operator.getByTestId("reassign-form")).toBeHidden()
  expect(new URL(operator.url()).pathname, "cancel submits nothing").toBe(path)

  await operatorContext.close()
})

test("a second lead from the same address is offered that client's projects", async ({
  browser,
  baseURL,
}) => {
  const tag = nonce()
  const email = `reassign-match-${tag}@example.test`
  const first = `A synthetic first contact for the match check (${tag}).`
  const second = `A synthetic second ask from the same address (${tag}).`

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()

  // Nobody has been promoted under this address yet, so there is no client to
  // match and the screen is exactly the one ms-2 shipped.
  const firstPath = await seedLead(browser, baseURL, operator, first, email)
  await expect(
    operator.getByTestId("client-match-card"),
    "a first contact matches no client — this screen gains nothing",
  ).toHaveCount(0)
  await operator.getByTestId("promote-button").click()
  await expect(operator.getByTestId("lead-detail")).toHaveAttribute("data-status", "promoted")
  expect(new URL(operator.url()).pathname).toBe(firstPath)

  // That promotion minted the client, so the next lead from the same person is
  // recognised — and offers the project the first one created.
  await seedLead(browser, baseURL, operator, second, email)
  await expect(operator.getByTestId("client-match-card")).toBeVisible()
  await expect(operator.getByTestId("client-match-email")).toHaveText(email)
  await expect(operator.getByTestId("client-match-project-count")).toHaveText("1")
  await expect(operator.getByTestId("client-project-option")).toHaveCount(1)
  await expect(
    operator.getByTestId("client-project-option").locator('input[type="radio"]'),
    "the newest project is pre-selected",
  ).toBeChecked()
  const offered = await operator
    .getByTestId("client-project-option")
    .first()
    .getAttribute("data-project-id")
  expect(offered, "each offered project names itself").toMatch(/^proj_/)

  // Choosing "start a new project instead" gives this client a second project,
  // which is what makes reassignment meaningful at all.
  await operator.getByTestId("client-project-option-new").check()
  await operator.getByTestId("promote-button").click()
  await expect(operator.getByTestId("lead-detail")).toHaveAttribute("data-status", "promoted")

  await openReassign(operator)
  expect(
    await offeredProjectIds(operator),
    "the second submission sits in its own new project, leaving the first one to move to",
  ).toEqual([offered])

  await operatorContext.close()
})

test("creating a new project moves the submission, and moving it back works too", async ({
  browser,
  baseURL,
}) => {
  const tag = nonce()
  const email = `reassign-roundtrip-${tag}@example.test`
  const first = `A synthetic round-trip first project (${tag}).`
  const second = `A synthetic round-trip second project (${tag}).`

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()

  // Two promoted leads on one address, the second into a project of its own:
  // a client with two projects, which is the only state reassignment has
  // anywhere to go from.
  await seedPromotedLead(browser, baseURL, operator, first, email)
  const path = await seedPromotedLead(browser, baseURL, operator, second, email, "new")

  await openReassign(operator)
  const before = await offeredProjectIds(operator)
  expect(before).toHaveLength(1)
  const firstProjectId = before[0] as string

  await operator.getByTestId("reassign-project-option").first().click()
  await operator.getByTestId("reassign-submit").click()
  await expect(operator.getByTestId("reassign-form")).toBeHidden()
  expect(new URL(operator.url()).pathname, "reassignment stays on the same screen").toBe(path)

  await openReassign(operator)
  const afterMove = await offeredProjectIds(operator)
  expect(afterMove, "the project just left is now the one on offer").toHaveLength(1)
  expect(afterMove).not.toContain(firstProjectId)

  // Splitting again — reassignment is not consumed by having just been used
  // (#130: "applies to any already-promoted submission, not just at promotion
  // time") — leaves BOTH older projects to move back to.
  await operator.getByTestId("reassign-project-option-new").click()
  await operator.getByTestId("reassign-submit").click()
  await expect(operator.getByTestId("reassign-form")).toBeHidden()

  await openReassign(operator)
  const afterSplit = await offeredProjectIds(operator)
  expect(afterSplit, "a brand-new third project leaves both older ones on offer").toHaveLength(2)
  expect(afterSplit).toContain(firstProjectId)

  await operatorContext.close()
})

test("the customer sees a plain row until a project actually holds more than one request", async ({
  browser,
  baseURL,
}) => {
  const tag = nonce()
  const email = `reassign-dashboard-${tag}@example.test`
  const first = `A synthetic dashboard-grouping first ask (${tag}).`
  const second = `A synthetic dashboard-grouping second ask (${tag}).`

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()
  await seedPromotedLead(browser, baseURL, operator, first, email)
  const path = await seedPromotedLead(browser, baseURL, operator, second, email, "new")

  // Promotion put each submission in a project of its own. A project of one is
  // not a grouping, so the customer still sees the ordinary ms-1 rows linking
  // to their own submissions — the shape a promoted lead has always had.
  const customerContext = await contextFor(browser, baseURL, email)
  const customer = await customerContext.newPage()
  await customer.goto("/submissions")
  await expect(customer.getByTestId("submission-row")).toHaveCount(2)
  await expect(customer.getByTestId("project-row")).toHaveCount(0)
  for (const href of await customer.getByTestId("submission-row").evaluateAll((rows) =>
    rows.map((row) => row.getAttribute("href") ?? ""),
  )) {
    expect(href, "an ungrouped row opens the submission itself").toMatch(/^\/submissions\//)
  }

  // Move the second submission in with the first, and the same screen collapses
  // into issue #109's project row — two requests under one project.
  await operator.goto(path)
  await openReassign(operator)
  await operator.getByTestId("reassign-project-option").first().click()
  await operator.getByTestId("reassign-submit").click()
  await expect(operator.getByTestId("reassign-form")).toBeHidden()

  await customer.goto("/submissions")
  await expect(customer.getByTestId("project-row")).toHaveCount(1)
  await expect(customer.getByTestId("project-row")).toContainText("2 requests")
  await expect(customer.getByTestId("submission-row")).toHaveCount(0)

  await customerContext.close()
  await operatorContext.close()
})

/** File a request through `POST /intake`, returning the new submission's id. */
async function fileRequest(
  request: APIRequestContext,
  email: string,
  outcome: string,
  followUpFrom?: string,
): Promise<string> {
  const path = followUpFrom ? `/intake?from=${encodeURIComponent(followUpFrom)}` : "/intake"
  const res = await request.post(path, {
    headers: { [ACCESS_HEADER]: email },
    form: {
      outcome,
      audience: "Synthetic e2e readers",
      doneDefinition: "The reassign e2e suite goes green.",
    },
    maxRedirects: 0,
  })
  const location = res.headers()["location"] ?? ""
  const id = /\/submissions\/([A-Za-z0-9_-]+)/.exec(location)?.[1]
  expect(id, `POST ${path} should redirect to /submissions/:id`).toBeTruthy()
  return id as string
}

test("a customer's own follow-up project never shows up as a reassignment target", async ({
  browser,
  baseURL,
  request,
}) => {
  const tag = nonce()
  const summary = `A synthetic cross-population reassignment check (${tag}).`
  const email = `reassign-mixed-${tag}@example.test`

  // A project this same customer made themselves through #109's "Start a
  // follow-up" — `client_id IS NULL` (#128: no backfill, no inference from a
  // matching email), so it must never appear on offer here.
  const origin = await fileRequest(request, email, `An unrelated booking page (${tag})`)
  await fileRequest(request, email, `The same booking page, with deposits (${tag})`, origin)

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()
  await seedPromotedLead(browser, baseURL, operator, summary, email)

  await openReassign(operator)
  await expect(
    operator.getByTestId("reassign-project-option"),
    "the only client_id-linked project for this address is the promoted one itself, and a " +
      "submission is never offered a move to where it already is — the follow-up project (client_id " +
      "IS NULL) is excluded on a separate, stronger ground",
  ).toHaveCount(0)
  await expect(operator.getByTestId("reassign-project-option-new")).toHaveCount(1)

  await operatorContext.close()
})

test("a stranger and a non-operator cannot reassign anything", async ({ browser, baseURL, request }) => {
  const tag = nonce()
  const summary = `A synthetic reassignment access-control check (${tag}).`
  const email = `reassign-guard-${tag}@example.test`

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()
  const path = await seedPromotedLead(browser, baseURL, operator, summary, email)
  await operatorContext.close()

  const anonymous = await request.post(`${path}/reassign`, {
    form: {},
    maxRedirects: 0,
    failOnStatusCode: false,
  })
  expect(anonymous.status()).toBe(404)

  const nonOperator = await request.post(`${path}/reassign`, {
    headers: { [ACCESS_HEADER]: `curious-${tag}@example.test` },
    form: {},
    maxRedirects: 0,
    failOnStatusCode: false,
  })
  expect(nonOperator.status()).toBe(404)

  const unknownLead = await request.post("/leads/lead_does_not_exist_e2e/reassign", {
    headers: { [ACCESS_HEADER]: DEV_OPERATOR },
    form: {},
    maxRedirects: 0,
    failOnStatusCode: false,
  })
  expect(unknownLead.status()).toBe(404)
})
