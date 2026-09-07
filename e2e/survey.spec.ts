import { expect, test, type APIRequestContext, type Page } from "@playwright/test"

/**
 * Black-box coverage for issue #328 (ask the customer how we did when a
 * project ships), driving the real Worker under `wrangler dev` with real
 * local D1 — see `playwright.config.ts`. This is the project's own `e2e/`
 * tier, not the sealed acceptance suite under `tests/acceptance/`; per
 * CLAUDE.md this repo still ships its own coverage for behaviour-changing
 * work.
 *
 * SCOPE, per the issue:
 *   - the button renders only once the submission is `shipped`, never before;
 *   - submitting a rating (with or without a comment) records a response and
 *     the same screen then shows it back, with no button and no edit path;
 *   - a second attempt at the same submission is refused, not overwritten.
 *
 * This is capture-only, same as the issue: nothing here exercises an
 * operator-facing view of a response — that surface does not exist yet, by
 * design (the sibling issue this one explicitly is not).
 *
 * Every string below is invented — see CLAUDE.md rule 1.
 */

const SERVICE_TOKEN = {
  "CF-Access-Client-Id": "c47af0e3b96d1852704fce8a1b6d93f7.access",
  "CF-Access-Client-Secret":
    "2a7d5e91c04b6f3872e0adf51c9b4763081ed6a4c3f0b78d2a5e961c4083f7a",
}

/**
 * `serve:test` does not wipe `.wrangler/state` between runs (see the note in
 * `e2e/bridge.spec.ts`), so identities are tagged unique per run rather than
 * risking a row another run left behind.
 */
function uniqueEmail(local: string): string {
  const tag = Math.random().toString(36).slice(2, 10)
  return `${local}-${tag}@example.test`
}

interface Seeded {
  url: string
  id: string
  reference: string
}

async function seedSubmission(page: Page, email: string): Promise<Seeded> {
  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": email })
  await page.goto("/intake")
  await page.getByTestId("field-outcome").fill("A synthetic outcome for e2e survey coverage.")
  await page.getByTestId("field-audience").fill("synthetic e2e readers")
  await page.getByTestId("field-done-definition").fill("The survey e2e suite goes green.")
  await page.getByTestId("submit-intake").click()
  await expect(page.getByTestId("intake-receipt")).toBeVisible()

  const reference = (await page.getByTestId("submission-reference").innerText())
    .trim()
    .replace(/^Reference\s+/, "")
  const url = page.url()
  return { url, id: url.split("/submissions/")[1] ?? "", reference }
}

async function push(
  request: APIRequestContext,
  reference: string,
  revision: number,
  fields: Record<string, unknown>,
): Promise<{ outcome: string; reason?: string }> {
  const res = await request.post("/api/bridge/push", {
    data: { updates: [{ submission_id: reference, revision, fields }] },
    headers: SERVICE_TOKEN,
  })
  expect(res.status()).toBe(200)
  const body = (await res.json()) as { results: Array<{ outcome: string; reason?: string }> }
  const result = body.results[0]
  if (!result) throw new Error("push produced no result")
  return result
}

async function shipIt(request: APIRequestContext, reference: string, revision = 1): Promise<void> {
  const result = await push(request, reference, revision, { status: "shipped" })
  expect(result.outcome).toBe("applied")
}

test("the survey button does not appear before shipped", async ({ page, request }) => {
  const seeded = await seedSubmission(page, uniqueEmail("e2e-survey-early"))
  const result = await push(request, seeded.reference, 1, { status: "in-progress" })
  expect(result.outcome).toBe("applied")
  await page.goto(seeded.url)

  await expect(page.getByTestId("submission-detail")).toHaveAttribute("data-status", "in-progress")
  await expect(page.getByTestId("survey-open-button")).toHaveCount(0)
  await expect(page.getByTestId("survey-response")).toHaveCount(0)
})

test("submitting a rating and comment on shipped renders the response back, with no edit path", async ({
  page,
  request,
}) => {
  const ownerEmail = uniqueEmail("e2e-survey-submit")
  const seeded = await seedSubmission(page, ownerEmail)
  await shipIt(request, seeded.reference)
  await page.goto(seeded.url)

  await expect(page.getByTestId("submission-detail")).toHaveAttribute("data-status", "shipped")
  await expect(page.getByTestId("survey-open-button")).toBeVisible()
  await expect(page.getByTestId("survey-response")).toHaveCount(0)

  await page.getByTestId("survey-open-button").click()
  await expect(page.getByTestId("survey-form")).toBeVisible()
  await page.locator('[data-testid="survey-rating-option"][data-value="5"] input').check()
  await page.getByTestId("survey-comment").fill("Exactly what we needed, thank you.")
  await page.getByTestId("survey-submit").click()

  await expect(page).toHaveURL(seeded.url)
  await expect(page.getByTestId("survey-response")).toBeVisible()
  await expect(page.getByTestId("survey-response")).toHaveAttribute("data-rating", "5")
  await expect(page.getByTestId("survey-thanks")).toBeVisible()
  await expect(page.getByTestId("survey-response-comment")).toHaveText(
    "Exactly what we needed, thank you.",
  )
  // No button, no form, no edit path back onto the screen that just answered.
  await expect(page.getByTestId("survey-open-button")).toHaveCount(0)
  await expect(page.getByTestId("survey-form")).toHaveCount(0)

  // A reload reads the stored response back the same way — this is not a
  // one-time flash tied to the redirect.
  await page.goto(seeded.url)
  await expect(page.getByTestId("survey-response")).toHaveAttribute("data-rating", "5")
})

test("a rating with no comment is a complete response", async ({ page, request }) => {
  const ownerEmail = uniqueEmail("e2e-survey-norating")
  const seeded = await seedSubmission(page, ownerEmail)
  await shipIt(request, seeded.reference)
  await page.goto(seeded.url)

  await page.getByTestId("survey-open-button").click()
  await page.locator('[data-testid="survey-rating-option"][data-value="3"] input').check()
  await page.getByTestId("survey-submit").click()

  await expect(page).toHaveURL(seeded.url)
  await expect(page.getByTestId("survey-response")).toHaveAttribute("data-rating", "3")
  await expect(page.getByTestId("survey-response-comment")).toHaveCount(0)
})

test("a second attempt at the same submission is refused, not recorded as a new response", async ({
  page,
  request,
}) => {
  const ownerEmail = uniqueEmail("e2e-survey-second")
  const seeded = await seedSubmission(page, ownerEmail)
  await shipIt(request, seeded.reference)
  await page.goto(seeded.url)

  await page.getByTestId("survey-open-button").click()
  await page.locator('[data-testid="survey-rating-option"][data-value="4"] input').check()
  await page.getByTestId("survey-submit").click()
  await expect(page.getByTestId("survey-response")).toHaveAttribute("data-rating", "4")

  // Same shape `preview-review.spec.ts` uses for a doubled verdict: a direct
  // second POST of the same action, refused with 409 rather than silently
  // overwriting the first response.
  const doubled = await request.post(seeded.url, {
    form: { action: "survey", rating: "1", comment: "trying to change my mind" },
    headers: { "Cf-Access-Authenticated-User-Email": ownerEmail },
  })
  expect(doubled.status()).toBe(409)

  await page.goto(seeded.url)
  await expect(page.getByTestId("survey-response")).toHaveAttribute("data-rating", "4")
  await expect(page.getByTestId("survey-response-comment")).toHaveCount(0)
})

test("submitting with no rating chosen reopens the composer with an error, and records nothing", async ({
  page,
  request,
}) => {
  const ownerEmail = uniqueEmail("e2e-survey-blank")
  const seeded = await seedSubmission(page, ownerEmail)
  await shipIt(request, seeded.reference)

  // A real browser refuses to submit the radio group at all without a
  // selection (every input carries `required`) — that proves nothing about
  // the server, so this drives the POST directly instead.
  const res = await request.post(seeded.url, {
    form: { action: "survey", comment: "no rating chosen" },
    headers: { "Cf-Access-Authenticated-User-Email": ownerEmail },
  })
  expect(res.status()).toBe(400)
  const body = await res.text()
  expect(body).toContain("Choose a rating before sending.")

  await page.goto(seeded.url)
  await expect(page.getByTestId("survey-open-button")).toBeVisible()
  await expect(page.getByTestId("survey-response")).toHaveCount(0)
})
