import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test"

/**
 * Black-box coverage for issue #132 (operator "start work" override: skip
 * sign-off, go straight to Planned), driving the real Worker under
 * `wrangler dev` — see `playwright.config.ts`. This is the project's own
 * `e2e/` tier, not the sealed acceptance suite under `tests/acceptance/`; per
 * CLAUDE.md this repo still ships its own coverage for behaviour-changing
 * work, independent of the sealed slice
 * (`tests/acceptance/ms-4/132-start-work-override.spec.ts`), which this file
 * does not read and is not written to satisfy.
 *
 * WRITTEN FOR A SHARED, CONCURRENT DATABASE, same posture `e2e/reassign.spec.ts`
 * and `e2e/bridge.spec.ts` already take: `playwright.config.ts` runs
 * `fullyParallel` and `serve:test` does not wipe state between runs, so every
 * assertion below is scoped to a lead this test itself created.
 *
 * Every string below is invented — see CLAUDE.md rule 1.
 */

const ACCESS_HEADER = "Cf-Access-Authenticated-User-Email"

/** See `DEV_OPERATOR_EMAIL` in `src/operators.ts` — honoured only off Cloudflare's edge. */
const DEV_OPERATOR = "ops@example.test"

const TURNSTILE_FIELD = "cf-turnstile-response"

const SERVICE_TOKEN = {
  "CF-Access-Client-Id": "b7c41e9028fa4d6ea15c39f8027bd461.access",
  "CF-Access-Client-Secret":
    "5c8e1a37d024b96f81e7350ac6d24f9b1e0a7d63c85f492a70b3e18d5c6a29f4",
}

interface BridgeEvent {
  id: string
  revision: number
  type: string
  submission_id: string
  occurred_at: string
  payload: Record<string, unknown>
}

interface PullPage {
  events: BridgeEvent[]
  cursor: string
  has_more: boolean
}

async function pull(request: APIRequestContext, cursor?: string): Promise<PullPage> {
  const params: Record<string, string> = { limit: "200" }
  if (cursor) params["cursor"] = cursor
  const res = await request.get("/api/bridge/pull", { params, headers: SERVICE_TOKEN })
  expect(res.status()).toBe(200)
  return (await res.json()) as PullPage
}

/** Reads to the end of the stream and returns the cursor that sits past it. */
async function drain(request: APIRequestContext): Promise<string> {
  let cursor: string | undefined
  for (let page = 0; page < 50; page++) {
    const body = await pull(request, cursor)
    cursor = body.cursor
    if (!body.has_more) return body.cursor
  }
  throw new Error("the stream never drained — the cursor is not advancing")
}

/** Everything on the stream after `cursor`, following `has_more` to the end. */
async function collectFrom(request: APIRequestContext, cursor: string): Promise<BridgeEvent[]> {
  const events: BridgeEvent[] = []
  let next = cursor
  for (let page = 0; page < 50; page++) {
    const body = await pull(request, next)
    events.push(...body.events)
    next = body.cursor
    if (!body.has_more) return events
  }
  throw new Error("the stream never drained — the cursor is not advancing")
}

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

test("the override card is offered while the attached submission is still describing", async ({
  browser,
  baseURL,
}) => {
  const tag = nonce()
  const summary = `A synthetic pre-agreed tidy-up (${tag}) — start-work offer check.`
  const email = `start-work-offer-${tag}@example.test`

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()
  await seedPromotedLead(browser, baseURL, operator, summary, email)

  await expect(operator.getByTestId("attached-submission-status")).toHaveAttribute(
    "data-status",
    "describing",
  )
  await expect(operator.getByTestId("start-work-card")).toBeVisible()
  await expect(operator.getByTestId("start-work-form")).toHaveAttribute("method", /post/i)
  await expect(operator.getByTestId("start-work-button")).toHaveText("Start work")

  await operatorContext.close()
})

test("using the override moves the submission to Planned, on both sides of the wall, and retires the card", async ({
  browser,
  baseURL,
}) => {
  const tag = nonce()
  const summary = `A synthetic pre-agreed tidy-up (${tag}) — start-work happy path.`
  const email = `start-work-happy-${tag}@example.test`

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()
  const path = await seedPromotedLead(browser, baseURL, operator, summary, email)

  await operator.getByTestId("start-work-button").click()
  await expect(operator.getByTestId("attached-submission-status")).toHaveAttribute(
    "data-status",
    "planned",
  )
  await expect(operator.getByTestId("start-work-card")).toHaveCount(0)

  // Durable, not a one-shot flash on the POST's own response.
  await operator.goto("/leads")
  await operator.goto(path)
  await expect(operator.getByTestId("attached-submission-status")).toHaveAttribute(
    "data-status",
    "planned",
  )
  await expect(operator.getByTestId("start-work-card")).toHaveCount(0)

  // The customer's own `/submissions/:id` — ms-1's unmodified rollup template
  // — reads Planned too, with no design round or sign-off in between.
  await operatorContext.close()
  const customerContext = await contextFor(browser, baseURL, email)
  const customer = await customerContext.newPage()
  await customer.goto("/submissions")
  const href = await customer.getByTestId("submission-row").getAttribute("href")
  await customer.goto(href ?? "/submissions")
  await expect(customer.getByTestId("submission-detail")).toHaveAttribute("data-status", "planned")
  await expect(customer.getByTestId("status-pill")).toHaveText("Planned")
  await expect(customer.getByTestId("status-timeline"), "planned is a rollup status").toBeVisible()
  for (const hook of ["approve-button", "request-changes-button", "design-round"]) {
    await expect(customer.getByTestId(hook), `the override skipped the sign-off loop`).toHaveCount(0)
  }
  await customerContext.close()
})

test("a retried or concurrent start-work converges on the same planned submission", async ({
  browser,
  baseURL,
}) => {
  const tag = nonce()
  const summary = `A synthetic pre-agreed tidy-up (${tag}) — start-work idempotency check.`
  const email = `start-work-idem-${tag}@example.test`

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()
  const path = await seedPromotedLead(browser, baseURL, operator, summary, email)

  await operator.getByTestId("start-work-button").click()
  await expect(operator.getByTestId("attached-submission-status")).toHaveAttribute(
    "data-status",
    "planned",
  )

  const retry = await operatorContext.request.post(`${path}/start-work`, {
    form: {},
    maxRedirects: 0,
    failOnStatusCode: false,
  })
  expect(retry.status(), "a retried start-work is not an error").toBeLessThan(400)

  const raced = await Promise.all(
    Array.from({ length: 3 }, () =>
      operatorContext.request.post(`${path}/start-work`, {
        form: {},
        maxRedirects: 0,
        failOnStatusCode: false,
      }),
    ),
  )
  for (const response of raced) {
    expect(response.status(), "a concurrent start-work is not an error either").toBeLessThan(400)
  }

  await operator.goto(path)
  await expect(operator.getByTestId("attached-submission-status")).toHaveAttribute(
    "data-status",
    "planned",
  )
  await expect(operator.getByTestId("start-work-card")).toHaveCount(0)

  await operatorContext.close()
})

test("start work is refused to anyone who is not the operator, and changes nothing", async ({
  browser,
  baseURL,
  request,
}) => {
  const tag = nonce()
  const summary = `A synthetic pre-agreed tidy-up (${tag}) — start-work access-control check.`
  const email = `start-work-guard-${tag}@example.test`

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()
  const path = await seedPromotedLead(browser, baseURL, operator, summary, email)
  await operatorContext.close()

  const anonymous = await request.post(`${path}/start-work`, {
    form: {},
    maxRedirects: 0,
    failOnStatusCode: false,
  })
  expect(anonymous.status()).toBe(404)

  const customer = await request.post(`${path}/start-work`, {
    headers: { [ACCESS_HEADER]: email },
    form: {},
    maxRedirects: 0,
    failOnStatusCode: false,
  })
  expect(customer.status(), "not even the submission's own customer may drive this override").toBe(
    404,
  )

  const unknownLead = await request.post("/leads/lead_does_not_exist_e2e/start-work", {
    headers: { [ACCESS_HEADER]: DEV_OPERATOR },
    form: {},
    maxRedirects: 0,
    failOnStatusCode: false,
  })
  expect(unknownLead.status()).toBe(404)

  // Nothing moved.
  const checkContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const checkPage = await checkContext.newPage()
  await checkPage.goto(path)
  await expect(checkPage.getByTestId("attached-submission-status")).toHaveAttribute(
    "data-status",
    "describing",
  )
  await expect(checkPage.getByTestId("start-work-card")).toBeVisible()
  await checkContext.close()
})

/** See `SERVICE_TOKEN` above — off the edge, any well-formed pair authorises `/api/bridge/push` too. */
async function pushStatus(
  request: APIRequestContext,
  reference: string,
  status: string,
  revision: number,
) {
  const res = await request.post("/api/bridge/push", {
    data: { updates: [{ submission_id: reference, revision, fields: { status } }] },
    headers: SERVICE_TOKEN,
  })
  expect(res.status()).toBe(200)
  const body = (await res.json()) as { results: Array<{ outcome: string }> }
  expect(body.results[0]?.outcome).toBe("applied")
}

test("the override is withdrawn once the coordinator moves the submission past describing", async ({
  browser,
  baseURL,
  request,
}) => {
  const tag = nonce()
  const summary = `A synthetic pre-agreed tidy-up (${tag}) — start-work past-describing check.`
  const email = `start-work-past-describing-${tag}@example.test`

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()
  const path = await seedPromotedLead(browser, baseURL, operator, summary, email)

  const reference = ((await operator.getByTestId("promoted-submission-reference").innerText()).match(
    /SUB-[A-Z0-9]{6}/,
  ) ?? [])[0]
  expect(reference, "the promoted lead should record the submission it produced").toBeTruthy()

  // The coordinator independently opens a design round — the submission is no
  // longer `describing` before the operator ever clicks "Start work".
  await pushStatus(request, reference as string, "in-design", 1)

  await operator.goto(path)
  await expect(operator.getByTestId("attached-submission-status")).toHaveAttribute(
    "data-status",
    "in-design",
  )
  await expect(
    operator.getByTestId("start-work-card"),
    "the card must not offer an override the coordinator has already moved past",
  ).toHaveCount(0)

  const attempt = await operatorContext.request.post(`${path}/start-work`, {
    form: {},
    maxRedirects: 0,
    failOnStatusCode: false,
  })
  expect(attempt.status(), "the route itself refuses, not just the missing card").toBe(404)

  await operator.goto(path)
  await expect(operator.getByTestId("attached-submission-status")).toHaveAttribute(
    "data-status",
    "in-design",
  )
  await expect(operator.getByTestId("start-work-card")).toHaveCount(0)

  await operatorContext.close()
})

test("starting work is visible on the sync bridge", async ({ browser, baseURL, request }) => {
  const tag = nonce()
  const summary = `A synthetic pre-agreed tidy-up (${tag}) — start-work bridge check.`
  const email = `start-work-bridge-${tag}@example.test`

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()
  await seedPromotedLead(browser, baseURL, operator, summary, email)

  const reference = ((await operator.getByTestId("promoted-submission-reference").innerText()).match(
    /SUB-[A-Z0-9]{6}/,
  ) ?? [])[0]
  expect(reference, "the promoted lead should record the submission it produced").toBeTruthy()

  const baseline = await drain(request)
  await operator.getByTestId("start-work-button").click()
  await expect(operator.getByTestId("attached-submission-status")).toHaveAttribute(
    "data-status",
    "planned",
  )

  const fresh = await collectFrom(request, baseline)
  const mine = fresh.filter((event) => event.submission_id === reference)
  expect(mine.length, "the daemon's next poll learns the submission moved").toBeGreaterThan(0)
  // Issue #132's own decision, documented in `src/startWork.ts`: this reuses
  // `signoff.approved`'s shape, distinguished from a genuine customer sign-off
  // by an additive `source` marker in the payload.
  for (const event of mine) {
    expect(event.type).toBe("signoff.approved")
    expect(event.payload).toMatchObject({ verdict: "approved", source: "operator_start_work" })
  }

  await operatorContext.close()
})
