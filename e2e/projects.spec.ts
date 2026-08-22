import { expect, test, type Page } from "@playwright/test"

/**
 * Black-box coverage for issue #109 ([portal] the project entity above
 * submissions), driving the real Worker under `wrangler dev` — see
 * `playwright.config.ts`. This is the project's own `e2e/` tier, not the
 * sealed acceptance suite under `tests/acceptance/`; per CLAUDE.md this repo
 * still ships its own coverage for behaviour-changing work.
 *
 * SCOPE. #109 adds `projects`, the entity a submission optionally belongs to
 * once a customer explicitly files a follow-up from an existing submission's
 * own detail screen ("Start a follow-up", rendered only on `shipped` —
 * `routes/submission.ts`). `/submissions` groups a customer's own rows by
 * project when one exists and falls back to today's flat list otherwise;
 * `/projects/:id` combines every grouped submission's round history into one
 * timeline.
 *
 * Two submissions filed independently through the ordinary `/intake` "New
 * request" path are deliberately *not* grouped — inferring a shared project
 * from a matching `customer_email` alone would break the sealed suite's own
 * "the dashboard lists only the caller's own submissions" expectation of two
 * separate rows (`tests/acceptance/ms-1/12-access-auth.spec.ts`, which this
 * repo must never edit) — so this file covers that non-grouping explicitly,
 * not just the grouped case.
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

async function seedSubmission(
  page: Page,
  email: string,
  outcome: string,
): Promise<{ url: string; id: string; reference: string }> {
  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": email })
  await page.goto("/intake")
  await page.getByTestId("field-outcome").fill(outcome)
  await page.getByTestId("field-audience").fill("synthetic e2e readers")
  await page.getByTestId("field-done-definition").fill("The projects e2e suite goes green.")
  await page.getByTestId("submit-intake").click()
  await expect(page.getByTestId("intake-receipt")).toBeVisible()

  const reference = (await page.getByTestId("submission-reference").innerText())
    .trim()
    .replace(/^Reference\s+/, "")
  const url = page.url()
  const id = url.split("/submissions/")[1] ?? ""
  return { url, id, reference }
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

/**
 * Ships a first submission, pushes it to `shipped`, then files a follow-up
 * from its own detail screen via the "Start a follow-up" link — the one path
 * that ever creates a project (issue #109).
 */
async function createProject(
  page: Page,
  request: import("@playwright/test").APIRequestContext,
  email: string,
): Promise<{
  projectId: string
  first: { id: string; reference: string }
  second: { id: string; reference: string }
}> {
  const first = await seedSubmission(page, email, "A first-round outcome for the projects e2e test.")
  await pushStatus(request, first.reference, "shipped", 1)

  await page.goto(first.url)
  const followUp = page.getByTestId("start-follow-up")
  await expect(followUp).toBeVisible()
  await followUp.click()

  await expect(page).toHaveURL(new RegExp(`/intake\\?from=${first.id}$`))
  await expect(page.getByTestId("follow-up-note")).toContainText(first.reference)

  await page.getByTestId("field-outcome").fill("A second-round outcome, following up on the first.")
  await page.getByTestId("field-audience").fill("synthetic e2e readers")
  await page.getByTestId("field-done-definition").fill("The followup renders on one combined timeline.")
  await page.getByTestId("submit-intake").click()
  await expect(page.getByTestId("intake-receipt")).toBeVisible()

  const secondUrl = page.url()
  const second = {
    id: secondUrl.split("/submissions/")[1] ?? "",
    reference: (await page.getByTestId("submission-reference").innerText())
      .trim()
      .replace(/^Reference\s+/, ""),
  }

  await page.goto("/submissions")
  const projectRow = page.getByTestId("project-row")
  await expect(projectRow).toHaveCount(1)
  const href = await projectRow.getAttribute("href")
  const projectId = (href ?? "").split("/projects/")[1] ?? ""
  expect(projectId).not.toBe("")

  return { projectId, first: { id: first.id, reference: first.reference }, second }
}

test("a follow-up filed from a shipped submission groups both into one project row", async ({
  page,
  request,
}) => {
  const email = uniqueEmail("e2e-followup")
  const { first, second } = await createProject(page, request, email)

  await page.goto("/submissions")
  // Grouped: one project row standing in for both, no separate submission rows.
  await expect(page.getByTestId("submission-row")).toHaveCount(0)
  const projectRow = page.getByTestId("project-row")
  await expect(projectRow).toHaveCount(1)
  await expect(projectRow).toContainText("2 requests")
  // The newest member (the follow-up) is what the row's own reference names.
  await expect(projectRow).toContainText(second.reference)
  await expect(projectRow).not.toContainText(first.reference)
})

test("the project's combined view lists both submissions' own histories", async ({ page, request }) => {
  const email = uniqueEmail("e2e-timeline")
  const { projectId, first, second } = await createProject(page, request, email)

  await page.goto(`/projects/${projectId}`)
  await expect(page.getByTestId("project-detail")).toBeVisible()

  const blocks = page.getByTestId("project-submission")
  await expect(blocks).toHaveCount(2)

  const blockText = await blocks.allInnerTexts()
  expect(blockText.some((text) => text.includes(first.reference))).toBe(true)
  expect(blockText.some((text) => text.includes(second.reference))).toBe(true)

  // Newest first, same ordering the dashboard and every other list in this
  // portal use.
  await expect(blocks.first()).toContainText(second.reference)

  // The shipped first round still reads "Shipped" inside the combined view,
  // not silently rolled into whatever status the follow-up carries.
  await expect(blocks.last()).toContainText("Shipped")
})

test("a project 404s for anyone other than the customer it belongs to", async ({ page, request }) => {
  const owner = uniqueEmail("e2e-owner")
  const { projectId } = await createProject(page, request, owner)

  const stranger = uniqueEmail("e2e-stranger")
  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": stranger })
  const response = await page.goto(`/projects/${projectId}`)
  expect(response?.status()).toBe(404)
})

test("two submissions filed independently through /intake stay two separate rows, not a project", async ({
  page,
}) => {
  const email = uniqueEmail("e2e-nogroup")
  const first = await seedSubmission(page, email, "An independent first request, unrelated to any other.")
  const second = await seedSubmission(page, email, "A second, equally independent request.")

  await page.goto("/submissions")
  await expect(page.getByTestId("project-row")).toHaveCount(0)
  const rows = page.getByTestId("submission-row")
  await expect(rows).toHaveCount(2)

  const rowText = await rows.allInnerTexts()
  expect(rowText.some((text) => text.includes(first.reference))).toBe(true)
  expect(rowText.some((text) => text.includes(second.reference))).toBe(true)
})

/**
 * Issue #146: a follow-up's own project is resolved inside the transaction
 * that creates it (`projectAssignmentForFollowUp`, `src/projects.ts`), so
 * neither submission's `submission.created` event can carry it — see
 * `createSubmission` in `src/submissions.ts`. This is the bridge-level proof
 * that both submissions still converge on the truth afterward, over a
 * `submission.project_assigned` event, rather than staying pinned to the
 * `project_id: null` their own creation event necessarily shipped.
 */
interface BridgeEvent {
  type: string
  submission_id: string
  payload: Record<string, unknown>
}

interface PullPage {
  events: BridgeEvent[]
  cursor: string
  has_more: boolean
}

async function pull(
  request: import("@playwright/test").APIRequestContext,
  cursor?: string,
): Promise<PullPage> {
  const params: Record<string, string> = { limit: "200" }
  if (cursor) params["cursor"] = cursor
  const res = await request.get("/api/bridge/pull", { params, headers: SERVICE_TOKEN })
  expect(res.status()).toBe(200)
  return (await res.json()) as PullPage
}

/** Reads to the end of the stream and returns the cursor that sits past it. */
async function drain(request: import("@playwright/test").APIRequestContext): Promise<string> {
  let cursor: string | undefined
  for (let page = 0; page < 50; page++) {
    const body = await pull(request, cursor)
    cursor = body.cursor
    if (!body.has_more) return body.cursor
  }
  throw new Error("the stream never drained — the cursor is not advancing")
}

/** Everything on the stream after `cursor`, following `has_more` to the end. */
async function collectFrom(
  request: import("@playwright/test").APIRequestContext,
  cursor: string,
): Promise<BridgeEvent[]> {
  const events: BridgeEvent[] = []
  let next = cursor
  for (let page = 0; page < 50; page++) {
    const body = await pull(request, next)
    events.push(...body.events)
    next = body.cursor
    if (!body.has_more) return events
  }
  throw new Error("the stream never drained — the cursor is not advancing")
}

test("a follow-up's project id converges over the bridge, for both submissions (#146)", async ({
  page,
  request,
}) => {
  const start = await drain(request)
  const email = uniqueEmail("e2e-bridge-followup")
  const { projectId, first, second } = await createProject(page, request, email)

  const events = (await collectFrom(request, start)).filter(
    (event) => event.submission_id === first.reference || event.submission_id === second.reference,
  )

  const createdFor = (reference: string) =>
    events.find((e) => e.submission_id === reference && e.type === "submission.created")
  const assignedFor = (reference: string) =>
    events.filter((e) => e.submission_id === reference && e.type === "submission.project_assigned")

  // Neither creation event could have known the project yet.
  expect(createdFor(first.reference)?.payload["project_id"]).toBeNull()
  expect(createdFor(second.reference)?.payload["project_id"]).toBeNull()

  // Exactly one correction each, carrying the project the follow-up minted —
  // the origin's fires because this is the *first* follow-up filed against
  // it (`origin.projectId === null` before this request ran); the follow-up's
  // own fires because its own creation event could never carry it at all.
  const firstAssigned = assignedFor(first.reference)
  const secondAssigned = assignedFor(second.reference)
  expect(firstAssigned).toHaveLength(1)
  expect(secondAssigned).toHaveLength(1)
  expect(firstAssigned[0]?.payload["project_id"]).toBe(projectId)
  expect(secondAssigned[0]?.payload["project_id"]).toBe(projectId)

  // Neither submission here was ever matched to a `clients` row — that only
  // happens through lead promotion (`e2e/lead-client-link.spec.ts` covers it).
  expect(firstAssigned[0]?.payload["client_id"]).toBeNull()
  expect(secondAssigned[0]?.payload["client_id"]).toBeNull()
})
