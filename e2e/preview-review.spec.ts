import { expect, test, type APIRequestContext, type Page } from "@playwright/test"

/**
 * Black-box coverage for issue #107 ([portal] Staging/preview approval gate
 * before shipped), driving the real Worker under `wrangler dev` with real
 * local D1 — see `playwright.config.ts`. This is the project's own `e2e/`
 * tier, not the sealed acceptance suite under `tests/acceptance/`; per
 * CLAUDE.md this repo still ships its own coverage for behaviour-changing
 * work.
 *
 * SCOPE. Before merge, on the PR's own preview — not production:
 *
 *   quality-check (+ preview_url) -> the real build, Approve / Request changes
 *     approve         -> preview.approved event; nothing moves by itself —
 *                         the operator's merge and eventual `shipped` push are
 *                         separate, manual steps this issue does not automate.
 *     request changes -> preview.changes_requested event, with a comment;
 *                         the screen reads `In progress` (derived, never
 *                         stored — `status` stays coord-owned).
 *
 * `preview_url` is coord-owned and arrives over the bridge, exactly like
 * `status`; the verdict is portal-owned and leaves as a bridge event, exactly
 * the split issue #13's design-round loop already draws. Nothing on this side
 * ever writes `submissions.status`.
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
  await page.getByTestId("field-outcome").fill("A synthetic outcome for e2e preview-review coverage.")
  await page.getByTestId("field-audience").fill("synthetic e2e readers")
  await page.getByTestId("field-done-definition").fill("The preview-review e2e suite goes green.")
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

const PREVIEW_URL = "https://synthetic-preview.example.test/build-42"

/** Queues a preview build and moves the submission to quality-check, as the operator would. */
async function publishPreview(
  request: APIRequestContext,
  reference: string,
  revision: number,
  previewUrl: string = PREVIEW_URL,
): Promise<void> {
  const result = await push(request, reference, revision, {
    preview_url: previewUrl,
    status: "quality-check",
  })
  expect(result.outcome).toBe("applied")
}

interface BridgeEvent {
  id: string
  revision: number
  type: string
  submission_id: string
  occurred_at: string
  payload: Record<string, unknown>
}

async function pullAll(
  request: APIRequestContext,
  cursor?: string,
): Promise<{ events: BridgeEvent[]; cursor: string }> {
  const events: BridgeEvent[] = []
  let next = cursor
  for (let attempt = 0; attempt < 50; attempt++) {
    const params: Record<string, string> = { limit: "200" }
    if (next) params["cursor"] = next
    const res = await request.get("/api/bridge/pull", { params, headers: SERVICE_TOKEN })
    expect(res.status()).toBe(200)
    const body = (await res.json()) as { events: BridgeEvent[]; cursor: string; has_more: boolean }
    events.push(...body.events)
    next = body.cursor
    if (!body.has_more) return { events, cursor: next }
  }
  throw new Error("the stream never drained — the cursor is not advancing")
}

test("a queued preview renders the pinned quality-check review screen", async ({ page, request }) => {
  const seeded = await seedSubmission(page, uniqueEmail("e2e-preview"))
  await publishPreview(request, seeded.reference, 1)
  await page.goto(seeded.url)

  await expect(page.getByTestId("submission-detail")).toHaveAttribute("data-status", "quality-check")
  await expect(page.getByTestId("status-pill")).toHaveText("Quality check")
  await expect(page.getByTestId("preview-review")).toHaveAttribute("data-verdict", "pending")
  await expect(page.getByTestId("preview-link")).toHaveAttribute("href", PREVIEW_URL)
  await expect(page.getByTestId("approve-preview-button")).toBeVisible()
  await expect(page.getByTestId("request-preview-changes-button")).toBeVisible()

  // The design-round loop's own affordances must not leak onto this screen.
  await expect(page.getByTestId("approve-button")).toHaveCount(0)
  await expect(page.getByTestId("design-round")).toHaveCount(0)
})

test("quality-check with no preview queued yet falls back to the read-only rollup card", async ({
  page,
  request,
}) => {
  const seeded = await seedSubmission(page, uniqueEmail("e2e-noqc"))
  const result = await push(request, seeded.reference, 1, { status: "quality-check" })
  expect(result.outcome).toBe("applied")
  await page.goto(seeded.url)

  await expect(page.getByTestId("submission-detail")).toHaveAttribute("data-status", "quality-check")
  await expect(page.getByTestId("preview-review")).toHaveCount(0)
  await expect(page.getByTestId("approve-preview-button")).toHaveCount(0)
  await expect(page.getByTestId("rollup-copy")).toBeVisible()
})

test("a github.com preview link is dropped rather than stored — the wall stays the wall", async ({
  page,
  request,
}) => {
  const seeded = await seedSubmission(page, uniqueEmail("e2e-wall"))
  const result = await push(request, seeded.reference, 1, {
    preview_url: "https://github.com/example/repo/pull/9",
    status: "quality-check",
  })
  // The push is still applied — an unusable preview link is not a reason to
  // bounce a whole update that also legitimately carries `status`.
  expect(result.outcome).toBe("applied")
  await page.goto(seeded.url)

  await expect(page.getByTestId("submission-detail")).toHaveAttribute("data-status", "quality-check")
  await expect(page.getByTestId("preview-review")).toHaveCount(0)
  await expect(page.getByTestId("preview-link")).toHaveCount(0)
})

test("approving emits preview.approved and does not move the submission by itself", async ({
  page,
  request,
}) => {
  const ownerEmail = uniqueEmail("e2e-approve")
  const seeded = await seedSubmission(page, ownerEmail)
  const before = await pullAll(request)
  await publishPreview(request, seeded.reference, 1)
  await page.goto(seeded.url)

  await page.getByTestId("approve-preview-button").click()

  await expect(page).toHaveURL(seeded.url)
  // Still quality-check — approving a preview is not the design round's
  // "moves past sign-off toward Planned". The operator's merge is separate.
  await expect(page.getByTestId("submission-detail")).toHaveAttribute("data-status", "quality-check")
  await expect(page.getByTestId("status-pill")).toHaveText("Quality check")
  await expect(page.getByTestId("approve-preview-button")).toHaveCount(0)
  await expect(page.getByTestId("request-preview-changes-button")).toHaveCount(0)
  await expect(page.getByTestId("preview-review")).toHaveCount(0)

  const after = await pullAll(request, before.cursor)
  const approved = after.events.filter(
    (event) => event.submission_id === seeded.reference && event.type === "preview.approved",
  )
  expect(approved).toHaveLength(1)
  expect(approved[0]?.payload["verdict"]).toBe("approved")
  expect(approved[0]?.payload["preview_url"]).toBe(PREVIEW_URL)

  // Idempotent against a doubled submit: pressing approve again finds nothing
  // pending (409, the same "already decided" refusal `submitSignoff` gives)
  // rather than emitting a second event.
  const doubled = await request.post(seeded.url, {
    form: { action: "approve-preview" },
    headers: { "Cf-Access-Authenticated-User-Email": ownerEmail },
  })
  expect(doubled.status()).toBe(409)

  const stillJustOne = await pullAll(request, before.cursor)
  expect(
    stillJustOne.events.filter(
      (event) => event.submission_id === seeded.reference && event.type === "preview.approved",
    ),
  ).toHaveLength(1)
})

test("requesting changes opens In progress, with a comment, and rejects a blank one", async ({
  page,
  request,
}) => {
  const seeded = await seedSubmission(page, uniqueEmail("e2e-changes"))
  const before = await pullAll(request)
  await publishPreview(request, seeded.reference, 1)
  await page.goto(seeded.url)

  // A real browser honours `required` and refuses to submit a blank comment —
  // proves nothing about the server, so the attribute is removed first.
  await page.getByTestId("request-preview-changes-button").click()
  await expect(page.getByTestId("request-preview-changes-form")).toBeVisible()
  await page.getByTestId("preview-comment").evaluate((el) => el.removeAttribute("required"))
  await page.getByTestId("submit-preview-changes").click()

  // Nothing recorded — still the pending review screen.
  await expect(page.getByTestId("submission-detail")).toHaveAttribute("data-status", "quality-check")
  await expect(page.getByTestId("preview-review")).toHaveAttribute("data-verdict", "pending")
  await expect(page.getByTestId("request-preview-changes-form")).toBeVisible()

  await page
    .getByTestId("preview-comment")
    .fill("The header wraps on a phone — please fix before this ships.")
  await page.getByTestId("submit-preview-changes").click()

  await expect(page).toHaveURL(seeded.url)
  // Derived, never stored — `status` is still coord's `quality-check`.
  await expect(page.getByTestId("submission-detail")).toHaveAttribute("data-status", "in-progress")
  await expect(page.getByTestId("status-pill")).toHaveText("In progress")
  await expect(page.getByTestId("preview-review")).toHaveCount(0)

  const after = await pullAll(request, before.cursor)
  const requested = after.events.filter(
    (event) => event.submission_id === seeded.reference && event.type === "preview.changes_requested",
  )
  expect(requested).toHaveLength(1)
  expect(requested[0]?.payload["comment"]).toBe(
    "The header wraps on a phone — please fix before this ships.",
  )
})

test("a fresh preview_url reopens a pending review after changes were requested", async ({
  page,
  request,
}) => {
  const seeded = await seedSubmission(page, uniqueEmail("e2e-reopen"))
  await publishPreview(request, seeded.reference, 1, PREVIEW_URL)
  await page.goto(seeded.url)
  await page.getByTestId("request-preview-changes-button").click()
  await page.getByTestId("preview-comment").fill("Please fix the header before this ships.")
  await page.getByTestId("submit-preview-changes").click()
  await expect(page.getByTestId("status-pill")).toHaveText("In progress")

  // Operator pushes a fixed build under a new URL — pending again.
  const fixedUrl = "https://synthetic-preview.example.test/build-43"
  await publishPreview(request, seeded.reference, 2, fixedUrl)
  await page.goto(seeded.url)

  await expect(page.getByTestId("submission-detail")).toHaveAttribute("data-status", "quality-check")
  await expect(page.getByTestId("preview-review")).toHaveAttribute("data-verdict", "pending")
  await expect(page.getByTestId("preview-link")).toHaveAttribute("href", fixedUrl)
  await expect(page.getByTestId("approve-preview-button")).toBeVisible()
})

test("coord may never write the customer's preview verdict", async ({ page, request }) => {
  const seeded = await seedSubmission(page, uniqueEmail("e2e-owned"))
  await publishPreview(request, seeded.reference, 1)

  for (const field of ["preview_verdict", "preview_comment"]) {
    const res = await request.post("/api/bridge/push", {
      data: {
        updates: [{ submission_id: seeded.reference, revision: 2, fields: { [field]: "approved" } }],
      },
      headers: SERVICE_TOKEN,
    })
    expect(res.status()).toBe(200)
    const body = (await res.json()) as { results: Array<{ outcome: string; reason?: string }> }
    expect(body.results[0]?.outcome).toBe("rejected")
    expect(body.results[0]?.reason).toBe(`not_owned:${field}`)
  }

  await page.goto(seeded.url)
  await expect(page.getByTestId("preview-review")).toHaveAttribute("data-verdict", "pending")
  await expect(page.getByTestId("approve-preview-button")).toBeVisible()
})

test("reaching quality-check with a preview sends exactly one preview-ready email, linking to the portal page", async ({
  page,
  request,
}) => {
  const email = uniqueEmail("e2e-notify")
  const seeded = await seedSubmission(page, email)
  await publishPreview(request, seeded.reference, 1)

  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": email })
  await expect
    .poll(
      async () => {
        await page.goto("/outbox")
        return page.getByTestId("email-preview").count()
      },
      { message: "the preview-ready email must be queued", timeout: 15_000 },
    )
    .toBe(1)

  const row = page.getByTestId("email-preview").first()
  await expect(row).toHaveAttribute("data-email-type", "preview-ready")
  const cta = row.getByTestId("email-cta")
  await expect(cta).toHaveAttribute("href", `/submissions/${seeded.id}`)
  // Never the raw preview URL directly — matches signoff-ready linking to the
  // portal page rather than a raw file.
  const bodyText = await row.getByTestId("email-body").innerText()
  expect(bodyText).not.toContain(PREVIEW_URL)
})
