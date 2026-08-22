import { expect, test, type Browser, type Page } from "@playwright/test"

/**
 * Black-box coverage for issue #145 ([portal] A submission can only be
 * reassigned from its lead — so one that came via /intake never can), driving
 * the real Worker under `wrangler dev` — see `playwright.config.ts`. This is
 * the project's own `e2e/` tier, not the sealed acceptance suite under
 * `tests/acceptance/`; per CLAUDE.md this repo still ships its own black-box
 * coverage for behaviour-changing work.
 *
 * #130 (`e2e/reassign.spec.ts`) already proves the reassignment mechanic
 * itself — same-client scoping, idempotency, the bridge event. This file
 * proves only what #145 adds: a **second** entry point onto that same
 * mechanic, `GET`/`POST /requests/:id` (`src/routes/requests.ts`), reachable
 * for a submission that was never promoted from a lead at all — the case
 * `POST /leads/:id/reassign` structurally cannot serve, because there is no
 * lead id to hang the route on.
 *
 * Every address and string below is invented, on the reserved `example.test`
 * TLD — CLAUDE.md rule 1.
 */

const DEV_OPERATOR = "ops@example.test"

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
  id: string
  reference: string
}

/**
 * Files a standalone request through `POST /intake` — no `?from=`, so it gets
 * no lead, no project and (per `createSubmission`) no client link of any
 * kind. This is exactly issue #145's motivating case: "a customer who is
 * already onboarded files follow-up work through `/intake`". The 303 this
 * redirects to (`/submissions/:id`) is where both the internal id and the
 * customer-visible reference are read from — no separate lookup needed.
 */
async function fileStandaloneRequest(page: Page, email: string, tag: string): Promise<Seeded> {
  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": email })
  await page.goto("/intake")
  await page.getByTestId("field-outcome").fill(`A synthetic no-lead outcome (${tag}).`)
  await page.getByTestId("field-audience").fill("synthetic e2e readers")
  await page.getByTestId("field-done-definition").fill("The #145 e2e suite goes green.")
  await page.getByTestId("submit-intake").click()
  await expect(page.getByTestId("intake-receipt")).toBeVisible()

  const id = new URL(page.url()).pathname.replace(/^\/submissions\//, "")
  const reference = (await page.getByTestId("submission-reference").innerText())
    .trim()
    .replace(/^Reference\s+/, "")
  return { id, reference }
}

/** Open the no-JS disclosure the way an operator does — mirrors `e2e/reassign.spec.ts`. */
async function openReassign(page: Page) {
  await expect(page.getByTestId("reassign-open-button")).toBeVisible()
  await page.getByTestId("reassign-open-button").click()
  await expect(page.getByTestId("reassign-form")).toBeVisible()
}

test("a submission with no lead has no reassignment control anywhere on /leads, but does on /requests", async ({
  browser,
  baseURL,
}) => {
  const tag = Math.random().toString(36).slice(2, 10)
  const email = uniqueEmail("e2e-no-lead")

  const customerContext = await contextFor(browser, baseURL, email)
  const customer = await customerContext.newPage()
  const seeded = await fileStandaloneRequest(customer, email, tag)
  await customerContext.close()

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()

  // The negative half of #145's own framing: `/intake` never creates a lead
  // (only the public `/start` form does), so there is no lead row for this
  // address at all, and therefore no id an operator could find on `/leads`
  // to reach `/leads/:id/reassign` through.
  await operator.goto("/leads")
  await expect(operator.getByTestId("lead-row").filter({ hasText: email })).toHaveCount(0)

  // The positive half: `/requests` shows it, links to it, and the detail
  // screen offers the same reassignment panel #130 built.
  await operator.goto("/requests")
  const row = operator.getByTestId("request-row").filter({ hasText: seeded.reference })
  await expect(row).toHaveCount(1)
  await row.getByTestId("request-reassign-link").click()
  await expect(new URL(operator.url()).pathname).toBe(`/requests/${seeded.id}`)
  await expect(operator.getByTestId("request-detail")).toBeVisible()
  await expect(operator.getByTestId("request-detail-reference")).toHaveText(seeded.reference)

  // No client has ever matched this address, so there is nothing to offer but
  // a brand-new project — the same "nothing to offer but a new project" state
  // `reassignSection` renders for a genuinely single-project client.
  await openReassign(operator)
  await expect(operator.getByTestId("reassign-project-option")).toHaveCount(0)
  await expect(operator.getByTestId("reassign-project-option-new")).toHaveCount(1)
  await expect(operator.getByTestId("reassign-current-project")).toHaveText(
    "Not yet in a project of its own",
  )

  await operatorContext.close()
})

test("reassigning a lead-less submission from /requests moves it, and a later follow-up from the same address offers that project back", async ({
  browser,
  baseURL,
}) => {
  const tag = Math.random().toString(36).slice(2, 10)
  const email = uniqueEmail("e2e-no-lead-move")

  const customerContext = await contextFor(browser, baseURL, email)
  const customer = await customerContext.newPage()
  const first = await fileStandaloneRequest(customer, email, `${tag}-first`)

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()

  await operator.goto(`/requests/${first.id}`)
  await openReassign(operator)
  await operator.getByTestId("reassign-project-option-new").click()
  await operator.getByTestId("reassign-submit").click()
  await expect(new URL(operator.url()).pathname, "reassignment redirects back to its own screen").toBe(
    `/requests/${first.id}`,
  )

  await openReassign(operator)
  await expect(
    operator.getByTestId("reassign-current-project"),
    "the submission now sits in the project this reassignment just minted",
  ).not.toHaveText("Not yet in a project of its own")

  // A second, later, still-standalone request from the identical address —
  // exactly issue #145's "already onboarded customer files a follow-up
  // through /intake" case. It has no project of its own (no `?from=`), but
  // the client the first reassignment minted now matches its address, so the
  // project the first submission moved into is offered as a sibling here.
  const second = await fileStandaloneRequest(customer, email, `${tag}-second`)
  await customerContext.close()

  await operator.goto(`/requests/${second.id}`)
  await openReassign(operator)
  await expect(
    operator.getByTestId("reassign-project-option"),
    "the client this address now resolves to has exactly one prior project on offer",
  ).toHaveCount(1)

  await operatorContext.close()
})

test("a stranger and a non-operator cannot see or use /requests/:id", async ({ browser, baseURL }) => {
  const tag = Math.random().toString(36).slice(2, 10)
  const email = uniqueEmail("e2e-no-lead-guard")

  const customerContext = await contextFor(browser, baseURL, email)
  const customer = await customerContext.newPage()
  const seeded = await fileStandaloneRequest(customer, email, tag)
  await customerContext.close()

  for (const identity of [email, null]) {
    const context = await contextFor(browser, baseURL, identity)
    const getResponse = await context.request.get(`/requests/${seeded.id}`)
    expect(getResponse.status(), `GET /requests/:id as ${identity ?? "nobody"}`).toBe(404)

    const postResponse = await context.request.post(`/requests/${seeded.id}/reassign`, {
      form: { projectChoice: "new" },
      maxRedirects: 0,
      failOnStatusCode: false,
    })
    expect(postResponse.status(), `POST /requests/:id/reassign as ${identity ?? "nobody"}`).toBe(
      404,
    )
    await context.close()
  }

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const unknown = await operatorContext.request.get("/requests/sub_does_not_exist_e2e")
  expect(unknown.status()).toBe(404)
  await operatorContext.close()
})
