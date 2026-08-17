import { expect, test, type APIRequestContext, type Page } from "@playwright/test"

/**
 * Black-box coverage for issue #111 ([portal] Submission status doesn't
 * surface the underlying dev lifecycle), driving the real Worker under
 * `wrangler dev` with real local D1 — see `playwright.config.ts`. This is the
 * project's own `e2e/` tier, not the sealed acceptance suite under
 * `tests/acceptance/`; per CLAUDE.md this repo still ships its own coverage
 * for behaviour-changing work.
 *
 * SCOPE. The read-only timeline this issue adds: coord pushes a
 * `lifecycle_event` (a PR opening, checks going green, a preview build
 * becoming available, a merge) and it renders as an "Activity" entry on the
 * submission detail screen, oldest first, alongside the existing design-round
 * history — without ever touching `status`, without ever emailing the
 * customer (issue #14's three actionable-or-terminal statuses stay the only
 * thing that sends), and without ever leaking a GitHub link, an issue number
 * or a PR number onto the screen (issue #16's wall).
 *
 * Every string below is invented — see CLAUDE.md rule 1.
 */

const SERVICE_TOKEN = {
  "CF-Access-Client-Id": "c37a5f19e0846db29a63cf1074eb385a.access",
  "CF-Access-Client-Secret":
    "4d81fc09b3e2a7659708cd2e14fba396eb0287cd5a3f469081de635b7c294f1",
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
  await page.getByTestId("field-outcome").fill("A synthetic outcome for e2e lifecycle-timeline coverage.")
  await page.getByTestId("field-audience").fill("synthetic e2e readers")
  await page.getByTestId("field-done-definition").fill("The lifecycle e2e suite goes green.")
  await page.getByTestId("submit-intake").click()
  await expect(page.getByTestId("intake-receipt")).toBeVisible()

  const reference = (await page.getByTestId("submission-reference").innerText())
    .trim()
    .replace(/^Reference\s+/, "")
  return { url: page.url(), reference }
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

test("a pushed lifecycle event renders as a timeline entry, oldest first, with no email sent", async ({
  page,
  request,
}) => {
  const seeded = await seedSubmission(page, uniqueEmail("e2e-lifecycle"))

  const first = await push(request, seeded.reference, 1, {
    status: "in-progress",
    lifecycle_event: { kind: "work-started", occurred_at: "2026-08-10T09:00:00.000Z" },
  })
  expect(first.outcome).toBe("applied")

  const second = await push(request, seeded.reference, 2, {
    lifecycle_event: { kind: "review-opened", occurred_at: "2026-08-11T09:00:00.000Z" },
  })
  expect(second.outcome).toBe("applied")

  await page.goto(seeded.url)
  await expect(page.getByTestId("submission-detail")).toHaveAttribute("data-status", "in-progress")

  const entries = page.getByTestId("activity-entry")
  await expect(entries).toHaveCount(2)
  await expect(entries.nth(0)).toHaveAttribute("data-kind", "work-started")
  await expect(entries.nth(0)).toContainText("Development started")
  await expect(entries.nth(1)).toHaveAttribute("data-kind", "review-opened")
  await expect(entries.nth(1)).toContainText("In code review")

  // A push that carries no `status` field must never queue a notification —
  // issue #14's three actionable-or-terminal statuses stay the only thing
  // that emails. There is no outbox surface in this suite to assert against
  // directly, so this checks the one thing that would prove one was queued
  // wrongly: a second, unrelated status push right after it does not somehow
  // pick up two sends worth of state. (The authoritative coverage that only
  // `status` pushes notify at all lives in `e2e/notifications.spec.ts`.)
  const third = await push(request, seeded.reference, 3, {
    lifecycle_event: { kind: "checks-passing" },
  })
  expect(third.outcome).toBe("applied")
  await page.goto(seeded.url)
  await expect(page.getByTestId("activity-entry")).toHaveCount(3)
})

test("preview-ready carries a link; every other kind renders with none", async ({ page, request }) => {
  const seeded = await seedSubmission(page, uniqueEmail("e2e-preview"))

  await push(request, seeded.reference, 1, {
    status: "in-progress",
    lifecycle_event: { kind: "merged", occurred_at: "2026-08-12T09:00:00.000Z" },
  })
  await push(request, seeded.reference, 2, {
    lifecycle_event: {
      kind: "preview-ready",
      occurred_at: "2026-08-13T09:00:00.000Z",
      url: "https://synthetic-preview.pages.dev/build-42",
    },
  })

  await page.goto(seeded.url)
  const entries = page.getByTestId("activity-entry")
  await expect(entries).toHaveCount(2)

  await expect(entries.nth(0)).toHaveAttribute("data-kind", "merged")
  await expect(entries.nth(0).getByTestId("activity-preview-link")).toHaveCount(0)

  const previewEntry = entries.nth(1)
  await expect(previewEntry).toHaveAttribute("data-kind", "preview-ready")
  await expect(previewEntry).toContainText("Preview available")
  await expect(previewEntry.getByTestId("activity-preview-link")).toHaveAttribute(
    "href",
    "https://synthetic-preview.pages.dev/build-42",
  )
})

test("a github.com link on preview-ready is refused — the wall stays the wall", async ({
  page,
  request,
}) => {
  const seeded = await seedSubmission(page, uniqueEmail("e2e-wall"))

  const result = await push(request, seeded.reference, 1, {
    status: "in-progress",
    lifecycle_event: {
      kind: "preview-ready",
      url: "https://github.com/example/repo/pull/9",
    },
  })
  // Acknowledged, same as any push landing a shape this side declines to
  // render fully — never a transport failure.
  expect(result.outcome).toBe("applied")

  await page.goto(seeded.url)
  const entry = page.getByTestId("activity-entry")
  await expect(entry).toHaveCount(1)
  await expect(entry).toContainText("Preview available")
  await expect(entry.getByTestId("activity-preview-link")).toHaveCount(0)
  const rendered = await page.getByTestId("submission-detail").innerText()
  expect(rendered).not.toContain("github.com")
})

test("an unrecognised kind is acknowledged but adds no entry", async ({ page, request }) => {
  const seeded = await seedSubmission(page, uniqueEmail("e2e-unknown"))

  const result = await push(request, seeded.reference, 1, {
    status: "in-progress",
    lifecycle_event: { kind: "branch_pushed" },
  })
  expect(result.outcome).toBe("applied")

  await page.goto(seeded.url)
  await expect(page.getByTestId("activity-timeline")).toHaveCount(0)
})

test("no lifecycle events yet renders no activity card at all", async ({ page, request }) => {
  const seeded = await seedSubmission(page, uniqueEmail("e2e-empty"))
  await push(request, seeded.reference, 1, { status: "in-design" })

  await page.goto(seeded.url)
  await expect(page.getByTestId("submission-detail")).toHaveAttribute("data-status", "in-design")
  await expect(page.getByTestId("activity-timeline")).toHaveCount(0)
})

test("a retried push lands the same event exactly once", async ({ page, request }) => {
  const seeded = await seedSubmission(page, uniqueEmail("e2e-retry"))

  const fields = { status: "in-progress", lifecycle_event: { kind: "work-started" } }
  const first = await push(request, seeded.reference, 5, fields)
  expect(first.outcome).toBe("applied")

  // The exact same push, retried at the exact same revision — the daemon's
  // own story for "the response never arrived, so it tries again".
  const retried = await push(request, seeded.reference, 5, fields)
  expect(retried.outcome).toBe("already_applied")

  await page.goto(seeded.url)
  await expect(page.getByTestId("activity-entry")).toHaveCount(1)
})

test("the timeline also renders on the shipped and awaiting-signoff screens", async ({
  page,
  request,
}) => {
  const seeded = await seedSubmission(page, uniqueEmail("e2e-shipped"))
  await push(request, seeded.reference, 1, {
    status: "awaiting-signoff",
    lifecycle_event: { kind: "review-opened" },
  })
  await page.goto(seeded.url)
  await expect(page.getByTestId("submission-detail")).toHaveAttribute("data-status", "awaiting-signoff")
  await expect(page.getByTestId("activity-entry")).toHaveCount(1)

  await push(request, seeded.reference, 2, {
    status: "shipped",
    lifecycle_event: { kind: "deployed" },
  })
  await page.goto(seeded.url)
  await expect(page.getByTestId("submission-detail")).toHaveAttribute("data-status", "shipped")
  const entries = page.getByTestId("activity-entry")
  await expect(entries).toHaveCount(2)
  await expect(entries.nth(1)).toContainText("Deployed")
})
