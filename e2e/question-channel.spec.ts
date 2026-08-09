import { expect, test, type APIRequestContext, type Page } from "@playwright/test"

/**
 * Black-box coverage for issue #11 ([portal] Customer question channel —
 * raise -> pause -> resume), driving the real Worker under `wrangler dev`
 * with real local D1 — see `playwright.config.ts`. This is the project's own
 * `e2e/` tier, not the sealed acceptance suite under `tests/acceptance/`; per
 * CLAUDE.md this repo still ships its own coverage for behaviour-changing
 * work.
 *
 * SCOPE. A question is a coord-owned fact (`question`, pushed alongside
 * `status: needs-input`, per the contract's § Question channel) that the
 * portal renders as a pause — `pause-banner`, `question-thread` /
 * `question-text`, `answer-field` / `submit-answer` — and the customer's
 * answer leaves as a `question.answered` bridge event, never as a write to
 * `submissions.status`: only the coordinator's own next status push ever
 * moves that column (see `src/questions.ts`, `src/routes/submission.ts`).
 *
 * Every string below is invented — see CLAUDE.md rule 1.
 */

const SERVICE_TOKEN = {
  "CF-Access-Client-Id": "c4f18e2b9067a4d3e15fc809bf27a643.access",
  "CF-Access-Client-Secret":
    "7d3a915ecf802b4691cd35f0ae6d8b74190f2c635a8047de19b6f302c48e5a1",
}

/**
 * `serve:test` does not wipe `.wrangler/state` between runs (see the note in
 * `e2e/bridge.spec.ts`), so identities and question text are tagged unique
 * per run rather than risking a row another run left behind.
 */
function uniqueEmail(local: string): string {
  const tag = Math.random().toString(36).slice(2, 10)
  return `${local}-${tag}@example.test`
}

interface Seeded {
  url: string
  reference: string
}

async function seedSubmission(page: Page, email: string): Promise<Seeded> {
  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": email })
  await page.goto("/intake")
  await page.getByTestId("field-outcome").fill("A synthetic outcome for e2e question-channel coverage.")
  await page.getByTestId("field-audience").fill("synthetic e2e readers")
  await page.getByTestId("field-done-definition").fill("The question-channel e2e suite goes green.")
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

/** Raises a question and pauses the submission, in one update, per the contract. */
async function raiseQuestion(
  request: APIRequestContext,
  reference: string,
  revision: number,
  question: string,
): Promise<void> {
  const result = await push(request, reference, revision, { question, status: "needs-input" })
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

async function pullAll(request: APIRequestContext, cursor?: string): Promise<{ events: BridgeEvent[]; cursor: string }> {
  const events: BridgeEvent[] = []
  let next = cursor
  for (let page = 0; page < 50; page++) {
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

test("a raised question pauses the submission behind the pinned pause screen", async ({ page, request }) => {
  const email = uniqueEmail("e2e-raise")
  const seeded = await seedSubmission(page, email)

  await raiseQuestion(request, seeded.reference, 1, "Which two payment providers should the retry logic target?")
  await page.goto(seeded.url)

  await expect(page.getByTestId("submission-detail")).toHaveAttribute("data-status", "needs-input")
  await expect(page.getByTestId("status-pill")).toHaveText("Needs your input")
  await expect(page.getByTestId("pause-banner")).toHaveText("Work is paused until you answer.")
  await expect(page.getByTestId("question-thread")).toBeVisible()
  await expect(page.getByTestId("question-text")).toHaveText(
    "Which two payment providers should the retry logic target?",
  )
  await expect(page.getByTestId("answer-field")).toBeVisible()
  await expect(page.getByTestId("submit-answer")).toHaveText("Send answer")

  // No other milestone's action affordance leaks onto the pause screen.
  await expect(page.getByTestId("approve-button")).toHaveCount(0)
  await expect(page.getByTestId("request-changes-button")).toHaveCount(0)
})

test("needs-input with no question on record offers no pause and no composer", async ({ page, request }) => {
  const email = uniqueEmail("e2e-no-question")
  const seeded = await seedSubmission(page, email)

  const result = await push(request, seeded.reference, 1, { status: "needs-input" })
  expect(result.outcome).toBe("applied")
  await page.goto(seeded.url)

  await expect(page.getByTestId("status-pill")).toHaveAttribute("data-status", "needs-input")
  await expect(page.getByTestId("pause-banner")).toHaveCount(0)
  await expect(page.getByTestId("question-thread")).toHaveCount(0)
  await expect(page.getByTestId("answer-field")).toHaveCount(0)
})

test("answering leaves status untouched and reaches the bridge as question.answered", async ({
  page,
  request,
}) => {
  const email = uniqueEmail("e2e-answer")
  const seeded = await seedSubmission(page, email)
  const before = await pullAll(request)

  await raiseQuestion(request, seeded.reference, 1, "What is the expected monthly volume?")
  await page.goto(seeded.url)

  await page.getByTestId("answer-field").fill("Roughly four thousand transactions a month.")
  await page.getByTestId("submit-answer").click()

  // The redirect lands back on the same submission, and the composer for
  // this now-answered question is gone — but the status pill has not moved:
  // only the coordinator's own next push may do that.
  await expect(page).toHaveURL(seeded.url)
  await expect(page.getByTestId("status-pill")).toHaveAttribute("data-status", "needs-input")
  await expect(page.getByTestId("pause-banner")).toHaveCount(0)
  await expect(page.getByTestId("answer-field")).toHaveCount(0)

  const after = await pullAll(request, before.cursor)
  const answered = after.events.find(
    (event) => event.submission_id === seeded.reference && event.type === "question.answered",
  )
  expect(answered).toBeTruthy()
  expect(answered?.payload["answer"]).toBe("Roughly four thousand transactions a month.")

  // Replay-safe: pulling the same cursor twice returns the same event.
  const replay = await pullAll(request, before.cursor)
  const replayed = replay.events.find(
    (event) => event.submission_id === seeded.reference && event.type === "question.answered",
  )
  expect(replayed?.id).toBe(answered?.id)
})

test("a blank answer does not end the pause, even bypassing client-side validation", async ({
  page,
  request,
}) => {
  const email = uniqueEmail("e2e-blank")
  const seeded = await seedSubmission(page, email)

  await raiseQuestion(request, seeded.reference, 1, "Any blackout dates we should know about?")
  await page.goto(seeded.url)

  // A real browser honours `required` and refuses to submit a blank textarea
  // at all — that is a legitimate first line of defence, but it proves
  // nothing about the server. Strip it so the POST actually lands, the way a
  // non-browser client (or a user with JS disabled reaching the field some
  // other way) could.
  await page.getByTestId("answer-field").evaluate((el) => el.removeAttribute("required"))
  await page.getByTestId("submit-answer").click()

  await expect(page.getByTestId("pause-banner")).toBeVisible()
  await expect(page.getByTestId("question-text")).toHaveText("Any blackout dates we should know about?")
  await expect(page.getByTestId("answer-field")).toBeVisible()
})

test("a second question re-opens the pause after the first is answered", async ({ page, request }) => {
  const email = uniqueEmail("e2e-reopen")
  const seeded = await seedSubmission(page, email)

  await raiseQuestion(request, seeded.reference, 1, "First question: which region?")
  await page.goto(seeded.url)
  await page.getByTestId("answer-field").fill("EU only.")
  await page.getByTestId("submit-answer").click()
  await expect(page.getByTestId("pause-banner")).toHaveCount(0)

  // The coordinator raises a second question. Status was already
  // `needs-input`, so this push carries only the new question.
  const result = await push(request, seeded.reference, 2, { question: "Second question: which currency?" })
  expect(result.outcome).toBe("applied")

  await page.goto(seeded.url)
  await expect(page.getByTestId("pause-banner")).toHaveText("Work is paused until you answer.")
  await expect(page.getByTestId("question-text")).toHaveText("Second question: which currency?")

  await page.getByTestId("answer-field").fill("EUR.")
  await page.getByTestId("submit-answer").click()
  await expect(page.getByTestId("pause-banner")).toHaveCount(0)
})

test("coord may never write the customer's answer", async ({ page, request }) => {
  const email = uniqueEmail("e2e-not-owned")
  const seeded = await seedSubmission(page, email)

  await raiseQuestion(request, seeded.reference, 1, "Can coord speak for the customer?")

  const res = await request.post("/api/bridge/push", {
    data: {
      updates: [
        {
          submission_id: seeded.reference,
          revision: 2,
          fields: { answer: "words coord put in the customer's mouth" },
        },
      ],
    },
    headers: SERVICE_TOKEN,
  })
  expect(res.status()).toBe(200)
  const body = (await res.json()) as { results: Array<{ outcome: string; reason?: string }> }
  expect(body.results[0]?.outcome).toBe("rejected")
  expect(body.results[0]?.reason).toBe("not_owned:answer")

  // The question is still open — the rejected write changed nothing.
  await page.goto(seeded.url)
  await expect(page.getByTestId("pause-banner")).toBeVisible()
  await expect(page.getByTestId("answer-field")).toBeVisible();
})
