import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test"

/**
 * Black-box coverage for issue #104 ([portal] An operator can see every lead
 * and every delivery, but only their own submissions), driving the real
 * Worker under `wrangler dev` with real local D1 — see `playwright.config.ts`.
 * This is the project's own `e2e/` tier, not the sealed acceptance suite
 * under `tests/acceptance/`; per CLAUDE.md this repo still ships its own
 * black-box coverage for behaviour-changing work, and `GET /requests`
 * (`src/routes/requests.ts`, wired in `src/pages.ts`) had none before this
 * file.
 *
 * WHAT THIS FILE PROVES, the same three things `e2e/deliveries.spec.ts`
 * proves for issue #55's `/deliveries` — the precedent #104 itself names:
 *
 *   UNSCOPED   `GET /requests` lists every customer's submissions on one
 *              screen. `GET /submissions` (issue #12) is ownership-scoped to
 *              the caller's own Access identity and structurally cannot.
 *   GATED      the exact same indistinguishable 404 `/leads` and
 *              `/deliveries` return for anyone `readOperator` rejects — an
 *              ordinary customer, or nobody at all — never a 403 and never a
 *              redirect.
 *   UNCHANGED  `GET /submissions` still shows a customer only their own rows,
 *              never another customer's, even once that other customer's
 *              submission is showing up on `/requests`.
 *
 * Plus the one thing this screen adds beyond a plain list: the current design
 * round and its verdict, read off the same submission `/submissions/:id`
 * would derive a status from — issue #104's own "current round and verdict"
 * requirement.
 *
 * Every address and string below is invented, on the reserved `example.test`
 * TLD — CLAUDE.md rule 1. `serve:test` does not wipe `.wrangler/state`
 * between runs, so identities are tagged unique per run rather than risking a
 * row a previous run left behind.
 */

const DEV_OPERATOR = "ops@example.test"

const SERVICE_TOKEN = {
  "CF-Access-Client-Id": "a4d1f8c936b0e75218fa63d0c9e17b4a.access",
  "CF-Access-Client-Secret":
    "9e3b7c410fd6285ab13e0c964d8f27a5b619cde3f082a5c17604b9d2e8f31ac",
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
}

async function seedSubmission(page: Page, email: string, tag: string): Promise<Seeded> {
  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": email })
  await page.goto("/intake")
  await page
    .getByTestId("field-outcome")
    .fill(`A synthetic outcome for e2e requests coverage (${tag}).`)
  await page.getByTestId("field-audience").fill("synthetic e2e readers")
  await page.getByTestId("field-done-definition").fill("The requests e2e suite goes green.")
  await page.getByTestId("submit-intake").click()
  await expect(page.getByTestId("intake-receipt")).toBeVisible()

  const reference = (await page.getByTestId("submission-reference").innerText())
    .trim()
    .replace(/^Reference\s+/, "")
  return { reference }
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

function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

interface RequestRow {
  status: string | null
  customer: string
  reference: string
  pillText: string
  round: string | null
}

/** The one `request-row` on `/requests` whose `request-reference` is `reference`. */
async function readRequestRow(operator: Page, reference: string): Promise<RequestRow> {
  await operator.goto("/requests")
  const row = operator.getByTestId("request-row").filter({ hasText: reference })
  await expect(row, `exactly one request-row for ${reference}`).toHaveCount(1)

  const round = row.getByTestId("request-round")
  return {
    status: await row.getAttribute("data-status"),
    customer: flat(await row.getByTestId("request-customer").innerText()),
    reference: flat(await row.getByTestId("request-reference").innerText()),
    pillText: flat(await row.getByTestId("status-pill").innerText()),
    round: (await round.count()) > 0 ? flat(await round.innerText()) : null,
  }
}

test("the operator's /requests lists every customer's submissions on one screen — /submissions stays scoped to its own caller", async ({
  browser,
  baseURL,
}) => {
  const aliceEmail = uniqueEmail("e2e-requests-alice")
  const bobEmail = uniqueEmail("e2e-requests-bob")

  const aliceContext = await contextFor(browser, baseURL, aliceEmail)
  const alicePage = await aliceContext.newPage()
  const alice = await seedSubmission(alicePage, aliceEmail, "alice")

  const bobContext = await contextFor(browser, baseURL, bobEmail)
  const bobPage = await bobContext.newPage()
  const bob = await seedSubmission(bobPage, bobEmail, "bob")

  // A design round, published and awaiting sign-off, on Bob's submission only
  // — this is issue #104's "current round and verdict" requirement: the
  // screen must surface it, not just the plain status.
  const roundResult = await push(bobContext.request, bob.reference, 1, {
    design_round: {
      outcome_definition: "A synthetic outcome definition for e2e requests coverage.",
      decomposition: ["A synthetic first step", "A synthetic second step"],
    },
    status: "awaiting-signoff",
  })
  expect(roundResult.outcome).toBe("applied")

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()

  // The operator surface itself: the shared operator header, marked current —
  // same "reuse the /leads precedent" issue #104 explicitly follows.
  await operator.goto("/requests")
  await expect(operator.getByTestId("identity-email")).toHaveText(`signed in as ${DEV_OPERATOR}`)
  await expect(operator.getByTestId("nav-requests")).toHaveAttribute("aria-current", "page")

  const aliceRow = await readRequestRow(operator, alice.reference)
  expect(aliceRow.status).toBe("describing")
  expect(aliceRow.customer).toBe(aliceEmail)
  expect(aliceRow.round, "a submission with no design round shows no round badge").toBeNull()

  const bobRow = await readRequestRow(operator, bob.reference)
  expect(bobRow.status).toBe("awaiting-signoff")
  expect(bobRow.pillText).toBe("Awaiting your sign-off")
  expect(bobRow.customer).toBe(bobEmail)
  expect(bobRow.round).toContain("Round 1")
  expect(bobRow.round).toContain("Awaiting your sign-off")

  // /submissions is unchanged: each customer still sees only their own
  // reference, never the other's.
  await alicePage.goto("/submissions")
  await expect(alicePage.getByText(alice.reference)).toBeVisible()
  await expect(alicePage.getByText(bob.reference)).toHaveCount(0)

  await bobPage.goto("/submissions")
  await expect(bobPage.getByText(bob.reference)).toBeVisible()
  await expect(bobPage.getByText(alice.reference)).toHaveCount(0)

  await Promise.all([aliceContext.close(), bobContext.close(), operatorContext.close()])
})

test("the requests surface is a 404 to anyone who is not the operator, the same shape as a route that does not exist", async ({
  browser,
  baseURL,
}) => {
  const email = uniqueEmail("e2e-requests-hidden")

  const ownerContext = await contextFor(browser, baseURL, email)
  const ownerPage = await ownerContext.newPage()
  const seeded = await seedSubmission(ownerPage, email, "hidden-404")

  // The row's own owner, and nobody at all, both get a 404 — never a 403, and
  // never a redirect that would itself confirm an operator surface exists.
  for (const identity of [email, null]) {
    const context = await contextFor(browser, baseURL, identity)
    const response = await context.request.get("/requests")
    expect(response.status(), `GET /requests as ${identity ?? "nobody"}`).toBe(404)
    const body = await response.text()
    expect(body).toContain("We can't find that")
    expect(body).not.toContain(email)
    await context.close()
  }

  // Sanity: the row really is there, and the gate above — not a bug that
  // hides the whole route from everyone — is what stood in the way.
  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operatorResponse = await operatorContext.request.get("/requests")
  expect(operatorResponse.status()).toBe(200)
  expect(await operatorResponse.text()).toContain(seeded.reference)
  await operatorContext.close()

  await ownerContext.close()
})
