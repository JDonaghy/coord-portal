import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test"

/**
 * Black-box coverage for issue #144 ([portal] Operator: no clients list, and
 * no way to see a client's projects), driving the real Worker under
 * `wrangler dev` with real local D1 — see `playwright.config.ts`. This is the
 * project's own `e2e/` tier, not the sealed acceptance suite under
 * `tests/acceptance/`; there is no sealed slice for this issue yet, so per
 * CLAUDE.md this repo ships its own black-box coverage for the two new
 * routes (`src/routes/clients.ts`), wired in `src/pages.ts`.
 *
 * SCOPE. Three things #144's own text calls out:
 *
 *   GATED     `/clients` and `/clients/:id` 404 for a non-operator, same
 *             indistinguishable 404 as `/leads` and `/deliveries`.
 *   UNSCOPED  `GET /clients` lists every client, with project and submission
 *             counts that reflect a client whose two promoted leads joined
 *             one project — the same scenario `e2e/lead-client-link.spec.ts`
 *             exercises for the promotion side of this.
 *   DRILL-IN  `GET /clients/:id` shows every project the client has, and
 *             under each project its submissions with reference, current
 *             (derived) status and current round — including a round the
 *             coordinator has actually published over the bridge, so the
 *             derivation under test is the real one (`derivedStatus`,
 *             `src/rounds.ts`), not just the stored `describing` default.
 *
 * Every address and string below is invented on the reserved `example.test`
 * TLD — CLAUDE.md rule 1. `serve:test` does not wipe `.wrangler/state`
 * between runs, so identities are tagged unique per run rather than risking
 * a row a previous run left behind.
 */

const ACCESS_HEADER = "Cf-Access-Authenticated-User-Email"

/** See `DEV_OPERATOR_EMAIL` in `src/operators.ts` — honoured only off Cloudflare's edge. */
const DEV_OPERATOR = "ops@example.test"

const TURNSTILE_FIELD = "cf-turnstile-response"

const SERVICE_TOKEN = {
  "CF-Access-Client-Id": "a17c5e93b04fd6812c39a7e0154bd83f.access",
  "CF-Access-Client-Secret":
    "9d2b6f80c1a34e57b0d8f26ce4913a75620dfb18e5934ca70f21b6d859eac3f",
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

/** Promotes the lead currently open on `operator`, and returns its new `SUB-XXXXXX` reference. */
async function promoteAndGetReference(operator: Page): Promise<string> {
  await operator.getByTestId("promote-button").click()
  await expect(operator.getByTestId("lead-detail")).toHaveAttribute("data-status", "promoted")
  const text = await operator.getByTestId("promoted-submission-reference").innerText()
  const reference = text.replace(/^Promoted to submission\s+/, "").trim()
  expect(reference).toMatch(/^SUB-/)
  return reference
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

test.describe("a non-operator", () => {
  test("/clients and /clients/:id both 404, same as /leads and /deliveries", async ({ page }) => {
    const email = `e2e-clients-customer-${nonce()}@example.test`
    await page.setExtraHTTPHeaders({ [ACCESS_HEADER]: email })

    const clientsResponse = await page.goto("/clients")
    expect(clientsResponse?.status()).toBe(404)

    const detailResponse = await page.goto("/clients/anything-at-all")
    expect(detailResponse?.status()).toBe(404)
  })

  test("nobody at all (no Access identity) also gets 404, same posture as /leads", async ({ page }) => {
    const response = await page.goto("/clients")
    expect(response?.status()).toBe(404)
  })
})

test.describe("the operator's client list and per-client project view", () => {
  test("a client with two promoted leads sharing one project: counts on /clients, project and submissions on /clients/:id", async ({
    browser,
    baseURL,
    request,
  }) => {
    const tag = nonce()
    const email = `e2e-clients-repeat-${tag}@example.test`
    const firstSummary = `A synthetic first booking for the clients screen (${tag}).`
    const secondSummary = `A synthetic follow-up for the clients screen (${tag}).`

    const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
    const operator = await operatorContext.newPage()

    // First lead: mints the client and "Project 1".
    await sendLeadAndOpen(browser, baseURL, operator, firstSummary, email)
    const firstReference = await promoteAndGetReference(operator)

    // Second lead, same email: joins the same client's existing project
    // (pre-selected) rather than starting a new one — see
    // `e2e/lead-client-link.spec.ts` for the promotion-side coverage of this
    // same match. This is what makes `/clients`' project/submission counts
    // (1 project, 2 submissions) worth asserting on, rather than trivially 1/1.
    await sendLeadAndOpen(browser, baseURL, operator, secondSummary, email)
    await expect(operator.getByTestId("client-match-card")).toBeVisible()
    const secondReference = await promoteAndGetReference(operator)

    // Publish a design round on the first submission, so /clients/:id has a
    // real (non-default) current status and round number to render, exactly
    // like a customer's own `/submissions/:id` or `/projects/:id` would.
    const pushResult = await push(request, firstReference, 1, {
      design_round: {
        outcome_definition: "A synthetic outcome definition for the clients e2e round.",
        decomposition: ["Step one", "Step two"],
      },
      status: "awaiting-signoff",
    })
    expect(pushResult.outcome).toBe("applied")

    // ── GET /clients ────────────────────────────────────────────────────
    await operator.goto("/clients")
    const row = operator.getByTestId("client-row").filter({ hasText: email })
    await expect(row, `exactly one client-row for ${email}`).toHaveCount(1)
    await expect(row.getByTestId("client-name")).toHaveText(email)
    await expect(row.getByTestId("client-email")).toHaveText(email)
    await expect(row.getByTestId("client-project-count")).toHaveText("1 project")
    await expect(row.getByTestId("client-submission-count")).toHaveText("2 submissions")

    await row.getByTestId("view-client").click()

    // ── GET /clients/:id ────────────────────────────────────────────────
    await expect(operator.getByTestId("client-detail-email")).toHaveText(email)
    await expect(operator.getByTestId("client-project")).toHaveCount(1)

    const submissionRows = operator.getByTestId("client-project-submission")
    await expect(submissionRows).toHaveCount(2)

    const firstRow = submissionRows.filter({ hasText: firstReference })
    await expect(firstRow.getByTestId("client-submission-reference")).toHaveText(firstReference)
    // `status: awaiting-signoff` with no verdict yet derives back to itself
    // (`derivedStatus`, `src/rounds.ts`) — "Awaiting your sign-off" is the
    // exact customer-visible text for it (`SUBMISSION_STATUS_TEXT`).
    await expect(firstRow.getByTestId("client-submission-status")).toHaveText(
      "Awaiting your sign-off",
    )
    await expect(firstRow.getByTestId("client-submission-round")).toHaveText("Round 1")

    const secondRow = submissionRows.filter({ hasText: secondReference })
    await expect(secondRow.getByTestId("client-submission-reference")).toHaveText(secondReference)
    await expect(secondRow.getByTestId("client-submission-status")).toHaveText("Describing")
    await expect(secondRow.getByTestId("client-submission-round")).toHaveText("No rounds yet")

    await operatorContext.close()
  })

  test("the operator nav reaches /clients from /leads and /deliveries", async ({ browser, baseURL }) => {
    const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
    const operator = await operatorContext.newPage()

    for (const path of ["/leads", "/deliveries"]) {
      await operator.goto(path)
      const navClients = operator.getByTestId("nav-clients")
      await expect(navClients).toBeVisible()
      await navClients.click()
      await expect(operator.getByTestId("nav-clients")).toHaveAttribute("aria-current", "page")
      expect(new URL(operator.url()).pathname).toBe("/clients")
    }

    await operatorContext.close()
  })
})
