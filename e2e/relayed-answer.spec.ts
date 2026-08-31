import { expect, test, type APIRequestContext, type Page } from "@playwright/test"

/**
 * Black-box coverage for issue #159 ([portal] Let a client confirm an answer
 * the operator relayed on their behalf), driving the real Worker under
 * `wrangler dev` with real local D1 — see `playwright.config.ts`. This is the
 * project's own `e2e/` tier, not the sealed acceptance suite under
 * `tests/acceptance/`; per CLAUDE.md this repo still ships its own coverage
 * for behaviour-changing work.
 *
 * SCOPE. `relayed_answer` is a coord-owned fact (`src/bridge/ownership.ts`),
 * pushed alongside — or after — the `question` it answers, matched by the
 * `question_revision` it carries. The portal renders it where the ordinary
 * answer composer would (`relayed-answer`, `confirm-relay-button`,
 * `correct-relay-button`), never as the customer's own words, and turns a
 * one-tap confirmation into an ordinary `question.answered` bridge event
 * (`src/questions.ts`'s `confirmRelayedAnswer`). Correcting — before or after
 * confirming — supersedes with the customer's own words instead
 * (`correctRelayedAnswer`).
 *
 * Every string below is invented — see CLAUDE.md rule 1.
 */

const SERVICE_TOKEN = {
  "CF-Access-Client-Id": "a19d472ef803b6c4e15a908cf3067b21.access",
  "CF-Access-Client-Secret":
    "9f1c68e4a03d7b52916cf480ae62d0b7c95a1e3084fb762d1a5c907e28b4f61",
}

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
  await page.getByTestId("field-outcome").fill("A synthetic outcome for e2e relayed-answer coverage.")
  await page.getByTestId("field-audience").fill("synthetic e2e readers")
  await page.getByTestId("field-done-definition").fill("The relayed-answer e2e suite goes green.")
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

/** Relays an answer against a given question revision — the operator's out-of-band record. */
async function relayAnswer(
  request: APIRequestContext,
  reference: string,
  revision: number,
  questionRevision: number,
  answer: string,
  source: "verbal" | "phone" | "email" = "phone",
): Promise<void> {
  const result = await push(request, reference, revision, {
    relayed_answer: {
      answer,
      source,
      question_revision: questionRevision,
      relayed_at: "2026-08-20T15:00:00.000Z",
    },
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

function answeredEventsFor(events: BridgeEvent[], reference: string): BridgeEvent[] {
  return events.filter((event) => event.submission_id === reference && event.type === "question.answered")
}

test("a relayed answer renders distinct from a client-authored answer, unconfirmed", async ({ page, request }) => {
  const email = uniqueEmail("e2e-relay-render")
  const seeded = await seedSubmission(page, email)
  const before = await pullAll(request)

  await raiseQuestion(request, seeded.reference, 1, "Which two payment providers should the retry logic target?")
  await relayAnswer(request, seeded.reference, 2, 1, "Stripe and Adyen, on our call this afternoon.", "phone")
  await page.goto(seeded.url)

  await expect(page.getByTestId("pause-banner")).toBeVisible()
  await expect(page.getByTestId("relayed-answer")).toHaveAttribute("data-confirmed", "false")
  await expect(page.getByTestId("relayed-answer-text")).toHaveText("Stripe and Adyen, on our call this afternoon.")
  await expect(page.getByTestId("relayed-answer-source")).toHaveText("on a call")
  await expect(page.getByTestId("relayed-answer-date")).toHaveText("2026-08-20T15:00:00.000Z")
  await expect(page.getByTestId("confirm-relay-button")).toHaveText("Yes, that's right")
  await expect(page.getByTestId("correct-relay-button")).toBeVisible()

  // Nothing about an unconfirmed relay satisfies "the customer answered" —
  // no bridge event yet, and the sign-off/other-action affordances stay off
  // the pause screen exactly as an ordinary open question already asserts.
  const after = await pullAll(request, before.cursor)
  expect(answeredEventsFor(after.events, seeded.reference)).toHaveLength(0)
  await expect(page.getByTestId("approve-button")).toHaveCount(0)
})

test("confirming a relay is one tap, is idempotent, and reaches the bridge as question.answered", async ({
  page,
  request,
}) => {
  const email = uniqueEmail("e2e-relay-confirm")
  const seeded = await seedSubmission(page, email)
  const before = await pullAll(request)

  await raiseQuestion(request, seeded.reference, 1, "What is the expected monthly volume?")
  await relayAnswer(request, seeded.reference, 2, 1, "Roughly four thousand transactions a month.", "verbal")
  await page.goto(seeded.url)

  await page.getByTestId("confirm-relay-button").click()

  // Status is untouched — only the coordinator's own next push moves it —
  // but the pause banner is gone and the relay now reads as confirmed.
  await expect(page).toHaveURL(seeded.url)
  await expect(page.getByTestId("status-pill")).toHaveAttribute("data-status", "needs-input")
  await expect(page.getByTestId("pause-banner")).toHaveCount(0)
  await expect(page.getByTestId("relayed-answer")).toHaveAttribute("data-confirmed", "true")
  await expect(page.getByTestId("confirm-relay-button")).toHaveCount(0)

  const after = await pullAll(request, before.cursor)
  const answered = answeredEventsFor(after.events, seeded.reference)
  expect(answered).toHaveLength(1)
  expect(answered[0]?.payload["answer"]).toBe("Roughly four thousand transactions a month.")
  expect((answered[0]?.payload["relay"] as Record<string, unknown> | undefined)?.["confirmed"]).toBe(true)

  // A second confirm (double form submit, or a stale second tab) changes nothing.
  const res = await request.post(seeded.url, {
    form: { action: "confirm-relay" },
    headers: { "Cf-Access-Authenticated-User-Email": email },
  })
  expect(res.status()).toBe(409)

  const replay = await pullAll(request, before.cursor)
  expect(answeredEventsFor(replay.events, seeded.reference)).toHaveLength(1)
})

test("correcting a relay before confirming records the customer's own words, not the relay", async ({
  page,
  request,
}) => {
  const email = uniqueEmail("e2e-relay-correct-before")
  const seeded = await seedSubmission(page, email)
  const before = await pullAll(request)

  await raiseQuestion(request, seeded.reference, 1, "Any blackout dates we should know about?")
  await relayAnswer(request, seeded.reference, 2, 1, "None that they mentioned.", "email")
  await page.goto(seeded.url)

  await page.getByTestId("correct-relay-button").click()
  await expect(page.getByTestId("answer-field")).toHaveValue("None that they mentioned.")
  await page.getByTestId("answer-field").fill("Actually yes — the last week of December.")
  await page.getByTestId("submit-answer").click()

  await expect(page).toHaveURL(seeded.url)
  await expect(page.getByTestId("pause-banner")).toHaveCount(0)
  await expect(page.getByTestId("relayed-answer")).toHaveCount(0)

  const after = await pullAll(request, before.cursor)
  const answered = answeredEventsFor(after.events, seeded.reference)
  expect(answered).toHaveLength(1)
  expect(answered[0]?.payload["answer"]).toBe("Actually yes — the last week of December.")
  expect(answered[0]?.payload["relay"]).toBeUndefined()
})

test("a client can reopen and correct after confirming — both events stay on the record", async ({
  page,
  request,
}) => {
  const email = uniqueEmail("e2e-relay-correct-after")
  const seeded = await seedSubmission(page, email)
  const before = await pullAll(request)

  await raiseQuestion(request, seeded.reference, 1, "Which region should we launch in first?")
  await relayAnswer(request, seeded.reference, 2, 1, "The EU, they said on the phone.", "phone")
  await page.goto(seeded.url)
  await page.getByTestId("confirm-relay-button").click()
  await expect(page.getByTestId("relayed-answer")).toHaveAttribute("data-confirmed", "true")

  // Reopen and correct — the affordance survives past confirmation.
  await page.getByTestId("correct-relay-button").click()
  await expect(page.getByTestId("answer-field")).toHaveValue("The EU, they said on the phone.")
  await page.getByTestId("answer-field").fill("Sorry — actually APAC first, EU second.")
  await page.getByTestId("submit-answer").click()

  await expect(page).toHaveURL(seeded.url)
  await expect(page.getByTestId("relayed-answer")).toHaveCount(0)

  const after = await pullAll(request, before.cursor)
  const answered = answeredEventsFor(after.events, seeded.reference)
  // Both the confirm and the correction are on the record — the confirm is
  // never deleted or rewritten, it just stops being the latest word.
  expect(answered).toHaveLength(2)
  expect(answered.map((event) => event.payload["answer"])).toEqual([
    "The EU, they said on the phone.",
    "Sorry — actually APAC first, EU second.",
  ])
})

test("a second question re-opens the pause even when the first was answered via a relay", async ({
  page,
  request,
}) => {
  const email = uniqueEmail("e2e-relay-reopen")
  const seeded = await seedSubmission(page, email)

  await raiseQuestion(request, seeded.reference, 1, "First question: which currency?")
  await relayAnswer(request, seeded.reference, 2, 1, "USD.", "verbal")
  await page.goto(seeded.url)
  await page.getByTestId("confirm-relay-button").click()
  await expect(page.getByTestId("relayed-answer")).toHaveAttribute("data-confirmed", "true")

  const result = await push(request, seeded.reference, 3, { question: "Second question: which region?" })
  expect(result.outcome).toBe("applied")

  await page.goto(seeded.url)
  await expect(page.getByTestId("pause-banner")).toBeVisible()
  await expect(page.getByTestId("question-text")).toHaveText("Second question: which region?")
  await expect(page.getByTestId("relayed-answer")).toHaveCount(0)
  await expect(page.getByTestId("answer-field")).toBeVisible()
})

test("coord may never write relayed_answer with an unrecognised source", async ({ page, request }) => {
  const email = uniqueEmail("e2e-relay-bad-source")
  const seeded = await seedSubmission(page, email)

  await raiseQuestion(request, seeded.reference, 1, "Can coord invent a source we don't render?")
  // A malformed relay (an unknown `source`) is accepted by the bridge — the
  // field itself is coord-owned and the value is kept verbatim, same as
  // `question` — but `getRelayedAnswer` reads it defensively and treats it
  // as no relay on record, so it must never surface a confirm affordance for
  // something this screen cannot make sense of.
  const result = await push(request, seeded.reference, 2, {
    relayed_answer: {
      answer: "Whatever coord likes",
      source: "carrier-pigeon",
      question_revision: 1,
      relayed_at: "2026-08-20T15:00:00.000Z",
    },
  })
  expect(result.outcome).toBe("applied")

  await page.goto(seeded.url)
  await expect(page.getByTestId("relayed-answer")).toHaveCount(0)
  await expect(page.getByTestId("confirm-relay-button")).toHaveCount(0)
  await expect(page.getByTestId("pause-banner")).toBeVisible()
  await expect(page.getByTestId("answer-field")).toBeVisible()
})
