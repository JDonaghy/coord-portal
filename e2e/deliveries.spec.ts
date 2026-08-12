import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test"

import { latestOutboxId, markOutboxFailed, markOutboxSent } from "./outbox-fixtures"

/**
 * Black-box coverage for issue #55 ([portal] The operator's delivery view —
 * every outbox row, not just the caller's own), driving the real Worker under
 * `wrangler dev` with real local D1 — see `playwright.config.ts`. This is the
 * project's own `e2e/` tier, not the sealed acceptance suite under
 * `tests/acceptance/`; per CLAUDE.md this repo still ships its own black-box
 * coverage for behaviour-changing work, and `GET /deliveries`
 * (`src/routes/deliveries.ts`, wired in `src/pages.ts`) plus its reader
 * (`listAllOutbox`, `src/notifications.ts`) had none before this file.
 *
 * WHAT THIS FILE PROVES that `e2e/leads.spec.ts` and `e2e/notifications.spec.ts`
 * do not already cover between them — the same three things issue #55's own
 * "Acceptance surface" names:
 *
 *   UNSCOPED   `GET /deliveries` lists every customer's outbox rows on one
 *              screen. `GET /outbox` (issue #14, extended by #49) is scoped to
 *              the caller's own Access identity and structurally cannot.
 *   GATED      the exact same indistinguishable 404 `/leads` (issue #33)
 *              returns for anyone `readOperator` rejects — an ordinary
 *              customer, or nobody at all — never a 403 and never a redirect.
 *   SEPARATE   a `failed` row's RAW provider `last_error` renders on
 *              `/deliveries` while `/outbox` still shows only the
 *              customer-safe copy — asserted on the SAME underlying row,
 *              which is what makes the separation real rather than
 *              incidental (issue #55's own words).
 *
 * `sent` and `failed` rows are produced the same way `e2e/notifications.spec.ts`
 * produces them for issue #49's own delivery-state rendering: `outbox-fixtures.ts`
 * shells out to `wrangler d1 execute --local`, scoped to one row's own id, to
 * move it past `queued` directly. #50's real cron drain (`GET /__scheduled`)
 * would work too — `e2e/drain.spec.ts` already exercises it — but that route
 * claims rows across the WHOLE table, not just this test's own, and that file
 * already documents (`test.describe.configure({ mode: "serial" })`) why it can
 * only make itself safe against ITS OWN parallel tests, not against a second
 * spec file also calling it. The row-scoped fixture sidesteps that risk
 * entirely and is exactly what this file needs: `/deliveries`' own rendering
 * under test, not the drain that is #50's business.
 *
 * Every address and string below is invented on the reserved `example.test`
 * TLD — CLAUDE.md rule 1. `serve:test` does not wipe `.wrangler/state` between
 * runs (see `e2e/notifications.spec.ts`'s own note), so identities are tagged
 * unique per run rather than risking a row a previous run left behind.
 */

const DEV_OPERATOR = "ops@example.test"

const SERVICE_TOKEN = {
  "CF-Access-Client-Id": "e91a4c7b3d6f0852a1eb4907c3d612f8.access",
  "CF-Access-Client-Secret":
    "6b2e0c9a17df4358b0c67ea4152d9f7038c165ae2fb804d13c6a09e754fdc12b",
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
    .fill(`A synthetic outcome for e2e deliveries coverage (${tag}).`)
  await page.getByTestId("field-audience").fill("synthetic e2e readers")
  await page.getByTestId("field-done-definition").fill("The deliveries e2e suite goes green.")
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

/**
 * Sends one submission through intake -> shipped, waits for the resulting
 * `queued` row to land in the customer's own `/outbox`, and hands back its
 * `outbox` id so a fixture can move it past `queued` — the same shape
 * `e2e/notifications.spec.ts` uses for issue #49's delivery-state tests.
 */
async function queueOne(page: Page, request: APIRequestContext, email: string, tag: string): Promise<string> {
  const target = await seedSubmission(page, email, tag)
  expect((await push(request, target.reference, 1, { status: "shipped" })).outcome).toBe("applied")

  await expect
    .poll(
      async () => {
        await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": email })
        await page.goto("/outbox")
        return page.getByTestId("email-preview").count()
      },
      { message: `${email} must have exactly one outbox row`, timeout: 15_000 },
    )
    .toBe(1)

  return latestOutboxId(email)
}

interface DeliveryRow {
  status: string | null
  subject: string
  pillText: string
  sentAt: string | null
  attempts: string | null
  lastError: string | null
}

/** The one `delivery-row` on `/deliveries` whose `delivery-recipient` is `email`. */
async function readDeliveryRow(operator: Page, email: string): Promise<DeliveryRow> {
  await operator.goto("/deliveries")
  const row = operator.getByTestId("delivery-row").filter({ hasText: email })
  await expect(row, `exactly one delivery-row for ${email}`).toHaveCount(1)

  const sentAt = row.getByTestId("delivery-sent-at")
  const attempts = row.getByTestId("delivery-attempts")
  const lastError = row.getByTestId("delivery-last-error")
  return {
    status: await row.getAttribute("data-status"),
    subject: flat(await row.getByTestId("delivery-subject").innerText()),
    pillText: flat(await row.getByTestId("delivery-status").innerText()),
    sentAt: (await sentAt.count()) > 0 ? flat(await sentAt.innerText()) : null,
    attempts: (await attempts.count()) > 0 ? flat(await attempts.innerText()) : null,
    lastError: (await lastError.count()) > 0 ? flat(await lastError.innerText()) : null,
  }
}

test("the operator's /deliveries lists every customer's rows across queued, sent and failed — /outbox stays scoped to its own caller and its customer-safe copy", async ({
  browser,
  baseURL,
}) => {
  const queuedEmail = uniqueEmail("e2e-deliveries-queued")
  const sentEmail = uniqueEmail("e2e-deliveries-sent")
  const failedEmail = uniqueEmail("e2e-deliveries-failed")
  const rawError = "Resend API returned 401"

  const queuedContext = await contextFor(browser, baseURL, queuedEmail)
  const queuedPage = await queuedContext.newPage()
  await queueOne(queuedPage, queuedContext.request, queuedEmail, "queued")

  const sentContext = await contextFor(browser, baseURL, sentEmail)
  const sentPage = await sentContext.newPage()
  const sentId = await queueOne(sentPage, sentContext.request, sentEmail, "sent")
  markOutboxSent(sentId, "2026-01-05T12:34:00Z", "provider-msg-e2e-deliveries")

  const failedContext = await contextFor(browser, baseURL, failedEmail)
  const failedPage = await failedContext.newPage()
  const failedId = await queueOne(failedPage, failedContext.request, failedEmail, "failed")
  markOutboxFailed(failedId, 3, rawError)

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()

  // The operator surface itself: the shared header, not the customer one, and
  // marked as the current screen — issue #55's "reuse the /leads precedent".
  await operator.goto("/deliveries")
  await expect(operator.getByTestId("identity-email")).toHaveText(`signed in as ${DEV_OPERATOR}`)
  await expect(operator.getByTestId("nav-deliveries")).toHaveAttribute("aria-current", "page")

  const queuedRow = await readDeliveryRow(operator, queuedEmail)
  expect(queuedRow.status).toBe("queued")
  expect(queuedRow.pillText).toBe("Queued")
  expect(queuedRow.sentAt, "a queued row shows no delivery time").toBeNull()
  expect(queuedRow.attempts, "a queued row shows no attempt count").toBeNull()
  expect(queuedRow.lastError, "a queued row shows no error").toBeNull()

  const sentRow = await readDeliveryRow(operator, sentEmail)
  expect(sentRow.status).toBe("sent")
  expect(sentRow.pillText).toBe("Sent")
  expect(sentRow.sentAt, "a sent row must say when it was delivered").not.toBeNull()
  expect(sentRow.attempts).toBeNull()
  expect(sentRow.lastError).toBeNull()

  const failedRow = await readDeliveryRow(operator, failedEmail)
  expect(failedRow.status).toBe("failed")
  expect(failedRow.pillText).toBe("Delivery failed")
  expect(failedRow.sentAt).toBeNull()
  expect(failedRow.attempts).toContain("3")
  // The one thing /outbox may never show: the raw provider string, verbatim.
  expect(failedRow.lastError).toBe(rawError)

  // /outbox is unchanged: each customer still sees only their own single row.
  await queuedPage.goto("/outbox")
  await expect(queuedPage.getByTestId("email-preview")).toHaveCount(1)
  await sentPage.goto("/outbox")
  await expect(sentPage.getByTestId("email-preview")).toHaveCount(1)

  // ...and on the SAME failed row the operator just read the raw string off
  // of, the customer's own screen shows only the customer-safe copy — never
  // the provider's identity or its error text. Asserting this on one row
  // shared by both reads is what makes the separation real, not incidental.
  await failedPage.goto("/outbox")
  const customerPreview = failedPage.getByTestId("email-preview")
  await expect(customerPreview).toHaveCount(1)
  const customerError = flat(await customerPreview.getByTestId("delivery-last-error").innerText())
  expect(customerError).not.toBe(rawError)
  expect(customerError).not.toContain(rawError)
  expect(customerError).not.toMatch(/resend/i)
  expect(customerError).not.toMatch(/\b401\b/)
  expect(customerError.length).toBeGreaterThan(0)

  await Promise.all([
    queuedContext.close(),
    sentContext.close(),
    failedContext.close(),
    operatorContext.close(),
  ])
})

test("the deliveries surface is a 404 to anyone who is not the operator, the same shape as a route that does not exist", async ({
  browser,
  baseURL,
}) => {
  const email = uniqueEmail("e2e-deliveries-hidden")

  const ownerContext = await contextFor(browser, baseURL, email)
  const ownerPage = await ownerContext.newPage()
  await queueOne(ownerPage, ownerContext.request, email, "hidden-404")

  // The row's own owner, and nobody at all, both get a 404 — never a 403, and
  // never a redirect that would itself confirm an operator surface exists.
  for (const identity of [email, null]) {
    const context = await contextFor(browser, baseURL, identity)
    const response = await context.request.get("/deliveries")
    expect(response.status(), `GET /deliveries as ${identity ?? "nobody"}`).toBe(404)
    const body = await response.text()
    expect(body).toContain("We can't find that")
    expect(body).not.toContain(email)
    await context.close()
  }

  // Sanity: the row really is there, and the gate above — not a bug that
  // hides the whole route from everyone — is what stood in the way.
  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operatorResponse = await operatorContext.request.get("/deliveries")
  expect(operatorResponse.status()).toBe(200)
  expect(await operatorResponse.text()).toContain(email)
  await operatorContext.close()

  await ownerContext.close()
})
