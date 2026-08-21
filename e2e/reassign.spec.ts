import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test"

/**
 * Black-box coverage for issue #130 ([portal] operator: reassign a
 * submission to a different (or new) project), driving the real Worker under
 * `wrangler dev` — see `playwright.config.ts`. This is the project's own
 * `e2e/` tier, not the sealed acceptance suite under `tests/acceptance/`; per
 * CLAUDE.md this repo still ships its own coverage for behaviour-changing work.
 *
 * SCOPE. #130 depends on the `clients` table (#128, landed) but not on #129's
 * own client-match UI on the promotion form — that issue is still open. So
 * this file's only black-box way to get a client a *second* project is #130's
 * own "start a new project instead" reassignment option: the promoted lead's
 * submission moves into a freshly created project, which then makes the
 * project it came from a valid reassignment target too. See
 * `src/clients.ts` for how a promoted lead's submission gets its first
 * client-linked project without #129's promotion-time choice.
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

/** Sends one lead through the public form, then promotes it as the operator. */
async function seedPromotedLead(
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
  const path = new URL(operator.url()).pathname
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

test("creating a new project moves the submission, and moving it back works too", async ({
  browser,
  baseURL,
}) => {
  const tag = nonce()
  const summary = `A synthetic round-trip reassignment check (${tag}).`
  const email = `reassign-roundtrip-${tag}@example.test`

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()
  const path = await seedPromotedLead(browser, baseURL, operator, summary, email)

  // A freshly promoted lead has no project of its own at all yet (see
  // `src/clients.ts`), so the first "start a new project instead" only ever
  // mints ONE project — there is nothing yet to leave behind.
  await openReassign(operator)
  await expect(operator.getByTestId("reassign-project-option")).toHaveCount(0)
  await operator.getByTestId("reassign-project-option-new").click()
  await operator.getByTestId("reassign-submit").click()
  await expect(operator.getByTestId("reassign-form")).toBeHidden()
  expect(new URL(operator.url()).pathname, "reassignment stays on the same screen").toBe(path)

  // Splitting a SECOND time — reassignment is not consumed by having just
  // been used (#130: "applies to any already-promoted submission, not just
  // at promotion time") — finally gives the client two projects, and the
  // first one now shows up as somewhere to move back to.
  await openReassign(operator)
  await expect(operator.getByTestId("reassign-project-option")).toHaveCount(0)
  await operator.getByTestId("reassign-project-option-new").click()
  await operator.getByTestId("reassign-submit").click()
  await expect(operator.getByTestId("reassign-form")).toBeHidden()

  await openReassign(operator)
  const afterSplit = await offeredProjectIds(operator)
  expect(afterSplit).toHaveLength(1)
  const originalProjectId = afterSplit[0] as string

  // Move it back.
  await operator.getByTestId("reassign-project-option").first().click()
  await operator.getByTestId("reassign-submit").click()
  await expect(operator.getByTestId("reassign-form")).toBeHidden()

  await openReassign(operator)
  const afterMoveBack = await offeredProjectIds(operator)
  expect(afterMoveBack, "the project just left is now offered instead").toHaveLength(1)
  expect(afterMoveBack).not.toContain(originalProjectId)

  // The customer's own dashboard now groups the submission under whichever
  // project it is in today (issue #109's `project-row`) — reassignment moved
  // it into a real project, which is visible from their side too, not just
  // the operator's.
  await operatorContext.close()
  const customerContext = await contextFor(browser, baseURL, email)
  const customer = await customerContext.newPage()
  await customer.goto("/submissions")
  await expect(customer.getByTestId("project-row")).toHaveCount(1)
  await customerContext.close()
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
