import { expect, test, type Browser, type Page } from "@playwright/test"

/**
 * Black-box coverage for issue #110 ([portal] async chat/threaded comments),
 * driving the real Worker under `wrangler dev` with real local D1 — see
 * `playwright.config.ts`. This is the project's own `e2e/` tier, not the
 * sealed acceptance suite under `tests/acceptance/` (there is no Gate-A
 * contract slice for #110 yet); per CLAUDE.md this repo still ships its own
 * black-box coverage for behaviour-changing work.
 *
 * SCOPE. A message thread (`src/messages.ts`, submission-scoped) that is:
 *   - customer-writable on `/submissions/:id` (`src/routes/submission.ts`),
 *     the same Access-derived identity every other write on that page uses;
 *   - operator-writable on `/leads/:id` for a promoted lead
 *     (`src/routes/leads.ts`) — not on `/submissions/:id`, which stays a
 *     404 for an operator exactly as it was before this issue (ms-1's
 *     ownership scoping, sealed-pinned again by
 *     `tests/acceptance/ms-2/33-lead-triage-promotion.spec.ts`);
 *   - purely informational: never moves `submissions.status`, never touches
 *     a design round or a signoff.
 *
 * Every string below is invented — see CLAUDE.md rule 1.
 *
 * ── WRITTEN FOR A SHARED, ACCUMULATING DATABASE ────────────────────────────
 * `serve:test` does not wipe `.wrangler/state` between runs and the suite is
 * `fullyParallel`, so every assertion below is scoped to a nonce this test
 * minted (a unique customer email, a unique message body) rather than
 * counting rows globally.
 */

const ACCESS_HEADER = "Cf-Access-Authenticated-User-Email"

/** See `DEV_OPERATOR_EMAIL` in `src/operators.ts` — honoured only off Cloudflare's edge. */
const DEV_OPERATOR = "ops@example.test"

const TURNSTILE_FIELD = "cf-turnstile-response"

const SERVICE_TOKEN = {
  "CF-Access-Client-Id": "b7e46a3ff291c58d64ab0e9573fdc12e.access",
  "CF-Access-Client-Secret":
    "4f8e2d719ac06b3e58f1c4a927db6053ea4c891072fd6e3b81a5907cf3e6d24",
}

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

/**
 * Moves a submission off `describing` — the one template `detailFor` never
 * appends the message thread to (see `src/routes/submission.ts`'s module
 * comment). Every test that needs to see the thread on `/submissions/:id`
 * pushes it to `in-progress` first, the same instrument
 * `e2e/status-detail.spec.ts` uses.
 */
async function pushInProgress(
  request: import("@playwright/test").APIRequestContext,
  reference: string,
): Promise<void> {
  const res = await request.post("/api/bridge/push", {
    data: { updates: [{ submission_id: reference, revision: 1, fields: { status: "in-progress" } }] },
    headers: SERVICE_TOKEN,
  })
  expect(res.status()).toBe(200)
  const body = (await res.json()) as { results: Array<{ outcome: string }> }
  expect(body.results[0]?.outcome).toBe("applied")
}

interface Seeded {
  url: string
  reference: string
}

/** Files an ordinary submission through `/intake`, as the given customer. */
async function seedSubmission(page: Page, email: string): Promise<Seeded> {
  await page.setExtraHTTPHeaders({ [ACCESS_HEADER]: email })
  await page.goto("/intake")
  await page.getByTestId("field-outcome").fill("A synthetic outcome for e2e message-thread coverage.")
  await page.getByTestId("field-audience").fill("synthetic e2e readers")
  await page.getByTestId("field-done-definition").fill("The message-thread e2e suite goes green.")
  await page.getByTestId("submit-intake").click()
  await expect(page.getByTestId("intake-receipt")).toBeVisible()

  const reference = (await page.getByTestId("submission-reference").innerText())
    .trim()
    .replace(/^Reference\s+/, "")
  return { url: page.url(), reference }
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

/** Sends a lead through `/start`, promotes it as the dev operator, and returns both. */
async function seedPromotedLead(
  browser: Browser,
  baseURL: string | undefined,
  customerEmail: string,
): Promise<{ leadUrl: string; submissionReference: string }> {
  const summary = `A synthetic booking flow for e2e message-thread coverage (${nonce()}).`

  const strangerContext = await contextFor(browser, baseURL, null)
  const stranger = await strangerContext.newPage()
  await stranger.goto("/start")
  await stranger.getByTestId("field-lead-summary").fill(summary)
  await stranger.getByTestId("field-lead-email").fill(customerEmail)
  await settleBotGate(stranger)
  await stranger.getByTestId("submit-lead").click()
  await expect(stranger.getByTestId("lead-receipt")).toBeVisible()
  await strangerContext.close()

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()
  await operator.goto("/leads")
  await operator.getByTestId("lead-row").filter({ hasText: summary }).getByTestId("review-lead").click()
  const leadUrl = operator.url()
  await operator.getByTestId("promote-button").click()
  const submissionReference = (await operator.getByTestId("promoted-submission-reference").innerText())
    .replace(/^Promoted to submission\s+/, "")
    .trim()
  await operatorContext.close()

  return { leadUrl, submissionReference }
}

test("a customer posts a message and reads it back, oldest first", async ({ page, request }) => {
  const email = uniqueEmail("e2e-customer-post")
  const seeded = await seedSubmission(page, email)
  await pushInProgress(request, seeded.reference)
  await page.goto(seeded.url)

  await expect(page.getByTestId("message-thread")).toBeVisible()
  await expect(page.getByTestId("message-thread-empty")).toHaveText("No messages yet.")
  await expect(page.getByTestId("message-item")).toHaveCount(0)

  await page.getByTestId("message-field").fill("First: when can we start?")
  await page.getByTestId("submit-message").click()
  await expect(page).toHaveURL(seeded.url)

  await page.getByTestId("message-field").fill("Second: also, what about weekends?")
  await page.getByTestId("submit-message").click()
  await expect(page).toHaveURL(seeded.url)

  const items = page.getByTestId("message-item")
  await expect(items).toHaveCount(2)
  await expect(items.nth(0)).toHaveAttribute("data-author-role", "customer")
  await expect(items.nth(0).getByTestId("message-author")).toHaveText("You")
  await expect(items.nth(0).getByTestId("message-body")).toHaveText("First: when can we start?")
  await expect(items.nth(1).getByTestId("message-body")).toHaveText("Second: also, what about weekends?")

  // Posting never moves the submission's status — purely informational,
  // per issue #110's own non-goal ("not a second way to approve or reject").
  await expect(page.getByTestId("status-pill")).toHaveAttribute("data-status", "in-progress")

  // Durable: still there after a reload.
  await page.reload()
  await expect(page.getByTestId("message-item")).toHaveCount(2)
})

test("a blank message is not sent, and the composer is redisplayed with an error", async ({
  page,
  request,
}) => {
  const email = uniqueEmail("e2e-blank-message")
  const seeded = await seedSubmission(page, email)
  await pushInProgress(request, seeded.reference)
  await page.goto(seeded.url)

  await page.getByTestId("message-field").evaluate((el) => el.removeAttribute("required"))
  await page.getByTestId("submit-message").click()

  await expect(page).toHaveURL(seeded.url)
  await expect(page.getByTestId("message-error")).toHaveText("Write a message before sending.")
  await expect(page.getByTestId("message-item")).toHaveCount(0)
})

test("GET and POST /submissions/:id stay a 404 for an operator — #110 does not reopen ms-1's ownership scoping", async ({
  browser,
  baseURL,
}) => {
  const customerEmail = uniqueEmail("e2e-operator-blocked")
  await seedPromotedLead(browser, baseURL, customerEmail)

  // Find the submission's own URL from the customer's side, then try it as
  // the operator — the one identity `readOperator` recognises but
  // `isOwnedBy` never does.
  const customerContext = await contextFor(browser, baseURL, customerEmail)
  const customerPage = await customerContext.newPage()
  await customerPage.goto("/submissions")
  const submissionHref = await customerPage.getByTestId("submission-row").getAttribute("href")
  await customerContext.close()
  if (!submissionHref) throw new Error("customer dashboard produced no submission row")

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const getResponse = await operatorContext.request.get(submissionHref)
  expect(getResponse.status()).toBe(404)

  const postResponse = await operatorContext.request.post(submissionHref, {
    form: { action: "message", body: "an operator trying to speak as the customer" },
  })
  expect(postResponse.status()).toBe(404)

  await operatorContext.close()
})

test("an operator posts a message from a promoted lead's own screen, and it appears on both sides", async ({
  browser,
  baseURL,
  request,
}) => {
  const customerEmail = uniqueEmail("e2e-operator-message")
  const { leadUrl, submissionReference } = await seedPromotedLead(browser, baseURL, customerEmail)
  // Off `describing` so the customer's own `/submissions/:id` renders the
  // thread at all — see `pushInProgress`'s comment.
  await pushInProgress(request, submissionReference)

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()
  await operator.goto(leadUrl)

  await expect(operator.getByTestId("message-thread")).toBeVisible()
  await operator.getByTestId("message-field").fill("Thanks for the booking request — a few questions.")
  await operator.getByTestId("submit-message").click()
  await expect(operator).toHaveURL(leadUrl)

  const operatorItem = operator.getByTestId("message-item")
  await expect(operatorItem).toHaveCount(1)
  await expect(operatorItem.getByTestId("message-author")).toHaveText("You")
  await expect(operatorItem.getByTestId("message-body")).toHaveText(
    "Thanks for the booking request — a few questions.",
  )
  await operatorContext.close()

  // The customer reads the same message on their own submission screen, and
  // it is attributed to the business, never to the operator's own address.
  const customerContext = await contextFor(browser, baseURL, customerEmail)
  const customer = await customerContext.newPage()
  await customer.goto("/submissions")
  await customer.getByTestId("submission-row").click()
  await expect(customer.getByTestId("message-item")).toHaveCount(1)
  await expect(customer.getByTestId("message-author")).toHaveText("Heuron Technology")
  await expect(customer.getByTestId("message-author")).not.toContainText(DEV_OPERATOR)
  await expect(customer.getByTestId("message-body")).toHaveText(
    "Thanks for the booking request — a few questions.",
  )

  // The customer replies from their own screen; the operator reads it back
  // labelled with the customer's own address, not "You".
  await customer.getByTestId("message-field").fill("Sure — happy to answer.")
  await customer.getByTestId("submit-message").click()
  await customerContext.close()

  const recheckContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const recheck = await recheckContext.newPage()
  await recheck.goto(leadUrl)
  const items = recheck.getByTestId("message-item")
  await expect(items).toHaveCount(2)
  await expect(items.nth(1).getByTestId("message-author")).toHaveText(customerEmail)
  await expect(items.nth(1).getByTestId("message-body")).toHaveText("Sure — happy to answer.")
  await recheckContext.close()
})

test("a lead nobody has promoted yet offers no message thread, and POST /leads/:id/message 404s", async ({
  browser,
  baseURL,
}) => {
  const summary = `A synthetic unpromoted lead for e2e message-thread coverage (${nonce()}).`
  const strangerContext = await contextFor(browser, baseURL, null)
  const stranger = await strangerContext.newPage()
  await stranger.goto("/start")
  await stranger.getByTestId("field-lead-summary").fill(summary)
  await stranger.getByTestId("field-lead-email").fill(uniqueEmail("e2e-unpromoted"))
  await settleBotGate(stranger)
  await stranger.getByTestId("submit-lead").click()
  await expect(stranger.getByTestId("lead-receipt")).toBeVisible()
  await strangerContext.close()

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()
  await operator.goto("/leads")
  await operator.getByTestId("lead-row").filter({ hasText: summary }).getByTestId("review-lead").click()
  const leadUrl = operator.url()

  await expect(operator.getByTestId("message-thread")).toHaveCount(0)
  await expect(operator.getByTestId("message-form")).toHaveCount(0)

  const response = await operatorContext.request.post(`${leadUrl}/message`, {
    form: { body: "a message with nowhere to go" },
  })
  expect(response.status()).toBe(404)

  await operatorContext.close()
})
