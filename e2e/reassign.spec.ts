import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test"

/**
 * Black-box coverage for issue #130 ([portal] operator: reassign a
 * submission to a different (or new) project), driving the real Worker under
 * `wrangler dev` — see `playwright.config.ts`. This is the project's own
 * `e2e/` tier, not the sealed acceptance suite under `tests/acceptance/`; per
 * CLAUDE.md this repo still ships its own coverage for behaviour-changing work.
 *
 * SCOPE. #130 depends on the `clients` table (#128, landed). #129 has since
 * landed too — every `seedPromotedLead` below already gets a client and a
 * first project ("Project 1") the moment it promotes, for any email nothing
 * has matched before (see `promoteLead` in `src/leads.ts`) — so a promoted
 * lead in this file is never truly project-less, only ever a "solo" client
 * with exactly one project. This file's only black-box way to get a client a
 * *second* project remains #130's own "start a new project instead"
 * reassignment option: the promoted lead's submission moves into a freshly
 * created second project, which then makes the first one (the auto-created
 * "Project 1") a valid reassignment target too.
 *
 * Every string below is invented — see CLAUDE.md rule 1.
 */

const ACCESS_HEADER = "Cf-Access-Authenticated-User-Email"

/** See `DEV_OPERATOR_EMAIL` in `src/operators.ts` — honoured only off Cloudflare's edge. */
const DEV_OPERATOR = "ops@example.test"

const TURNSTILE_FIELD = "cf-turnstile-response"

const SERVICE_TOKEN = {
  "CF-Access-Client-Id": "6a1f0c93d7e845b2a061e93f8c7d24b0.access",
  "CF-Access-Client-Secret":
    "7c2e5a08d4b1697fa8e3c60d1b7f4a92e6c0d8b3f5a2e19c67d0b4f8a1c6e39d",
}

function nonce(): string {
  return Math.random().toString(36).slice(2, 10)
}

/**
 * Every bridge event for `reference` — issue #146's `submission.project_assigned`
 * has no portal-side screen of its own, so this is the only black-box way to
 * see it land after a reassignment.
 */
async function bridgeEventsFor(
  request: APIRequestContext,
  reference: string,
): Promise<Array<{ type: string; payload: Record<string, unknown> }>> {
  const matches: Array<{ type: string; payload: Record<string, unknown> }> = []
  let cursor: string | undefined
  for (let page = 0; page < 50; page++) {
    const res = await request.get("/api/bridge/pull", {
      params: { limit: "200", ...(cursor ? { cursor } : {}) },
      headers: SERVICE_TOKEN,
    })
    expect(res.status()).toBe(200)
    const body = (await res.json()) as {
      events: Array<{ type: string; submission_id: string; payload: Record<string, unknown> }>
      cursor: string
      has_more: boolean
    }
    matches.push(
      ...body.events
        .filter((event) => event.submission_id === reference)
        .map((event) => ({ type: event.type, payload: event.payload })),
    )
    cursor = body.cursor
    if (!body.has_more) return matches
  }
  throw new Error("the stream never drained — the cursor is not advancing")
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

  // #129: promotion already gave this client its first project ("Project 1"),
  // so the very first "start a new project instead" already has something to
  // leave behind — one "new" click is enough to give the client two projects,
  // unlike the pre-#129 world this test used to need a second click for.
  await openReassign(operator)
  await expect(operator.getByTestId("reassign-project-option")).toHaveCount(0)
  await operator.getByTestId("reassign-project-option-new").click()
  await operator.getByTestId("reassign-submit").click()
  await expect(operator.getByTestId("reassign-form")).toBeHidden()
  expect(new URL(operator.url()).pathname, "reassignment stays on the same screen").toBe(path)

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

  // This customer's own dashboard: still exactly one submission, only ever
  // moved between projects, never duplicated — so `groupByProject`
  // (`src/routes/dashboard.ts`) renders it as an ordinary `submission-row`,
  // the same as a project-less one, not a `project-row` (issue #129: a
  // project only collapses into that once it holds *two or more*
  // submissions — see that function's own doc comment for why).
  await operatorContext.close()
  const customerContext = await contextFor(browser, baseURL, email)
  const customer = await customerContext.newPage()
  await customer.goto("/submissions")
  await expect(customer.getByTestId("project-row")).toHaveCount(0)
  await expect(customer.getByTestId("submission-row")).toHaveCount(1)
  await customerContext.close()
})

test("reassigning to a new project emits a submission.project_assigned event (#146)", async ({
  browser,
  baseURL,
  request,
}) => {
  const tag = nonce()
  const summary = `A synthetic bridge-event reassignment check (${tag}).`
  const email = `reassign-bridge-${tag}@example.test`

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()
  await seedPromotedLead(browser, baseURL, operator, summary, email)

  const reference = (await operator.getByTestId("promoted-submission-reference").innerText())
    .trim()
    .replace(/^Promoted to submission\s+/, "")

  // Nothing has moved the submission yet — its `submission.created` event
  // already carries the right project (#129/#146 do this synchronously), so
  // there is nothing for `submission.project_assigned` to correct.
  expect((await bridgeEventsFor(request, reference)).map((e) => e.type)).not.toContain(
    "submission.project_assigned",
  )

  await openReassign(operator)
  await operator.getByTestId("reassign-project-option-new").click()
  await operator.getByTestId("reassign-submit").click()
  await expect(operator.getByTestId("reassign-form")).toBeHidden()

  const afterReassign = await bridgeEventsFor(request, reference)
  const assigned = afterReassign.filter((e) => e.type === "submission.project_assigned")
  expect(assigned).toHaveLength(1)
  expect(assigned[0]?.payload["reference"]).toBe(reference)
  expect(assigned[0]?.payload["project_id"]).toEqual(expect.any(String))
  // The client this submission belongs to does not change on a reassignment
  // — only which of its projects the submission sits in does — so the same
  // client identity `submission.created` shipped travels along again here,
  // as an opaque id and nothing else: no email rides on this event either.
  expect(assigned[0]?.payload["client_id"]).toEqual(expect.any(String))
  expect(JSON.stringify(assigned)).not.toContain(email)

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
