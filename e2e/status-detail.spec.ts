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
 * non-actionable, non-terminal states, a dedicated template for `shipped`,
 * and — deliberately — nothing that asks the customer for anything on the two
 * actionable states yet (`awaiting-signoff`, `needs-input`), since the
 * sign-off round and the question thread are #13's and #11's surfaces.
 * `status` only ever moves over the sync bridge (#15), so it is used here as
 * the instrument, exactly as the sealed slice does.
 *
 * `on-hold` has no template of its own (issue #74, Gate-A amendment, approved
 * 2026-08-14): it stays a valid stored status and bridge-push target, but the
 * customer-visible render collapses it into the same rollup template as
 * `in-progress` — `data-status="in-progress"`, pill text "In progress", no
 * `onhold-*` hook resolves anywhere.
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
  extraFields: Record<string, unknown> = {},
) {
  const res = await request.post("/api/bridge/push", {
    data: { updates: [{ submission_id: reference, revision, fields: { status, ...extraFields } }] },
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

test("on-hold collapses into the in-progress rollup and asks the customer for nothing", async ({
  page,
  request,
}) => {
  const email = uniqueEmail("e2e-onhold")
  const seeded = await seedSubmission(page, email)

  await pushStatus(request, seeded.reference, "on-hold", 1)
  await page.goto(seeded.url)

  const detail = page.getByTestId("submission-detail")
  await expect(detail).toHaveAttribute("data-status", "in-progress")
  await expect(page.getByTestId("status-pill")).toHaveText("In progress")
  await expect(page.getByTestId("status-pill")).toHaveAttribute("data-status", "in-progress")

  // The rollup template, not a dedicated on-hold screen.
  await expect(page.getByTestId("status-timeline")).toBeVisible()
  await expect(page.getByTestId("rollup-copy")).toBeVisible()

  // No trace of the deleted on-hold template's hooks.
  await expect(page.getByTestId("onhold-copy")).toHaveCount(0)
  await expect(page.getByTestId("onhold-since")).toHaveCount(0)
  await expect(page.getByTestId("onhold-provisional-note")).toHaveCount(0)

  await expect(page.getByTestId("approve-button")).toHaveCount(0)
  await expect(page.getByTestId("question-thread")).toHaveCount(0)
})

test("a pushed onhold_since still applies but resolves no onhold-* hook anywhere", async ({
  page,
  request,
}) => {
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
  const body = (await res.json()) as { results: Array<{ outcome: string }> }
  expect(body.results[0]?.outcome).toBe("applied")

  // The push still applies (on-hold and onhold_since stay coord-owned, valid
  // bridge targets, issue #74) but the portal has no surface left that reads
  // onhold_since — the collapsed rollup screen never mentions it.
  await page.goto(seeded.url)
  await expect(page.getByTestId("submission-detail")).toHaveAttribute("data-status", "in-progress")
  await expect(page.getByTestId("onhold-since")).toHaveCount(0)
})

test("shipped with a known preview_url renders a button that navigates to it", async ({
  page,
  request,
}) => {
  // Issue #307: the shipped screen's button used to be a hardcoded
  // `href="#"`, copied verbatim out of the Gate-A mock's placeholder. It
  // must now navigate to `submission.previewUrl` when the bridge has pushed
  // one — a dead button on the last screen a customer ever sees is worse
  // than none.
  const email = uniqueEmail("e2e-shipped")
  const seeded = await seedSubmission(page, email)
  const resultUrl = "https://synthetic-result.example.test/build-9"

  await pushStatus(request, seeded.reference, "shipped", 1, { preview_url: resultUrl })
  await page.goto(seeded.url)

  await expect(page.getByTestId("status-pill")).toHaveText("Shipped")
  await expect(page.getByTestId("shipped-copy")).toBeVisible()
  const link = page.getByTestId("shipped-link")
  await expect(link).toBeVisible()
  await expect(link).toHaveAttribute("href", resultUrl)
})

test("shipped with no known result URL renders explanatory text and no button", async ({
  page,
  request,
}) => {
  // The other half of #307: when the bridge has never pushed a
  // `preview_url`, the screen must not fall back to a dead link — it
  // renders text instead, and no `shipped-link` control at all.
  const email = uniqueEmail("e2e-shipped-no-url")
  const seeded = await seedSubmission(page, email)

  await pushStatus(request, seeded.reference, "shipped", 1)
  await page.goto(seeded.url)

  await expect(page.getByTestId("status-pill")).toHaveText("Shipped")
  await expect(page.getByTestId("shipped-copy")).toBeVisible()
  await expect(page.getByTestId("shipped-link")).toHaveCount(0)
  await expect(page.getByTestId("shipped-link-unavailable")).toBeVisible()

  // Never the mock's placeholder, anywhere on a customer-facing screen.
  const hrefs = await page.locator('a[href="#"]').count()
  expect(hrefs).toBe(0)
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
