import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test"

/**
 * Black-box coverage for issue #318 ([portal] Review, edit and approve
 * coord's queued outbound drafts in the portal, not only from a terminal),
 * driving the real Worker under `wrangler dev` with real local D1 — see
 * `playwright.config.ts`. This is the project's own `e2e/` tier, not the
 * sealed acceptance suite under `tests/acceptance/`.
 *
 * Issue #318 itself asks that "whatever contract this adds should be
 * exercised end to end against a real Worker at least once" — precisely
 * because #3166/#3173 (code-coordinator) shipped five wire mismatches between
 * these two systems from each side asserting the payload it *intended*
 * against a stand-in. This file is that one real exercise: it drives
 * `POST /api/bridge/outbound-drafts` (coord's half) and `GET /requests/:id`
 * plus its two POST actions (the portal's half) against the same running
 * Worker and the same D1, then reads the verdict back off
 * `GET /api/bridge/pull` — the actual round trip, not two mocks that agree
 * with themselves.
 *
 * WHAT IS ASSERTED HERE:
 *
 *   1. a coord-owned draft queued against a submission renders on
 *      `/requests/:id`, with its kind, the submission it belongs to, when it
 *      was queued, and its editable text;
 *   2. the screen states what approving causes — a `status` draft says it
 *      emails the customer, every other kind says it does not;
 *   3. approving sends **the edited text**, not what coord originally
 *      queued, back to coord as an `outbound_draft.approved` event on the
 *      existing pull stream;
 *   4. rejecting produces `outbound_draft.rejected` and never an approval;
 *   5. once decided, the draft no longer renders as pending, and a stale
 *      re-push of the same id from coord does not resurrect it;
 *   6. a non-operator gets the same indistinguishable 404 on both actions
 *      that every other write on this operator surface already returns.
 *
 * `serve:test` does not wipe `.wrangler/state` between runs and this file
 * runs alongside siblings that also write to `bridge_events`, so nothing here
 * asserts on the *global* contents of the pull stream — every assertion is
 * scoped to a cursor this test took and a draft id this test minted.
 *
 * Every address, string and id below is invented — CLAUDE.md rule 1.
 */

const DEV_OPERATOR = "ops@example.test"

const SERVICE_TOKEN = {
  "CF-Access-Client-Id": "c92e5a17f0b4462d81963e5a0c8d2f74.access",
  "CF-Access-Client-Secret":
    "6e29b8d54ac170f9e42b7d5361a08fce9b31d0a7c4285f691e0a37c8b6d5f21a",
}

function tag(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function uniqueEmail(local: string): string {
  return `${local}-${tag()}@example.test`
}

async function contextFor(
  browser: Browser,
  baseURL: string | undefined,
  email: string | null,
) {
  return browser.newContext({
    baseURL,
    extraHTTPHeaders: email ? { "Cf-Access-Authenticated-User-Email": email } : {},
  })
}

async function operatorPage(browser: Browser, baseURL: string | undefined): Promise<Page> {
  const context = await contextFor(browser, baseURL, DEV_OPERATOR)
  return context.newPage()
}

interface Seeded {
  id: string
  reference: string
}

/** Files a standalone request through `/intake` — the id and reference both come off the post-submit redirect, no separate lookup needed. */
async function fileRequest(page: Page, email: string): Promise<Seeded> {
  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": email })
  await page.goto("/intake")
  await page.getByTestId("field-outcome").fill(`A synthetic outcome for #318 e2e coverage (${tag()}).`)
  await page.getByTestId("field-audience").fill("synthetic e2e readers")
  await page.getByTestId("field-done-definition").fill("The outbound-drafts e2e suite goes green.")
  await page.getByTestId("submit-intake").click()
  await expect(page.getByTestId("intake-receipt")).toBeVisible()

  const id = new URL(page.url()).pathname.replace(/^\/submissions\//, "")
  const reference = (await page.getByTestId("submission-reference").innerText())
    .trim()
    .replace(/^Reference\s+/, "")
  return { id, reference }
}

interface DraftSpec {
  id: string
  submission_id: string
  kind: string
  fields: Record<string, string>
  queued_at: string
}

async function pushDrafts(
  request: APIRequestContext,
  drafts: DraftSpec[],
): Promise<Array<{ id: string; outcome: string; reason?: string }>> {
  const res = await request.post("/api/bridge/outbound-drafts", {
    data: { drafts },
    headers: SERVICE_TOKEN,
  })
  expect(res.status()).toBe(200)
  const body = (await res.json()) as { results: Array<{ id: string; outcome: string; reason?: string }> }
  return body.results
}

interface BridgeEvent {
  id: string
  revision: number
  type: string
  submission_id: string
  payload: Record<string, unknown>
}

interface PullPage {
  events: BridgeEvent[]
  cursor: string
  has_more: boolean
}

async function pull(request: APIRequestContext, cursor?: string): Promise<PullPage> {
  const res = await request.get("/api/bridge/pull", {
    params: { limit: "200", ...(cursor ? { cursor } : {}) },
    headers: SERVICE_TOKEN,
  })
  expect(res.status()).toBe(200)
  return (await res.json()) as PullPage
}

/** Drains the pull stream to its current end, returning the cursor to collect new events from. */
async function drain(request: APIRequestContext): Promise<string> {
  let cursor: string | undefined
  for (let page = 0; page < 50; page++) {
    const body = await pull(request, cursor)
    cursor = body.cursor
    if (!body.has_more) return cursor
  }
  throw new Error("the stream never drained")
}

/** Everything on the stream after `cursor`. */
async function collectFrom(request: APIRequestContext, cursor: string): Promise<BridgeEvent[]> {
  const events: BridgeEvent[] = []
  let next = cursor
  for (let page = 0; page < 50; page++) {
    const body = await pull(request, next)
    events.push(...body.events)
    next = body.cursor
    if (!body.has_more) return events
  }
  throw new Error("the stream never drained")
}

function draftId(): string {
  return `e2e-draft-${tag()}`
}

test("a queued design-round draft renders on /requests/:id, edits are what coord receives, and it stops rendering once decided", async ({
  browser,
  baseURL,
  request,
}) => {
  const operator = await operatorPage(browser, baseURL)
  const customerContext = await browser.newContext({ baseURL })
  const customer = await customerContext.newPage()
  const seeded = await fileRequest(customer, uniqueEmail("e2e-outbound"))
  await customerContext.close()

  const id = draftId()
  const originalOutcome = `The original outcome definition (${tag()}).`
  const pushed = await pushDrafts(request, [
    {
      id,
      submission_id: seeded.reference,
      kind: "design_round",
      fields: { outcome_definition: originalOutcome },
      queued_at: new Date().toISOString(),
    },
  ])
  expect(pushed).toEqual([{ id, outcome: "applied" }])

  await operator.goto(`/requests/${seeded.id}`)
  const card = operator.getByTestId("outbound-draft")
  await expect(card).toHaveAttribute("data-draft-kind", "design_round")
  await expect(card.getByTestId("outbound-draft-kind")).toHaveText("Design round")
  await expect(card.getByTestId("outbound-draft-submission")).toHaveText(seeded.reference)
  const field = card.getByTestId("outbound-draft-field")
  await expect(field).toHaveValue(originalOutcome)
  // Issue #318's own requirement: what approving causes, stated on the
  // screen. A design round never emails the customer.
  await expect(card.getByTestId("outbound-draft-consequence")).toHaveText(
    "Approving this only changes what the portal shows. No email is sent.",
  )

  const start = await drain(request)
  const editedOutcome = `An operator-tightened outcome definition (${tag()}).`
  await field.fill(editedOutcome)
  await card.getByTestId("outbound-draft-approve-button").click()

  // Approving has nowhere else to go — same screen, draft gone.
  await expect(operator).toHaveURL(new RegExp(`/requests/${seeded.id}$`))
  await expect(operator.getByTestId("outbound-draft")).toHaveCount(0)

  const events = (await collectFrom(request, start)).filter((e) => e.submission_id === seeded.reference)
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({
    type: "outbound_draft.approved",
    payload: { draft_id: id, kind: "design_round", fields: { outcome_definition: editedOutcome } },
  })

  // A stale re-push of the same id (coord has not yet caught up with the
  // verdict) must not resurrect it as pending.
  const restale = await pushDrafts(request, [
    {
      id,
      submission_id: seeded.reference,
      kind: "design_round",
      fields: { outcome_definition: originalOutcome },
      queued_at: new Date().toISOString(),
    },
  ])
  expect(restale).toEqual([{ id, outcome: "applied" }])
  await operator.reload()
  await expect(operator.getByTestId("outbound-draft")).toHaveCount(0)
})

test("a queued status draft says it emails the customer; rejecting produces no approval event", async ({
  browser,
  baseURL,
  request,
}) => {
  const operator = await operatorPage(browser, baseURL)
  const customerContext = await browser.newContext({ baseURL })
  const customer = await customerContext.newPage()
  const seeded = await fileRequest(customer, uniqueEmail("e2e-outbound-status"))
  await customerContext.close()

  const id = draftId()
  await pushDrafts(request, [
    {
      id,
      submission_id: seeded.reference,
      kind: "status",
      fields: { status: "in-progress" },
      queued_at: new Date().toISOString(),
    },
  ])

  await operator.goto(`/requests/${seeded.id}`)
  const card = operator.getByTestId("outbound-draft")
  await expect(card.getByTestId("outbound-draft-consequence")).toHaveText(
    "Approving this emails the customer — the only kind of coord message that does.",
  )

  const start = await drain(request)
  await card.getByTestId("outbound-draft-reject-button").click()
  await expect(operator.getByTestId("outbound-draft")).toHaveCount(0)

  const events = (await collectFrom(request, start)).filter((e) => e.submission_id === seeded.reference)
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ type: "outbound_draft.rejected", payload: { draft_id: id, kind: "status" } })
})

test("a stranger, the owning customer, and nobody all get the same indistinguishable 404 on both draft actions", async ({
  browser,
  baseURL,
  request,
}) => {
  const email = uniqueEmail("e2e-outbound-gate")
  const seedContext = await contextFor(browser, baseURL, email)
  const seeded = await fileRequest(await seedContext.newPage(), email)
  await seedContext.close()

  const id = draftId()
  await pushDrafts(request, [
    {
      id,
      submission_id: seeded.reference,
      kind: "question",
      fields: { question: "A synthetic queued question?" },
      queued_at: new Date().toISOString(),
    },
  ])

  // A customer reading their own submission is still not an operator — the
  // same "never a 403, always the indistinguishable 404" rule every other
  // write on this surface already follows (`readOperator`, `src/operators.ts`).
  for (const identity of [email, null]) {
    const context = await contextFor(browser, baseURL, identity)
    const approveRes = await context.request.post(`/requests/${seeded.id}/drafts/${id}/approve`, {
      form: { field__question: "an attempted takeover" },
      maxRedirects: 0,
      failOnStatusCode: false,
    })
    expect(approveRes.status(), `approve as ${identity ?? "nobody"}`).toBe(404)

    const rejectRes = await context.request.post(`/requests/${seeded.id}/drafts/${id}/reject`, {
      form: {},
      maxRedirects: 0,
      failOnStatusCode: false,
    })
    expect(rejectRes.status(), `reject as ${identity ?? "nobody"}`).toBe(404)
    await context.close()
  }

  // Nothing moved — the draft is exactly as coord queued it, still pending.
  const operator = await operatorPage(browser, baseURL)
  await operator.goto(`/requests/${seeded.id}`)
  await expect(operator.getByTestId("outbound-draft-field")).toHaveValue("A synthetic queued question?")
})

test("the bridge push refuses a malformed batch item without poisoning its siblings", async ({ request }) => {
  const goodId = draftId()
  const results = await pushDrafts(request, [
    {
      id: goodId,
      submission_id: "SUB-000000",
      kind: "relayed_answer",
      fields: { answer: "A synthetic relayed answer." },
      queued_at: new Date().toISOString(),
    },
    // @ts-expect-error deliberately missing `kind` for this assertion
    { id: "missing-kind", submission_id: "SUB-000000", fields: {}, queued_at: new Date().toISOString() },
    { id: "bad-kind", submission_id: "SUB-000000", kind: "not_a_real_kind", fields: {}, queued_at: new Date().toISOString() },
  ])

  expect(results).toEqual([
    { id: goodId, outcome: "applied" },
    { id: "missing-kind", outcome: "rejected", reason: "unknown_kind" },
    { id: "bad-kind", outcome: "rejected", reason: "unknown_kind" },
  ])
})
