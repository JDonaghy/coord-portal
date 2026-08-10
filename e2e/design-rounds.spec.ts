import { expect, test, type APIRequestContext, type Page } from "@playwright/test"

/**
 * Black-box coverage for issue #13 ([portal] Design rounds + versioned sign-off
 * loop), driving the real Worker under `wrangler dev` with real local D1 — see
 * `playwright.config.ts`. This is the project's own `e2e/` tier, not the sealed
 * acceptance suite under `tests/acceptance/`; per CLAUDE.md this repo still
 * ships its own coverage for behaviour-changing work.
 *
 * SCOPE. The loop:
 *
 *   In design -> Awaiting sign-off -> (changes requested) -> In design -> ... -> Signed off
 *
 * A round's content is coord-owned and arrives over the bridge; the verdict is
 * portal-owned and leaves as a `signoff.approved` / `signoff.changes_requested`
 * event. Nothing on this side ever writes `submissions.status` — the return to
 * `In design` is derived (see `src/rounds.ts`), which is what the status
 * assertions below are really checking.
 *
 * Every string below is invented — see CLAUDE.md rule 1.
 */

const SERVICE_TOKEN = {
  "CF-Access-Client-Id": "b28f4c1e90a7d3652f8ba041cd97e236.access",
  "CF-Access-Client-Secret":
    "1f6ce3a90b4d752c81af06de394b27c5081fa6b3e29d47f0a2c6d8b91e457a3c",
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
  await page.getByTestId("field-outcome").fill("A synthetic outcome for e2e design-round coverage.")
  await page.getByTestId("field-audience").fill("synthetic e2e readers")
  await page.getByTestId("field-done-definition").fill("The design-round e2e suite goes green.")
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

interface RoundContent {
  outcome_definition: string
  decomposition: string[]
  mock_bundle?: string
}

/** Publishes a design round and asks for sign-off, in one push, as coord would. */
async function publishRound(
  request: APIRequestContext,
  reference: string,
  revision: number,
  round: RoundContent,
): Promise<void> {
  const result = await push(request, reference, revision, {
    design_round: round,
    status: "awaiting-signoff",
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

const ROUND_ONE: RoundContent = {
  outcome_definition: "Let a coordinator drop in a list of contacts and see them appear.",
  decomposition: ["An upload step with a preview", "Column mapping so headers need not match"],
  mock_bundle: "https://mocks.example.test/synthetic/round-1",
}

const ROUND_TWO: RoundContent = {
  outcome_definition:
    "Let a coordinator drop in a list of contacts and see them appear, with bad rows reported back.",
  decomposition: [
    "An upload step with a preview",
    "Column mapping so headers need not match",
    "A results screen listing exactly which rows failed and why",
  ],
  mock_bundle: "https://mocks.example.test/synthetic/round-2",
}

test("a published round renders the pinned awaiting-sign-off screen", async ({ page, request }) => {
  const seeded = await seedSubmission(page, uniqueEmail("e2e-round"))
  await publishRound(request, seeded.reference, 1, ROUND_ONE)
  await page.goto(seeded.url)

  await expect(page.getByTestId("submission-detail")).toHaveAttribute("data-status", "awaiting-signoff")
  await expect(page.getByTestId("status-pill")).toHaveText("Awaiting your sign-off")

  await expect(page.getByTestId("design-round")).toHaveAttribute("data-round", "1")
  await expect(page.getByTestId("design-round")).toHaveAttribute("data-verdict", "pending")
  await expect(page.getByTestId("round-number")).toHaveText("Round 1")
  await expect(page.getByTestId("outcome-definition")).toHaveText(ROUND_ONE.outcome_definition)
  await expect(page.getByTestId("decomposition-item")).toHaveCount(2)
  await expect(page.getByTestId("mock-bundle-link")).toHaveAttribute("href", ROUND_ONE.mock_bundle!)
  await expect(page.getByTestId("round-history-link")).toBeVisible()
  await expect(page.getByTestId("approve-button")).toBeVisible()
  await expect(page.getByTestId("request-changes-button")).toBeVisible()

  // #11's pause screen is a different surface and must not leak onto this one.
  await expect(page.getByTestId("pause-banner")).toHaveCount(0)
  await expect(page.getByTestId("answer-field")).toHaveCount(0)
})

test("a decomposition never shows an issue number, branch or agent identifier", async ({
  page,
  request,
}) => {
  const seeded = await seedSubmission(page, uniqueEmail("e2e-wall"))
  await publishRound(request, seeded.reference, 1, {
    outcome_definition: "Ship the importer, tracked in issue 412.",
    decomposition: [
      "An upload step with a preview (#412)",
      "Column mapping — see feat/csv-import",
      "Hand the final pass to agent-carla",
    ],
  })
  await page.goto(seeded.url)

  const rendered = await page.getByTestId("submission-detail").innerText()
  expect(rendered).not.toMatch(/#\d+/)
  expect(rendered).not.toMatch(/feat\//)
  expect(rendered).not.toMatch(/agent-/)
  expect(rendered).not.toMatch(/issue 412/i)
  // The work items themselves survive — the wall removes the identifier, not
  // the sentence around it.
  await expect(page.getByTestId("decomposition-item")).toHaveCount(3)
  await expect(page.getByTestId("decomposition-item").first()).toContainText(
    "An upload step with a preview",
  )
})

test("the request-changes composer opens and cancels without leaving the page", async ({
  page,
  request,
}) => {
  const seeded = await seedSubmission(page, uniqueEmail("e2e-composer"))
  await publishRound(request, seeded.reference, 1, ROUND_ONE)
  await page.goto(seeded.url)

  await expect(page.getByTestId("request-changes-form")).toBeHidden()

  await page.getByTestId("request-changes-button").click()
  await expect(page.getByTestId("request-changes-form")).toBeVisible()
  await expect(page.getByTestId("changes-comment")).toBeVisible()
  await expect(page.getByTestId("next-round-note")).toContainText("Round 2")
  // Same URL — the contract is explicit that the composer is not a distinct route.
  await expect(page).toHaveURL(seeded.url)

  await page.getByTestId("cancel-changes").click()
  await expect(page.getByTestId("request-changes-form")).toBeHidden()
  await expect(page.getByTestId("design-round")).toHaveAttribute("data-verdict", "pending")
})

test("requesting changes opens round N+1 and never mutates round N", async ({ page, request }) => {
  const seeded = await seedSubmission(page, uniqueEmail("e2e-loop"))
  const before = await pullAll(request)
  await publishRound(request, seeded.reference, 1, ROUND_ONE)
  await page.goto(seeded.url)

  await page.getByTestId("request-changes-button").click()
  await page
    .getByTestId("changes-comment")
    .fill("Tell me which rows failed — silently dropping them is worse than not having it.")
  await page.getByTestId("submit-changes").click()

  // Back to In design. The stored status is still coord's `awaiting-signoff` —
  // the portal owns no part of that column — but there is nothing left awaiting
  // this customer, so that is what the screen says.
  await expect(page).toHaveURL(seeded.url)
  await expect(page.getByTestId("submission-detail")).toHaveAttribute("data-status", "in-design")
  await expect(page.getByTestId("status-pill")).toHaveText("In design")
  await expect(page.getByTestId("approve-button")).toHaveCount(0)
  await expect(page.getByTestId("request-changes-button")).toHaveCount(0)

  // The verdict reached the coordinator, exactly once, replayably.
  const after = await pullAll(request, before.cursor)
  const decided = after.events.filter(
    (event) => event.submission_id === seeded.reference && event.type === "signoff.changes_requested",
  )
  expect(decided).toHaveLength(1)
  expect(decided[0]?.payload["round"]).toBe(1)
  const replay = await pullAll(request, before.cursor)
  expect(
    replay.events.filter(
      (event) =>
        event.submission_id === seeded.reference && event.type === "signoff.changes_requested",
    )[0]?.id,
  ).toBe(decided[0]?.id)

  // Coord answers with the next round. It is round 2 — round 1 keeps its own
  // content and its own verdict.
  await publishRound(request, seeded.reference, 2, ROUND_TWO)
  await page.goto(seeded.url)
  await expect(page.getByTestId("design-round")).toHaveAttribute("data-round", "2")
  await expect(page.getByTestId("outcome-definition")).toHaveText(ROUND_TWO.outcome_definition)
  await expect(page.getByTestId("decomposition-item")).toHaveCount(3)

  await page.goto(`/submissions/${seeded.id}/rounds`)
  await expect(page.getByTestId("round-entry")).toHaveCount(2)
  const first = page.getByTestId("round-entry").first()
  await expect(first).toHaveAttribute("data-round", "2")
  await expect(first).toHaveAttribute("data-verdict", "pending")
  const second = page.getByTestId("round-entry").nth(1)
  await expect(second).toHaveAttribute("data-round", "1")
  await expect(second).toHaveAttribute("data-verdict", "changes-requested")
  await expect(second).toContainText(ROUND_ONE.outcome_definition)
  await expect(second.getByTestId("round-comment")).toContainText("silently dropping them")
  await expect(page.getByTestId("verdict-pill").nth(1)).toHaveText("Changes requested")
  await expect(page.getByTestId("back-to-submission")).toBeVisible()
})

test("a blank comment does not burn a round", async ({ page, request }) => {
  const seeded = await seedSubmission(page, uniqueEmail("e2e-blank"))
  await publishRound(request, seeded.reference, 1, ROUND_ONE)
  await page.goto(seeded.url)

  await page.getByTestId("request-changes-button").click()
  // A real browser honours `required` and refuses to submit at all — a
  // legitimate first line of defence that proves nothing about the server.
  await page.getByTestId("changes-comment").evaluate((el) => el.removeAttribute("required"))
  await page.getByTestId("submit-changes").click()

  // Still awaiting sign-off, still round 1, composer still open and reachable.
  await expect(page.getByTestId("submission-detail")).toHaveAttribute("data-status", "awaiting-signoff")
  await expect(page.getByTestId("design-round")).toHaveAttribute("data-round", "1")
  await expect(page.getByTestId("request-changes-form")).toBeVisible()
  await expect(page.getByTestId("changes-comment")).toBeVisible()

  await page.goto(`/submissions/${seeded.id}/rounds`)
  await expect(page.getByTestId("round-entry")).toHaveCount(1)
  await expect(page.getByTestId("round-entry").first()).toHaveAttribute("data-verdict", "pending")
})

test("approve is the only action that moves a submission past sign-off", async ({
  page,
  request,
}) => {
  const seeded = await seedSubmission(page, uniqueEmail("e2e-approve"))
  const before = await pullAll(request)
  await publishRound(request, seeded.reference, 1, ROUND_ONE)
  await page.goto(seeded.url)

  await page.getByTestId("approve-button").click()

  await expect(page).toHaveURL(seeded.url)
  await expect(page.getByTestId("submission-detail")).toHaveAttribute("data-status", "planned")
  await expect(page.getByTestId("status-pill")).toHaveText("Planned")
  await expect(page.getByTestId("approve-button")).toHaveCount(0)
  await expect(page.getByTestId("request-changes-button")).toHaveCount(0)

  const after = await pullAll(request, before.cursor)
  const approved = after.events.filter(
    (event) => event.submission_id === seeded.reference && event.type === "signoff.approved",
  )
  expect(approved).toHaveLength(1)
  expect(approved[0]?.payload["verdict"]).toBe("approved")

  // The approved round stays readable, with its verdict, forever.
  await page.goto(`/submissions/${seeded.id}/rounds`)
  await expect(page.getByTestId("round-entry").first()).toHaveAttribute("data-verdict", "approved")
  await expect(page.getByTestId("verdict-pill").first()).toHaveText("Approved")
  await expect(page.getByTestId("round-comment")).toHaveCount(0)
})

test("awaiting sign-off with no round published offers no sign-off affordance", async ({
  page,
  request,
}) => {
  const seeded = await seedSubmission(page, uniqueEmail("e2e-noround"))
  const result = await push(request, seeded.reference, 1, { status: "awaiting-signoff" })
  expect(result.outcome).toBe("applied")
  await page.goto(seeded.url)

  await expect(page.getByTestId("status-pill")).toHaveAttribute("data-status", "awaiting-signoff")
  await expect(page.getByTestId("design-round")).toHaveCount(0)
  await expect(page.getByTestId("approve-button")).toHaveCount(0)
  await expect(page.getByTestId("request-changes-button")).toHaveCount(0)
})

test("coord may never write the customer's verdict", async ({ page, request }) => {
  const seeded = await seedSubmission(page, uniqueEmail("e2e-owned"))
  await publishRound(request, seeded.reference, 1, ROUND_ONE)

  for (const field of ["signoff_verdict", "signoff_comment"]) {
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

  // The round is still pending — the rejected writes changed nothing.
  await page.goto(seeded.url)
  await expect(page.getByTestId("design-round")).toHaveAttribute("data-verdict", "pending")
  await expect(page.getByTestId("approve-button")).toBeVisible()
})

test("the dashboard row follows the same derived status as the detail screen", async ({
  page,
  request,
}) => {
  const seeded = await seedSubmission(page, uniqueEmail("e2e-dash"))
  await publishRound(request, seeded.reference, 1, ROUND_ONE)

  await page.goto("/submissions")
  await expect(page.getByTestId("submission-row")).toHaveAttribute("data-status", "awaiting-signoff")

  await page.goto(seeded.url)
  await page.getByTestId("request-changes-button").click()
  await page.getByTestId("changes-comment").fill("Please cover the failure reporting too.")
  await page.getByTestId("submit-changes").click()
  await expect(page.getByTestId("status-pill")).toHaveText("In design")

  await page.goto("/submissions")
  await expect(page.getByTestId("submission-row")).toHaveAttribute("data-status", "in-design")
  await expect(page.getByTestId("status-pill")).toHaveText("In design")
})
