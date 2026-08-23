import { expect, test, type Browser, type Page } from "@playwright/test"

/**
 * Black-box coverage for issue #150 ([portal] Two addresses, one person: no
 * way to merge clients (or their projects) after the fact), driving the real
 * Worker under `wrangler dev` with real local D1 — see `playwright.config.ts`.
 * There is no sealed acceptance slice for this issue, so per CLAUDE.md this
 * repo ships its own black-box coverage for the one new route
 * (`POST /clients/:id/merge`, `src/routes/clients.ts`), wired in
 * `src/pages.ts`, and the write it makes (`mergeClients`, `src/clients.ts`).
 *
 * SCOPE. This is deliberately (1)-only, matching the issue's own scoping:
 *
 *   MOVE       merging client B into client A repoints every one of B's
 *              projects onto A, in the same request that marks B merged.
 *   PRESERVE   B's address survives on A (`cc_emails`) and is visible,
 *              structurally, as a "merged clients" entry — not lost, and not
 *              indistinguishable from an address a customer typed themselves.
 *   VISIBLE    a merged-away client's own page says so, links to the
 *              survivor, and stops offering the merge form or a project list;
 *              `/clients` badges it instead of silently dropping the row.
 *   REFUSED    self-merge, and a target that does not resolve to any client,
 *              are refused with a rendered error, not a silent no-op or a 500.
 *   GATED      the same indistinguishable-404 posture every other write on
 *              this operator surface takes (`e2e/reassign.spec.ts`,
 *              `e2e/project-naming.spec.ts`).
 *   IDEMPOTENT a doubled merge request converges on one merge, not two
 *              "merged clients" entries for the same address.
 *
 * This suite never asserts on `submissions.customer_email` or
 * `projects.customer_email` changing — the issue is explicit that a merge
 * must never rewrite either, because `isOwnedBy` (`src/routes/submission.ts`)
 * is an exact match against the former and rewriting it would lock a customer
 * out of what they filed under the merged-away address. There is nothing this
 * suite can assert to prove a silent non-event, so it instead asserts the
 * positive shape #150 actually pins: the project moves, the address is kept,
 * and the merge is visible.
 *
 * Every address and string below is invented on the reserved `example.test`
 * TLD — CLAUDE.md rule 1. `serve:test` does not wipe `.wrangler/state`
 * between runs, so identities are tagged unique per run rather than risking a
 * row a previous run left behind.
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

/**
 * Sends one lead through the public form and promotes it — the shortest path
 * to a `clients` row with exactly one project, which is all this suite's
 * merge scenarios start from. Returns the client's own `/clients/:id` path,
 * read off the `view-client` link `/clients` renders for it, never assumed
 * or parsed out of a redirect.
 */
async function seedClient(
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
  const leadRow = operator.getByTestId("lead-row").filter({ hasText: summary })
  await leadRow.getByTestId("review-lead").click()
  await operator.getByTestId("promote-button").click()
  await expect(operator.getByTestId("lead-detail")).toHaveAttribute("data-status", "promoted")

  return clientPathFor(operator, email)
}

/** `/clients/:id` for a given email, read off the live `/clients` list. */
async function clientPathFor(operator: Page, email: string): Promise<string> {
  await operator.goto("/clients")
  const row = operator.getByTestId("client-row").filter({ hasText: email })
  await expect(row, `exactly one client-row for ${email}`).toHaveCount(1)
  const href = await row.getByTestId("view-client").getAttribute("href")
  if (!href) throw new Error(`view-client link for ${email} has no href`)
  return href
}

test.describe("merging a duplicate client (issue #150)", () => {
  test("merges B into A: B's project moves, its address is preserved, and the merge is visible on both sides", async ({
    browser,
    baseURL,
  }) => {
    const tag = nonce()
    const emailA = `e2e-merge-a-${tag}@example.test`
    const emailB = `e2e-merge-b-${tag}@example.test`
    const summaryA = `A synthetic first-address booking for the merge e2e (${tag}).`
    const summaryB = `A synthetic second-address booking, same person, for the merge e2e (${tag}).`

    const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
    const operator = await operatorContext.newPage()

    const pathA = await seedClient(browser, baseURL, operator, summaryA, emailA)
    const pathB = await seedClient(browser, baseURL, operator, summaryB, emailB)

    // ── Merge B into A, from B's own page ──────────────────────────────────
    await operator.goto(pathB)
    await expect(operator.getByTestId("client-detail-email")).toHaveText(emailB)
    await operator.getByTestId("client-merge-email-input").fill(emailA)
    await operator.getByTestId("client-merge-submit").click()

    // A 303 back to the survivor's own page — never B's.
    expect(new URL(operator.url()).pathname).toBe(pathA)
    await expect(operator.getByTestId("client-detail-email")).toHaveText(emailA)

    // ── A now owns both projects ────────────────────────────────────────────
    await expect(operator.getByTestId("client-project")).toHaveCount(2)

    // ── B's address is preserved on A, and the merge is structurally visible
    //    — not just folded into cc_emails indistinguishably from a customer-
    //    entered CC address ──────────────────────────────────────────────────
    await expect(operator.getByTestId("client-detail-cc-emails")).toHaveText(emailB)
    const mergedFromRow = operator.getByTestId("client-merged-from-row")
    await expect(mergedFromRow).toHaveCount(1)
    await expect(mergedFromRow.getByTestId("client-merged-from-email")).toHaveText(emailB)

    // ── B's own page says it was merged, links to A, offers no merge form and
    //    no projects — everything moved ─────────────────────────────────────
    await operator.goto(pathB)
    await expect(operator.getByTestId("client-detail-email")).toHaveText(emailB)
    await expect(operator.getByTestId("client-merged-banner")).toBeVisible()
    const survivorLink = operator.getByTestId("client-merged-into-link")
    await expect(survivorLink).toHaveText(emailA)
    await expect(survivorLink).toHaveAttribute("href", pathA)
    await expect(operator.getByTestId("client-merge-form")).toHaveCount(0)
    await expect(operator.getByTestId("client-projects-empty")).toBeVisible()

    // ── /clients badges the merged-away row instead of silently dropping it ─
    await operator.goto("/clients")
    const rowB = operator.getByTestId("client-row").filter({ hasText: emailB })
    await expect(rowB.getByTestId("client-merged-badge")).toHaveText(`Merged into ${emailA}`)

    await operatorContext.close()
  })

  test("self-merge and a target that resolves to no client are both refused, with a rendered error", async ({
    browser,
    baseURL,
  }) => {
    const tag = nonce()
    const email = `e2e-merge-refuse-${tag}@example.test`
    const noSuchEmail = `e2e-merge-no-such-client-${tag}@example.test`
    const summary = `A synthetic booking for the merge-refusal e2e (${tag}).`

    const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
    const operator = await operatorContext.newPage()
    const path = await seedClient(browser, baseURL, operator, summary, email)

    await operator.goto(path)
    await operator.getByTestId("client-merge-email-input").fill(email)
    await operator.getByTestId("client-merge-submit").click()
    // The refusal re-renders the same client's page in place, at the form's
    // own `POST` action — never a redirect back to the `GET` path, and never
    // the survivor's page (there was no survivor here to redirect to).
    expect(new URL(operator.url()).pathname).toBe(`${path}/merge`)
    await expect(operator.getByTestId("client-merge-error")).toBeVisible()
    // Still itself, not merged away by its own refused request.
    await expect(operator.getByTestId("client-merged-banner")).toHaveCount(0)
    await expect(operator.getByTestId("client-project")).toHaveCount(1)

    await operator.getByTestId("client-merge-email-input").fill(noSuchEmail)
    await operator.getByTestId("client-merge-submit").click()
    // The refusal re-renders the same client's page in place, at the form's
    // own `POST` action — never a redirect back to the `GET` path, and never
    // the survivor's page (there was no survivor here to redirect to).
    expect(new URL(operator.url()).pathname).toBe(`${path}/merge`)
    await expect(operator.getByTestId("client-merge-error")).toBeVisible()
    await expect(operator.getByTestId("client-project")).toHaveCount(1)

    await operatorContext.close()
  })

  test("a stranger and a non-operator cannot merge anything, and a doubled merge request is idempotent", async ({
    browser,
    baseURL,
    request,
  }) => {
    const tag = nonce()
    const emailD = `e2e-merge-guard-d-${tag}@example.test`
    const emailE = `e2e-merge-guard-e-${tag}@example.test`
    const summaryD = `A synthetic guard-check booking D for the merge e2e (${tag}).`
    const summaryE = `A synthetic guard-check booking E for the merge e2e (${tag}).`

    const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
    const operator = await operatorContext.newPage()
    const pathD = await seedClient(browser, baseURL, operator, summaryD, emailD)
    const pathE = await seedClient(browser, baseURL, operator, summaryE, emailE)
    await operatorContext.close()

    const anonymous = await request.post(`${pathD}/merge`, {
      form: { intoEmail: emailE },
      maxRedirects: 0,
      failOnStatusCode: false,
    })
    expect(anonymous.status()).toBe(404)

    const nonOperator = await request.post(`${pathD}/merge`, {
      headers: { [ACCESS_HEADER]: `curious-${tag}@example.test` },
      form: { intoEmail: emailE },
      maxRedirects: 0,
      failOnStatusCode: false,
    })
    expect(nonOperator.status()).toBe(404)

    const unknownClient = await request.post("/clients/client_does_not_exist_e2e/merge", {
      headers: { [ACCESS_HEADER]: DEV_OPERATOR },
      form: { intoEmail: emailE },
      maxRedirects: 0,
      failOnStatusCode: false,
    })
    expect(unknownClient.status()).toBe(404)

    // Same request, twice — a retried or doubled submit.
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await request.post(`${pathD}/merge`, {
        headers: { [ACCESS_HEADER]: DEV_OPERATOR },
        form: { intoEmail: emailE },
        maxRedirects: 0,
        failOnStatusCode: false,
      })
      expect(res.status(), `merge attempt ${attempt + 1}`).toBe(303)
      expect(res.headers()["location"]).toBe(pathE)
    }

    const verifyContext = await contextFor(browser, baseURL, DEV_OPERATOR)
    const verifyPage = await verifyContext.newPage()
    await verifyPage.goto(pathE)
    // Exactly one entry, not two — the doubled request did not double the
    // "merged clients" record or the cc_emails append.
    await expect(verifyPage.getByTestId("client-merged-from-row")).toHaveCount(1)
    await verifyContext.close()
  })
})
