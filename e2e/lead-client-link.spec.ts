import { expect, test, type Browser, type Page } from "@playwright/test"

/**
 * Black-box coverage for issue #129 (lead promotion: detect + link an
 * existing client, default-create client+"Project 1" for new emails),
 * driving the real Worker under `wrangler dev` — see `playwright.config.ts`.
 * This is the project's own `e2e/` tier, not the sealed acceptance suite
 * under `tests/acceptance/`; per CLAUDE.md this repo still ships its own
 * coverage for behaviour-changing work, and the sealed suite's independence
 * is exactly why it does not substitute for this file.
 *
 * SCOPE. The behavior this issue actually adds — "the operator sees the
 * existing client and their project list on the promotion screen, and picks
 * one to attach the new submission to" — only shows up once *two* leads
 * share an email: the first has nothing to match (auto-creates a client and
 * "Project 1"), and the second is where `client-match-card` renders at all.
 * `e2e/reassign.spec.ts` and `e2e/leads.spec.ts` both mint a fresh, never
 * seen email per lead, so neither exercises this. This file is the one that
 * does.
 *
 * Every string below is invented — see CLAUDE.md rule 1.
 */

const ACCESS_HEADER = "Cf-Access-Authenticated-User-Email"

/** See `DEV_OPERATOR_EMAIL` in `src/operators.ts` — honoured only off Cloudflare's edge. */
const DEV_OPERATOR = "ops@example.test"

const TURNSTILE_FIELD = "cf-turnstile-response"

const SERVICE_TOKEN = {
  "CF-Access-Client-Id": "d4e8f2a961b7405c8e21f0a6c9b3d5e7.access",
  "CF-Access-Client-Secret":
    "2f7b1e9c4d0a68f3b5e2c7908a4d1f6e3c9b7a2d5f0e8c14a69b3d7e2f5c8091",
}

function nonce(): string {
  return Math.random().toString(36).slice(2, 10)
}

/**
 * The `submission.created` payload for `reference`, off the real bridge
 * stream — issue #146's client/project identity has no portal-side screen of
 * its own to assert on, so this is the only black-box way to see it.
 */
async function submissionCreatedPayload(
  request: import("@playwright/test").APIRequestContext,
  reference: string,
): Promise<Record<string, unknown> | undefined> {
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
    const match = body.events.find(
      (event) => event.submission_id === reference && event.type === "submission.created",
    )
    if (match) return match.payload
    cursor = body.cursor
    if (!body.has_more) return undefined
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

/** Sends one lead through the public form, and returns the operator's path to it. */
async function sendLeadAndOpen(
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

test("a brand-new email auto-creates a client and Project 1, with no match card", async ({
  browser,
  baseURL,
  request,
}) => {
  const tag = nonce()
  const summary = `A synthetic first-contact lead for client linking (${tag}).`
  const email = `client-link-first-${tag}@example.test`

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()
  await sendLeadAndOpen(browser, baseURL, operator, summary, email)

  // Nothing to match yet — no card, on the pre-promotion screen.
  await expect(operator.getByTestId("client-match-card")).toHaveCount(0)

  await operator.getByTestId("promote-button").click()
  await expect(operator.getByTestId("lead-detail")).toHaveAttribute("data-status", "promoted")

  const attachment = operator.getByTestId("client-attachment")
  await expect(attachment).toHaveAttribute("data-match", "new")
  await expect(attachment).toContainText(email)
  await expect(attachment).toContainText("Project 1")

  const statusPill = operator.getByTestId("attached-submission-status")
  await expect(statusPill).toHaveAttribute("data-status", "describing")
  await expect(statusPill).toHaveText("Describing")

  // Issue #146: promotion knows the client and project synchronously — no
  // separate `submission.project_assigned` correction is needed, unlike a
  // follow-up's own project (`e2e/projects.spec.ts` covers that case).
  const reference = (await operator.getByTestId("promoted-submission-reference").innerText())
    .trim()
    .replace(/^Promoted to submission\s+/, "")
  const payload = await submissionCreatedPayload(request, reference)
  expect(payload?.["client_id"]).toEqual(expect.any(String))
  expect(payload?.["project_id"]).toEqual(expect.any(String))
  // Identity crosses as opaque ids only. The client's contact address is a
  // portal-side fact and stays here — including on the one path where the
  // client row was minted from this very lead's email (ms-2 contract note 7 /
  // issue #33: "coord never sees leads").
  expect(JSON.stringify(payload)).not.toContain(email)
  expect(payload).not.toHaveProperty("client_email")

  await operatorContext.close()
})

test("a second lead sharing an email sees the existing client and joins its project", async ({
  browser,
  baseURL,
}) => {
  const tag = nonce()
  const email = `client-link-repeat-${tag}@example.test`
  const firstSummary = `A synthetic first booking from a repeat client (${tag}).`
  const secondSummary = `A synthetic follow-up from the same repeat client (${tag}).`

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()

  // First lead: nothing matches, so it mints the client and "Project 1".
  await sendLeadAndOpen(browser, baseURL, operator, firstSummary, email)
  await operator.getByTestId("promote-button").click()
  await expect(operator.getByTestId("lead-detail")).toHaveAttribute("data-status", "promoted")
  await expect(operator.getByTestId("client-attachment")).toHaveAttribute("data-match", "new")

  // Second lead, same email: this is the actual behavior #129 exists for —
  // the operator sees the existing client and its project list before
  // promoting, not just a stranger's first contact.
  await sendLeadAndOpen(browser, baseURL, operator, secondSummary, email)

  const matchCard = operator.getByTestId("client-match-card")
  await expect(matchCard).toBeVisible()
  await expect(operator.getByTestId("client-match-email")).toHaveText(email)
  await expect(operator.getByTestId("client-match-project-count")).toHaveText("1")

  const projectOptions = operator.getByTestId("client-project-option")
  await expect(projectOptions).toHaveCount(1)
  await expect(projectOptions.first().locator('input[type="radio"]')).toBeChecked()
  await expect(operator.getByTestId("client-project-option-new")).toHaveCount(1)

  // The operator picks the existing project (already pre-selected) and
  // promotes — the new submission should join it, not start a second one.
  await operator.getByTestId("promote-button").click()
  await expect(operator.getByTestId("lead-detail")).toHaveAttribute("data-status", "promoted")

  // The joined project's displayed title now comes from its newest member —
  // this same second submission — the same convention `/leads/:id` and
  // `/projects/:id` both already use (`projectTitle`, `src/routes/leads.ts`).
  const attachment = operator.getByTestId("client-attachment")
  await expect(attachment).toHaveAttribute("data-match", "existing")
  await expect(attachment).toContainText(email)
  await expect(attachment).toContainText("joins")
  await expect(attachment).toContainText(secondSummary)

  const statusPill = operator.getByTestId("attached-submission-status")
  await expect(statusPill).toHaveAttribute("data-status", "describing")
  await expect(statusPill).toHaveText("Describing")

  // Both submissions now share one project — the customer's own dashboard
  // collapses them into a single `project-row` (two members, `groupByProject`
  // in `src/routes/dashboard.ts`), never two separate `submission-row`s.
  await operatorContext.close()
  const customerContext = await contextFor(browser, baseURL, email)
  const customer = await customerContext.newPage()
  await customer.goto("/submissions")
  await expect(customer.getByTestId("project-row")).toHaveCount(1)
  await expect(customer.getByTestId("submission-row")).toHaveCount(0)
  await customerContext.close()
})

test("a second lead sharing an email can start a new project instead of joining", async ({
  browser,
  baseURL,
}) => {
  const tag = nonce()
  const email = `client-link-newproject-${tag}@example.test`
  const firstSummary = `A synthetic first booking before a second project (${tag}).`
  const secondSummary = `A synthetic follow-up that starts its own project (${tag}).`

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()

  await sendLeadAndOpen(browser, baseURL, operator, firstSummary, email)
  await operator.getByTestId("promote-button").click()
  await expect(operator.getByTestId("lead-detail")).toHaveAttribute("data-status", "promoted")

  await sendLeadAndOpen(browser, baseURL, operator, secondSummary, email)
  await expect(operator.getByTestId("client-match-card")).toBeVisible()

  // Explicitly choose "start a new project instead" rather than the
  // pre-selected existing one.
  await operator.getByTestId("client-project-option-new").locator('input[type="radio"]').check()
  await operator.getByTestId("promote-button").click()
  await expect(operator.getByTestId("lead-detail")).toHaveAttribute("data-status", "promoted")

  const attachment = operator.getByTestId("client-attachment")
  await expect(attachment).toHaveAttribute("data-match", "existing")
  await expect(attachment).toContainText(email)
  await expect(attachment).toContainText("started")
  await expect(attachment).toContainText("Project 2")

  // Each submission stayed alone in its own project — the customer's
  // dashboard shows two ordinary rows, not one collapsed project.
  await operatorContext.close()
  const customerContext = await contextFor(browser, baseURL, email)
  const customer = await customerContext.newPage()
  await customer.goto("/submissions")
  await expect(customer.getByTestId("submission-row")).toHaveCount(2)
  await expect(customer.getByTestId("project-row")).toHaveCount(0)
  await customerContext.close()
})
