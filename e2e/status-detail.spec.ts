import { expect, test, type Page } from "@playwright/test"

/**
 * Black-box coverage for issue #10 ([portal] Up-mapping read model — customer
 * status vocabulary + precedence + business-time On-hold), driving the real
 * Worker under `wrangler dev` — see `playwright.config.ts`. This is the
 * project's own `e2e/` tier, not the sealed acceptance suite under
 * `tests/acceptance/`; per CLAUDE.md this repo still ships its own coverage
 * for behaviour-changing work.
 *
 * SCOPE. #10 rolls engineer-side state up into a fixed nine-word customer
 * vocabulary and renders it: a shared read-only rollup template for the four
 * non-actionable, non-terminal states, dedicated templates for `on-hold` and
 * `shipped`, and — deliberately — nothing that asks the customer for anything
 * on the two actionable states yet (`awaiting-signoff`, `needs-input`), since
 * the sign-off round and the question thread are #13's and #11's surfaces.
 * `status` only ever moves over the sync bridge (#15), so it is used here as
 * the instrument, exactly as the sealed slice does.
 *
 * Every string below is invented — see CLAUDE.md rule 1.
 */

const SERVICE_TOKEN = {
  "CF-Access-Client-Id": "a1c9f27e64bd48709c2ee15fa38b06d4.access",
  "CF-Access-Client-Secret":
    "9e2b4c718fa03d6e5b192c7ad84f603ea1b7d5c092f4e6a83c1907bd5e2a4f6",
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

async function seedSubmission(page: Page, email: string): Promise<{ url: string; reference: string }> {
  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": email })
  await page.goto("/intake")
  await page.getByTestId("field-outcome").fill("A synthetic outcome for e2e status-detail coverage.")
  await page.getByTestId("field-audience").fill("synthetic e2e readers")
  await page.getByTestId("field-done-definition").fill("The status-detail e2e suite goes green.")
  await page.getByTestId("submit-intake").click()
  await expect(page.getByTestId("intake-receipt")).toBeVisible()

  const reference = (await page.getByTestId("submission-reference").innerText())
    .trim()
    .replace(/^Reference\s+/, "")
  return { url: page.url(), reference }
}

async function pushStatus(
  request: import("@playwright/test").APIRequestContext,
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

test("the four rollup states render one shared timeline template", async ({ page, request }) => {
  const email = uniqueEmail("e2e-rollup")
  const seeded = await seedSubmission(page, email)

  let revision = 1
  for (const status of ["in-design", "planned", "in-progress", "quality-check"]) {
    await pushStatus(request, seeded.reference, status, revision++)
    await page.goto(seeded.url)

    const detail = page.getByTestId("submission-detail")
    await expect(detail).toHaveAttribute("data-status", status)
    await expect(page.getByTestId("status-pill")).toHaveAttribute("data-status", status)

    await expect(page.getByTestId("status-timeline")).toBeVisible()
    await expect(page.getByTestId("rollup-copy")).toBeVisible()
    await expect(page.locator('[data-testid="timeline-step"][data-current="true"]')).toHaveCount(1)

    // No demand affordance leaks into a read-only rollup screen.
    await expect(page.getByTestId("approve-button")).toHaveCount(0)
    await expect(page.getByTestId("pause-banner")).toHaveCount(0)
  }
})

test("on-hold renders the pinned copy and asks the customer for nothing", async ({ page, request }) => {
  const email = uniqueEmail("e2e-onhold")
  const seeded = await seedSubmission(page, email)

  await pushStatus(request, seeded.reference, "on-hold", 1)
  await page.goto(seeded.url)

  await expect(page.getByTestId("status-pill")).toHaveText("On hold")
  await expect(page.getByTestId("status-pill")).toHaveAttribute("data-status", "on-hold")
  await expect(page.getByTestId("onhold-copy")).toBeVisible()
  await expect(page.getByTestId("approve-button")).toHaveCount(0)
  await expect(page.getByTestId("question-thread")).toHaveCount(0)
})

test("on-hold renders a pushed onhold_since verbatim, ISO-8601 and all", async ({ page, request }) => {
  const email = uniqueEmail("e2e-onhold-since")
  const seeded = await seedSubmission(page, email)

  await pushStatus(request, seeded.reference, "on-hold", 1)

  const res = await request.post("/api/bridge/push", {
    data: {
      updates: [
        {
          submission_id: seeded.reference,
          revision: 2,
          fields: { onhold_since: "2026-08-04T09:12:00Z" },
        },
      ],
    },
    headers: SERVICE_TOKEN,
  })
  expect(res.status()).toBe(200)

  await page.goto(seeded.url)
  await expect(page.getByTestId("onhold-since")).toContainText("2026-08-04T09:12:00Z")
})

test("shipped is terminal and renders its own read-only copy", async ({ page, request }) => {
  const email = uniqueEmail("e2e-shipped")
  const seeded = await seedSubmission(page, email)

  await pushStatus(request, seeded.reference, "shipped", 1)
  await page.goto(seeded.url)

  await expect(page.getByTestId("status-pill")).toHaveText("Shipped")
  await expect(page.getByTestId("shipped-copy")).toBeVisible()
  await expect(page.getByTestId("shipped-link")).toBeVisible()
})

test("the two actionable states render the pinned pill and ask for nothing yet", async ({
  page,
  request,
}) => {
  const email = uniqueEmail("e2e-actionable")

  for (const [status, text] of [
    ["awaiting-signoff", "Awaiting your sign-off"],
    ["needs-input", "Needs your input"],
  ] as const) {
    const seeded = await seedSubmission(page, email)
    await pushStatus(request, seeded.reference, status, 1)
    await page.goto(seeded.url)

    await expect(page.getByTestId("submission-detail")).toHaveAttribute("data-status", status)
    await expect(page.getByTestId("status-pill")).toHaveText(text)
  }
})

test("no engineer-side value reaches the dashboard or the detail screen", async ({ page, request }) => {
  const email = uniqueEmail("e2e-closed-vocab")
  const seeded = await seedSubmission(page, email)

  const res = await request.post("/api/bridge/push", {
    data: {
      updates: [
        { submission_id: seeded.reference, revision: 1, fields: { status: "merge-conflict" } },
      ],
    },
    headers: SERVICE_TOKEN,
  })
  expect(res.status()).toBe(200)
  const body = (await res.json()) as { results: Array<{ outcome: string }> }
  expect(body.results[0]?.outcome).toBe("rejected")

  await page.goto(seeded.url)
  await expect(page.getByTestId("status-pill")).toHaveAttribute("data-status", "describing")

  await page.goto("/submissions")
  const row = page.getByTestId("submission-row").filter({ hasText: seeded.reference })
  await expect(row).toHaveAttribute("data-status", "describing")
})
