import { expect, test, type APIRequestContext, type Page } from "@playwright/test"

/**
 * ms-1 sealed acceptance slice — issue #11
 * "[portal] Customer question channel — raise -> pause -> resume"
 *
 * Written from `tests/acceptance/ms-1/contract.md` (§ "Question channel (pinned,
 * from issue #11)", the `Needs-your-input (08)` hook block, the status
 * vocabulary table and the sole-writer ownership table) and from the mock it
 * pins, `mocks/08-submission-needs-input.html`, without sight of any
 * implementation.
 *
 * THE SHAPE UNDER TEST. Issue #11 is one loop with three beats:
 *
 *   RAISE   coord authors a `question` and moves the submission to
 *           `needs-input`. Both are coord-owned facts and both arrive over the
 *           bridge — the portal never invents a question and never invents the
 *           status that accompanies it.
 *   PAUSE   `/submissions/:id` renders "Work is paused until you answer." and
 *           the question thread, and — contract, verbatim — "no other customer
 *           action should be available on that screen while a question is
 *           open".
 *   RESUME  the customer answers. `answer` is portal-owned, so the answer is a
 *           customer-authored fact and leaves as a `question.answered` event on
 *           `GET /api/bridge/pull`. Coord, not the portal, then moves the
 *           status on.
 *
 * MECHANISM. `question` and `status` are coord-owned (contract § "Ownership —
 * sole-writer table"), so the only black-box way to raise a question is a bridge
 * push; the only way to author a submission is issue #9's pinned intake form;
 * and the only black-box read-back of the customer's answer is issue #15's
 * `question.answered` event. All three are other issues' surfaces, used here as
 * instruments, not as subjects. `15-sync-bridge.spec.ts` explicitly defers
 * `question.answered` to this slice ("Those facts are authored on the #13 and
 * #11 screens, which this slice must not assume exist"), so this is the only
 * place that event is exercised.
 *
 * NOT COVERED HERE, deliberately:
 *  - **The sign-off loop reusing this substrate.** Issue #11 asks that #13
 *    ("approve or request changes" = the same raise -> pause -> resume with a
 *    verdict attached) reuse this rather than parallel it. The contract is
 *    explicit that this is NOT a black-box constraint: "This contract does not
 *    force a single shared DOM structure between `08-submission-needs-input.html`
 *    and the sign-off screens (`05`, `06`) … a worker collapsing them into one
 *    component is compatible with this contract as long as each screen's pinned
 *    `data-testid`s and text still resolve." Component sharing is invisible from
 *    outside, so it is not asserted anywhere below. #13's slice owns the
 *    sign-off screens.
 *  - **Which STUCK: mechanism raises the question engineer-side.** That is a
 *    coord-side fact; from this repo a question only ever arrives as a bridge
 *    push, whatever produced it.
 *  - **Generic ownership enforcement** (every portal-owned field is rejected):
 *    that is #8's/#15's slice and is already asserted there. This slice asserts
 *    only the `question`/`answer` pair, which is #11's own delta, and only for
 *    what it does to the customer's screen.
 *  - **The staleness / notification side.** Whether a raised question generates
 *    an email is issue #14's slice.
 *
 * SYNTHETIC DATA. Per CLAUDE.md rule 1 and the contract's "Synthetic data"
 * section, every submission, question and answer below is invented.
 */

const CUSTOMER_EMAIL = "ada@example.test"

/**
 * The daemon's service-token credential.
 *
 * TODO(test-author): identical to the note in `15-sync-bridge.spec.ts` — the
 * contract pins the two header names and pins missing/invalid ⇒ 401, but not how
 * a Worker booted by `npm run serve:acceptance` (no Access in front of it)
 * learns which pair is valid. Same escape hatch: export
 * `COORD_BRIDGE_CLIENT_ID` / `COORD_BRIDGE_CLIENT_SECRET` and this suite
 * presents those instead. The defaults are invented, not a credential.
 */
const SERVICE_TOKEN = {
  "CF-Access-Client-Id":
    process.env.COORD_BRIDGE_CLIENT_ID ?? "9f2c17b4a8de40518c6b3ad0e75f1c62.access",
  "CF-Access-Client-Secret":
    process.env.COORD_BRIDGE_CLIENT_SECRET ??
    "4d1e9c07b35a2f68e4c81079ba6d35f2c9017e4ab8d562309fc71ea48b0d63a5",
}

const REFERENCE = /^SUB-[A-Z0-9]{6}$/
const ISO_8601_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

/** Contract § "Question channel": this string is "a black-box guarantee, not decoration". */
const PAUSE_COPY = "Work is paused until you answer."
/** Contract § `data-testid` hooks, Needs-your-input (08): pinned button text. */
const SEND_ANSWER_LABEL = "Send answer"
/** Contract § status vocabulary: `needs-input` → this exact customer-visible text. */
const NEEDS_INPUT_TEXT = "Needs your input"

/**
 * Every `data-testid` the contract pins as an *other* customer action — the ones
 * that must not be reachable while a question is open. All of them belong to the
 * sign-off screens (`05`, `06`), which are the only other customer-actionable
 * surface this milestone has.
 */
const OTHER_ACTION_TESTIDS = [
  "approve-button",
  "request-changes-button",
  "request-changes-form",
  "changes-comment",
  "submit-changes",
  "cancel-changes",
]

/** The pinned hooks of the needs-input screen itself. */
const QUESTION_TESTIDS = [
  "pause-banner",
  "question-thread",
  "question-text",
  "answer-field",
  "submit-answer",
]

interface BridgeEvent {
  id: string
  revision: number
  type: string
  submission_id: string
  occurred_at: string
  payload: unknown
}

interface PullPage {
  events: BridgeEvent[]
  cursor: string | null
  has_more: boolean
}

interface PushResult {
  submission_id: string
  outcome: string
  reason?: string
}

// ── bridge transport (the instrument, not the subject) ──────────────────────

async function pullPage(
  request: APIRequestContext,
  opts: { cursor?: string | null; limit?: number } = {},
): Promise<PullPage> {
  const params: Record<string, string> = {}
  if (opts.cursor != null) params.cursor = opts.cursor
  if (opts.limit != null) params.limit = String(opts.limit)
  const res = await request.get("/api/bridge/pull", { params, headers: SERVICE_TOKEN })
  expect(res.status(), "a pull with a valid service token is 200").toBe(200)
  const body = (await res.json()) as PullPage
  expect(Array.isArray(body.events), "`events` is an array").toBe(true)
  return body
}

/**
 * Read the stream to its end and return the cursor that now points past every
 * event, so each test can establish its own baseline. The acceptance database is
 * wiped per *run*, not per *test* (tests/acceptance/README.md § Determinism).
 */
async function drainToCursor(request: APIRequestContext): Promise<string | null> {
  let cursor: string | null = null
  for (let page = 0; page < 100; page++) {
    const body = await pullPage(request, { cursor, limit: 200 })
    if (typeof body.cursor === "string" && body.cursor.length > 0) cursor = body.cursor
    if (!body.has_more) return cursor
    expect(
      body.events.length,
      "`has_more: true` with no events would page forever",
    ).toBeGreaterThan(0)
  }
  throw new Error("pull never reported has_more:false — the cursor is not advancing")
}

/** Every event after `cursor`, paged to exhaustion. */
async function eventsSince(
  request: APIRequestContext,
  cursor: string | null,
): Promise<BridgeEvent[]> {
  const collected: BridgeEvent[] = []
  let at = cursor
  for (let page = 0; page < 100; page++) {
    const body = await pullPage(request, { cursor: at, limit: 200 })
    collected.push(...body.events)
    if (!body.has_more) return collected
    at = body.cursor
  }
  throw new Error("pull never reported has_more:false — the cursor is not advancing")
}

async function pushFields(
  request: APIRequestContext,
  submissionId: string,
  revision: number,
  fields: Record<string, unknown>,
): Promise<PushResult> {
  const res = await request.post("/api/bridge/push", {
    data: { updates: [{ submission_id: submissionId, revision, fields }] },
    headers: SERVICE_TOKEN,
  })
  // Contract trap: ownership violations and stale revisions are per-item
  // outcomes inside a 200, never transport failures.
  expect(res.status(), "a push with a valid service token is 200").toBe(200)
  const body = (await res.json()) as { results: PushResult[] }
  expect(body.results, "one result per update").toHaveLength(1)
  return body.results[0]
}

/**
 * RAISE, the only way coord can: one atomic push carrying both coord-owned facts
 * — the question itself and the status that pauses the submission.
 *
 * Both in ONE update on purpose. Issue #10's slice pins that the portal "renders
 * and does not derive": a pushed `question` alone must NOT make the portal
 * decide the status is `needs-input`. So the daemon raising a question is
 * exactly this — a `question` and a `status` together — and whole-update
 * atomicity means the customer never sees a half-raised question.
 *
 * TODO(test-author): the contract pins that coord owns `question` but not the
 * field's value TYPE (a plain string? an object with an id, so a thread can hold
 * more than one?). A plain string is used because that is all
 * `mocks/08-submission-needs-input.html` renders — one `question-text` inside
 * one `question-thread`. If #11 lands a richer shape, the push helper here is
 * the only thing that needs revisiting; every assertion below is on the DOM and
 * the event stream, which contract note 3 makes the real contract.
 */
async function raiseQuestion(
  request: APIRequestContext,
  reference: string,
  revision: number,
  question: string,
): Promise<void> {
  const result = await pushFields(request, reference, revision, {
    question,
    status: "needs-input",
  })
  expect(
    result.outcome,
    "coord owns both `question` and `status`, so raising a question is applied",
  ).toBe("applied")
}

// ── seeding and reading, through the pinned customer surface ────────────────

const SEEDS = [
  {
    outcome: "A printable watering rota for the community greenhouse.",
    audience: "our Saturday volunteers",
    doneDefinition: "Anyone on shift can see which beds are due without asking.",
  },
  {
    outcome: "A monthly note listing tools that were never returned.",
    audience: "the workshop steward",
    doneDefinition: "The steward gets one list on the first of the month.",
  },
  {
    outcome: "A shared list of which raised beds are free to claim.",
    audience: "new plot holders",
    doneDefinition: "A new plot holder can pick a free bed unaided.",
  },
  {
    outcome: "A weekly count of visitors to the seed library.",
    audience: "our trustees",
    doneDefinition: "The trustees see one number per week, no spreadsheet.",
  },
]

/** Synthetic questions — plain language, no engineer-side vocabulary in them. */
const QUESTIONS = [
  "Should volunteers who swap a shift need the rota owner to confirm it, or is a straight swap enough?",
  "When a bed is watered twice in one day, should the rota show the later time or both?",
  "Do you want the printable rota to cover a whole month, or one week at a time?",
]

const ANSWERS = [
  "A straight swap is enough — nobody needs to confirm it.",
  "Show both times, so we can tell when a bed was double-watered.",
  "One week at a time, printed on a Friday.",
]

/** The verified-identity mechanism the contract's screens assume is present. */
function asCustomer(page: Page, email: string = CUSTOMER_EMAIL) {
  return page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": email })
}

interface Seeded {
  url: string
  reference: string
}

/** Author one submission through the pinned intake form (#9's surface). */
async function seedSubmission(page: Page, n: number): Promise<Seeded> {
  const seed = SEEDS[n % SEEDS.length]
  await page.goto("/intake")
  await page.getByTestId("field-outcome").fill(seed.outcome)
  await page.getByTestId("field-audience").fill(seed.audience)
  await page.getByTestId("field-done-definition").fill(seed.doneDefinition)
  await page.getByTestId("submit-intake").click()
  await expect(page.getByTestId("intake-receipt")).toBeVisible()

  const shown = (await page.getByTestId("submission-reference").innerText()).trim()
  const reference = shown.replace(/^Reference\s+/, "")
  expect(reference, "the receipt shows a SUB-XXXXXX reference").toMatch(REFERENCE)
  return { url: page.url(), reference }
}

/** The status slug the customer is actually shown on a detail screen. */
async function readStatus(page: Page, url: string): Promise<string | null> {
  await page.goto(url)
  await expect(page.getByTestId("submission-detail")).toBeVisible()
  return page.getByTestId("status-pill").getAttribute("data-status")
}

/**
 * RESUME, from the customer's side: type into the pinned composer and send.
 *
 * Contract note 3 leaves the transport of this write entirely unpinned ("Workers
 * … are free to choose field names and transport as long as the rendered DOM
 * matches"), so nothing here assumes a navigation, a form POST or a fetch. The
 * caller waits on an observable consequence — the `question.answered` event —
 * rather than on a mechanism.
 */
async function sendAnswer(page: Page, url: string, answer: string): Promise<void> {
  await page.goto(url)
  const field = page.getByTestId("answer-field")
  await expect(field, "the pause screen offers an answer composer").toBeVisible()
  await field.fill(answer)
  await page.getByTestId("submit-answer").click()
}

/** Wait for the customer's answer to surface on the bridge, and return it. */
async function awaitAnswerEvents(
  request: APIRequestContext,
  cursor: string | null,
  reference: string,
  expected: number,
): Promise<BridgeEvent[]> {
  let found: BridgeEvent[] = []
  await expect
    .poll(
      async () => {
        found = (await eventsSince(request, cursor)).filter(
          (e) => e.submission_id === reference && e.type === "question.answered",
        )
        return found.length
      },
      {
        message: `the customer's answer to ${reference} must reach coord as a \`question.answered\` event`,
        timeout: 15_000,
      },
    )
    .toBe(expected)
  return found
}

// ── the slice ───────────────────────────────────────────────────────────────

test.describe("ms-1 issue 11 question channel", () => {
  test.beforeEach(async ({ page }) => {
    await asCustomer(page)
  })

  test("a raised question pauses the submission at Needs your input", async ({
    page,
    request,
  }) => {
    const target = await seedSubmission(page, 0)
    expect(await readStatus(page, target.url), "a fresh submission is not paused").toBe(
      "describing",
    )
    await expect(
      page.getByTestId("pause-banner"),
      "nothing is paused before a question is raised",
    ).toHaveCount(0)

    await raiseQuestion(request, target.reference, 1100, QUESTIONS[0])

    await page.goto(target.url)
    const detail = page.getByTestId("submission-detail")
    await expect(detail).toBeVisible()
    await expect(detail, "the detail root carries the paused status").toHaveAttribute(
      "data-status",
      "needs-input",
    )

    const pill = page.getByTestId("status-pill")
    await expect(pill, "one status, once").toHaveCount(1)
    await expect(pill).toHaveAttribute("data-status", "needs-input")
    expect(
      (await pill.innerText()).trim(),
      "contract § status vocabulary pins this wording",
    ).toBe(NEEDS_INPUT_TEXT)

    // The pause is stated to the customer in the contract's exact words: "The
    // mock's copy … is a black-box guarantee, not decoration."
    const banner = page.getByTestId("pause-banner")
    await expect(banner).toBeVisible()
    expect((await banner.innerText()).trim()).toBe(PAUSE_COPY)

    // …and the whole pinned composer is there to end the pause with.
    for (const testid of QUESTION_TESTIDS) {
      await expect(
        page.getByTestId(testid),
        `the needs-input screen renders \`${testid}\``,
      ).toBeVisible()
    }
    expect(
      (await page.getByTestId("submit-answer").innerText()).trim(),
      "contract § Needs-your-input (08) pins this button text",
    ).toBe(SEND_ANSWER_LABEL)

    // It is still the same submission, not a screen about a question in the
    // abstract.
    expect(await page.getByTestId("submission-reference").innerText()).toContain(
      target.reference,
    )
  })

  test("the customer is shown the question the team actually raised", async ({
    page,
    request,
  }) => {
    // The portal never authors a question — it mirrors a coord-owned fact. Two
    // submissions, two different questions, so a hard-coded placeholder or a
    // question leaking between records both fail here.
    const first = await seedSubmission(page, 0)
    const second = await seedSubmission(page, 1)

    await raiseQuestion(request, first.reference, 1200, QUESTIONS[0])
    await raiseQuestion(request, second.reference, 1200, QUESTIONS[1])

    for (const [target, question, other] of [
      [first, QUESTIONS[0], QUESTIONS[1]],
      [second, QUESTIONS[1], QUESTIONS[0]],
    ] as const) {
      await page.goto(target.url)
      const text = page.getByTestId("question-text")
      await expect(text, "one open question, once").toHaveCount(1)

      // Whitespace is collapsed before comparing: the mock wraps its question
      // across source lines, and the contract pins the question's *content*,
      // not its line breaks.
      const shown = (await text.innerText()).replace(/\s+/g, " ").trim()
      expect(shown, `${target.reference} shows the question coord raised`).toBe(question)
      expect(
        shown,
        "a question raised on another submission must not appear here",
      ).not.toBe(other)

      const body = await page.locator("body").innerText()
      expect(body.replace(/\s+/g, " ")).not.toContain(other)

      // The composer starts empty — the customer has not answered yet.
      expect(
        await page.getByTestId("answer-field").inputValue(),
        "an unanswered question offers a blank composer",
      ).toBe("")
    }
  })

  test("no other customer action is offered while a question is open", async ({
    page,
    request,
  }) => {
    // Contract § "Question channel", verbatim: "no other customer action should
    // be available on that screen while a question is open." This is the whole
    // meaning of *pause* — the submission is not simultaneously waiting on a
    // sign-off, and the customer is not asked to make two decisions at once.
    const target = await seedSubmission(page, 2)

    // Give it something to hide: a design round pushed before the question is
    // raised must not leave its approve/request-changes affordances on screen.
    //
    // TODO(test-author): the contract pins neither the value type of
    // `design_round`/`decomposition`/`artifacts` nor whether an implementation
    // that has not modelled them yet may reject the write, so this push is
    // tolerant of any per-item outcome (see the same note in
    // `15-sync-bridge.spec.ts`). What is not tolerant is the screen afterwards.
    await pushFields(request, target.reference, 1300, {
      design_round: "A first proposal for the watering rota",
      decomposition: "A printable rota page; a way to swap a shift",
      status: "awaiting-signoff",
    })

    await raiseQuestion(request, target.reference, 1301, QUESTIONS[0])

    await page.goto(target.url)
    await expect(page.getByTestId("pause-banner")).toBeVisible()

    for (const testid of OTHER_ACTION_TESTIDS) {
      await expect(
        page.getByTestId(testid),
        `a paused submission offers no \`${testid}\``,
      ).toHaveCount(0)
    }

    // …and nothing wearing one of those decisions as a label, however it is
    // marked up.
    await expect(
      page.getByRole("button", { name: /approve|request changes|sign off/i }),
      "the only decision on a paused screen is the answer",
    ).toHaveCount(0)
    await expect(
      page.getByRole("link", { name: /approve|request changes|sign off/i }),
      "the only decision on a paused screen is the answer",
    ).toHaveCount(0)

    // TODO(test-author): the contract does not say whether `round-history-link`
    // (a read-only navigation, not an action) survives on a paused screen, so it
    // is deliberately absent from OTHER_ACTION_TESTIDS. Only affordances that
    // ask the customer to *decide* are asserted away.
  })

  test("answering sends the answer to coord as a question.answered event", async ({
    page,
    request,
  }) => {
    const target = await seedSubmission(page, 0)
    await raiseQuestion(request, target.reference, 1400, QUESTIONS[0])

    const start = await drainToCursor(request)
    await sendAnswer(page, target.url, ANSWERS[0])

    // `answer` is portal-owned (contract § sole-writer table), which makes it a
    // customer-authored fact, which is exactly what the bridge carries out:
    // `question.answered` is one of the four pinned event types.
    const [event] = await awaitAnswerEvents(request, start, target.reference, 1)

    // The pinned envelope, same as every other event on this stream.
    expect(typeof event.id, "`id` is an opaque string").toBe("string")
    expect(event.id.length).toBeGreaterThan(0)
    expect(Number.isInteger(event.revision), "`revision` is an integer").toBe(true)
    expect(event.submission_id).toBe(target.reference)
    expect(event.occurred_at, "`occurred_at` is ISO-8601 UTC").toMatch(ISO_8601_Z)
    expect(typeof event.payload, "`payload` is an object").toBe("object")
    expect(event.payload).not.toBeNull()

    // One answer, one event — the answer is not re-announced on every later pull.
    const again = (await eventsSince(request, start)).filter(
      (e) => e.submission_id === target.reference,
    )
    expect(
      again.map((e) => e.type),
      "answering produces exactly one customer-authored fact",
    ).toEqual(["question.answered"])

    // TODO(test-author): the contract shows `payload` as `{ }` and never says
    // what a `question.answered` payload contains — not even whether the answer
    // text rides in it or is fetched separately. So the answer's *content* is
    // not asserted on the wire. `JDonaghy/claude-coordinator#1982` cannot depend
    // on fields nobody pinned either; if #11 pins a payload shape, this is where
    // it belongs.
  })

  test("the portal never resumes the thread by itself — only coord's status push does", async ({
    page,
    request,
  }) => {
    const target = await seedSubmission(page, 1)
    await raiseQuestion(request, target.reference, 1500, QUESTIONS[1])

    const start = await drainToCursor(request)
    await sendAnswer(page, target.url, ANSWERS[1])
    await awaitAnswerEvents(request, start, target.reference, 1)

    // `status` is coord-owned and the portal "may never write" it (contract §
    // sole-writer table; issue #10: "the portal renders, it does not derive").
    // So an answered question does NOT let the portal decide the work has
    // resumed — it decides nothing. The customer stays on the status coord last
    // pushed until coord pushes another.
    expect(
      await readStatus(page, target.url),
      "answering is a portal-owned write; it must not move a coord-owned status",
    ).toBe("needs-input")

    // TODO(test-author): the contract is silent on what the paused screen looks
    // like in this window — between the answer being sent and coord pushing the
    // next status. Two readings are both defensible: keep rendering the pause
    // banner (rendered content is "a pure function of its status", per the route
    // table) or show the answer as sent. It pins no `data-testid` for a sent
    // answer, so neither is asserted here. What IS asserted, because the
    // ownership table settles it, is that the status did not move.

    // RESUME, properly: coord observes the event and pushes the work onward.
    const resumed = await pushFields(request, target.reference, 1501, {
      status: "in-progress",
    })
    expect(resumed.outcome).toBe("applied")

    await page.goto(target.url)
    expect(
      await page.getByTestId("status-pill").getAttribute("data-status"),
      "coord's push is what resumes the thread",
    ).toBe("in-progress")

    // The pause is over, so nothing may still claim it isn't.
    for (const testid of ["pause-banner", "answer-field", "submit-answer"]) {
      await expect(
        page.getByTestId(testid),
        `a resumed submission is no longer paused — no \`${testid}\``,
      ).toHaveCount(0)
    }
    const body = await page.locator("body").innerText()
    expect(body, "a resumed submission does not still say work is paused").not.toContain(
      PAUSE_COPY,
    )
  })

  test("an answered question is durable, and its event replays from a cursor", async ({
    page,
    request,
  }) => {
    // CLAUDE.md and issue #9's framing: a submission is a durable record, not a
    // live session. An answer given once must survive the customer closing the
    // tab, and must survive a daemon that restarts and replays from its cursor —
    // "so a submission is never lost to a daemon outage".
    const target = await seedSubmission(page, 2)
    await raiseQuestion(request, target.reference, 1600, QUESTIONS[2])

    const start = await drainToCursor(request)
    await sendAnswer(page, target.url, ANSWERS[2])
    await awaitAnswerEvents(request, start, target.reference, 1)

    // A fresh page, and a fresh reload, do not re-open or duplicate anything.
    await page.goto(target.url)
    await page.reload()

    const once = (await eventsSince(request, start)).filter(
      (e) => e.submission_id === target.reference,
    )
    const twice = (await eventsSince(request, start)).filter(
      (e) => e.submission_id === target.reference,
    )
    expect(twice, "replaying the same cursor returns the same events").toEqual(once)
    expect(
      once.filter((e) => e.type === "question.answered"),
      "reloading the screen does not re-answer the question",
    ).toHaveLength(1)

    // Revisions are monotonic and never reused, so the daemon can order the
    // answer against everything else it pulled.
    for (let i = 1; i < once.length; i++) {
      expect(once[i].revision).toBeGreaterThan(once[i - 1].revision)
    }
  })

  test("coord may never write the customer's answer", async ({ page, request }) => {
    // Issue #11's ownership delta, verbatim: "coord owns the question, the
    // portal owns the answer". `15-sync-bridge.spec.ts` asserts the generic
    // rejection shape across every portal-owned field; what is asserted here is
    // the half that is #11's own — that a refused `answer` write changes nothing
    // the *customer* sees, so a rejected push cannot put words in their mouth.
    const target = await seedSubmission(page, 3)
    await raiseQuestion(request, target.reference, 1700, QUESTIONS[0])

    const start = await drainToCursor(request)
    const forged = "Yes, go ahead — this answer was not written by the customer."

    const rejected = await pushFields(request, target.reference, 1701, {
      answer: forged,
    })
    expect(rejected.outcome, "`answer` is portal-owned").toBe("rejected")
    expect(rejected.reason).toBe("not_owned:answer")

    // Whole-update atomicity: a valid coord-owned sibling does not smuggle it in.
    const mixed = await pushFields(request, target.reference, 1702, {
      status: "in-progress",
      answer: forged,
    })
    expect(mixed.outcome).toBe("rejected")
    expect(mixed.reason).toBe("not_owned:answer")

    await page.goto(target.url)
    expect(
      await page.getByTestId("status-pill").getAttribute("data-status"),
      "a rejected update applies none of its fields, including the valid sibling",
    ).toBe("needs-input")
    await expect(
      page.getByTestId("pause-banner"),
      "a forged answer does not end the pause",
    ).toBeVisible()

    const body = await page.locator("body").innerText()
    expect(
      body.replace(/\s+/g, " "),
      "coord cannot put an answer in the customer's mouth",
    ).not.toContain(forged)

    // …and nothing coord wrote is announced back to coord as a customer fact.
    const events = (await eventsSince(request, start)).filter(
      (e) => e.submission_id === target.reference,
    )
    expect(events, "a rejected coord write is not a customer-authored fact").toEqual([])

    // The customer answering afterwards still works — the refusal left the
    // channel intact, not wedged.
    await sendAnswer(page, target.url, ANSWERS[0])
    await awaitAnswerEvents(request, start, target.reference, 1)
  })

  test("a submission with no open question offers no answer channel", async ({
    page,
    request,
  }) => {
    // The inverse of the pause: nothing to answer means no composer to answer
    // in. Without this, "paused until you answer" is decoration — a permanently
    // present answer box would let a customer answer a question nobody asked,
    // and would send coord a `question.answered` for a question that does not
    // exist.
    const target = await seedSubmission(page, 0)
    const start = await drainToCursor(request)

    let revision = 1800
    for (const status of ["describing", "in-design", "planned", "in-progress", "shipped"]) {
      expect(
        (await pushFields(request, target.reference, revision++, { status })).outcome,
      ).toBe("applied")

      await page.goto(target.url)
      await expect(page.getByTestId("submission-detail")).toBeVisible()

      for (const testid of QUESTION_TESTIDS) {
        await expect(
          page.getByTestId(testid),
          `\`${status}\` has no open question — no \`${testid}\``,
        ).toHaveCount(0)
      }
      const body = await page.locator("body").innerText()
      expect(body, `\`${status}\` is not paused on a question`).not.toContain(PAUSE_COPY)
    }

    const events = (await eventsSince(request, start)).filter(
      (e) => e.type === "question.answered",
    )
    expect(events, "no question was ever raised, so nothing was ever answered").toEqual([])
  })

  test("a second question re-opens the pause and is answerable in turn", async ({
    page,
    request,
  }) => {
    // Issue #11 is a loop, not a one-shot: raise -> pause -> resume, as many
    // times as the work needs. A channel that only works once quietly strands
    // the second question forever.
    const target = await seedSubmission(page, 1)
    const start = await drainToCursor(request)

    await raiseQuestion(request, target.reference, 1900, QUESTIONS[0])
    await sendAnswer(page, target.url, ANSWERS[0])
    await awaitAnswerEvents(request, start, target.reference, 1)

    // Coord resumes, works on, and then needs something else.
    expect(
      (await pushFields(request, target.reference, 1901, { status: "in-progress" })).outcome,
    ).toBe("applied")
    await raiseQuestion(request, target.reference, 1902, QUESTIONS[1])

    await page.goto(target.url)
    await expect(page.getByTestId("pause-banner")).toBeVisible()
    expect(await page.getByTestId("status-pill").getAttribute("data-status")).toBe(
      "needs-input",
    )

    const shown = (await page.getByTestId("question-text").innerText())
      .replace(/\s+/g, " ")
      .trim()
    expect(shown, "the open question is the one that is open now").toBe(QUESTIONS[1])
    expect(
      await page.getByTestId("answer-field").inputValue(),
      "a newly raised question gets a blank composer, not last round's answer",
    ).toBe("")

    await sendAnswer(page, target.url, ANSWERS[1])
    const events = await awaitAnswerEvents(request, start, target.reference, 2)
    expect(
      events[0].revision,
      "two answers, two events, in the order they were given",
    ).toBeLessThan(events[1].revision)

    // TODO(test-author): the contract pins one `question-thread` containing one
    // `question-text` and says nothing about whether an answered question stays
    // readable underneath the new one (the round-history hooks of #13 have no
    // counterpart here). So this asserts only that the CURRENT question is the
    // one shown; whether the first exchange remains visible is unspecified and
    // is left to #11 to decide.
  })

  test("an empty answer does not end the pause", async ({ page, request }) => {
    const target = await seedSubmission(page, 2)
    await raiseQuestion(request, target.reference, 2000, QUESTIONS[2])

    const start = await drainToCursor(request)

    // "Work is paused until you answer" — whitespace is not an answer, and
    // sending one must not tell coord the customer has replied.
    for (const blank of ["", "   "]) {
      await page.goto(target.url)
      await page.getByTestId("answer-field").fill(blank)
      const button = page.getByTestId("submit-answer")
      // A disabled button is a perfectly good way to refuse a blank answer, so
      // it is accepted as a pass for this half rather than clicked into a
      // timeout.
      if (await button.isEnabled()) await button.click()
    }

    // Then a real answer — which both proves the channel still works and flushes
    // the stream, so a blank submission that HAD produced an event would show up
    // here as a second one.
    await sendAnswer(page, target.url, ANSWERS[2])
    const events = await awaitAnswerEvents(request, start, target.reference, 1)
    expect(events, "only the real answer reached coord").toHaveLength(1)

    // TODO(test-author): the contract pins no validation copy, no error
    // `data-testid` and no disabled/enabled rule for `submit-answer`, so how a
    // blank answer is refused is deliberately unasserted — only that it does not
    // count as an answer.
  })

  test("the question screen shows no engineer-side identifier", async ({
    page,
    request,
  }) => {
    // Contract note 6, treated as an absolute: "no mock renders any GitHub issue
    // number, PR number, branch name, or coord-side identifier anywhere in
    // customer-facing copy", and issue #16's "They never see a branch, an issue
    // number, or a live agent". A question is the most likely place for that
    // wall to leak, because its text originates engineer-side — including,
    // per this issue, from a worker's `STUCK:`.
    const target = await seedSubmission(page, 3)
    await raiseQuestion(request, target.reference, 2100, QUESTIONS[0])

    await page.goto(target.url)
    // Positive control first: a screen that failed to render leaks nothing and
    // proves nothing.
    await expect(page.getByTestId("question-thread")).toBeVisible()
    await expect(page.getByTestId("pause-banner")).toBeVisible()

    // Scoped to the submission itself, not the whole document: the contract
    // pins `brand-home` as a header hook but never pins its TEXT, so the
    // product's own name (whatever it turns out to be) is not evidence of a
    // leak. Everything inside `submission-detail` is copy about this customer's
    // work, and that is where the wall has to hold.
    const detail = page.getByTestId("submission-detail")
    const body = (await detail.innerText()).replace(/\s+/g, " ")
    expect(body, "the screen really rendered").toContain(target.reference)
    expect(body).toContain(NEEDS_INPUT_TEXT)
    expect(body, "the screen really rendered the question").toContain(
      QUESTIONS[0].slice(0, 40),
    )

    const FORBIDDEN: Array<[RegExp, string]> = [
      [/\bSTUCK:/i, "the worker's escalation vocabulary is engineer-side"],
      [/\bissue\s*#?\d+/i, "customers never see an issue number"],
      [/#\d+/, "customers never see a GitHub number"],
      [/\bpull request\b/i, "no PR ever crosses the wall"],
      [/\bPR\b/, "no PR ever crosses the wall"],
      [/\bbranch(es)?\b/i, "customers never see a branch"],
      [/\bcommit(s|ted)?\b/i, "customers never see a commit"],
      [/\bworktree\b/i, "customers never see a worktree"],
      [/\bagent\b/i, "customers never see a live agent"],
      [/\bworker\b/i, "customers never see an engineer-side worker"],
      [/\bgithub\b/i, "the engineer side is not named"],
      [/\bdaemon\b/i, "the daemon is not a customer-facing concept"],
      [/\b(feat|fix|chore|refactor)\/[a-z0-9-]+/i, "customers never see a branch name"],
    ]
    for (const [pattern, why] of FORBIDDEN) {
      expect(body, `the needs-input screen: ${why}`).not.toMatch(pattern)
    }

    // TODO(test-author): the question TEXT itself originates engineer-side, and
    // the contract does not say whether the portal is responsible for scrubbing
    // a question coord pushed with an issue number in it, or whether that is
    // coord's own duty before it ever crosses the bridge. This test therefore
    // uses a clean synthetic question and asserts that the portal's own chrome
    // and framing add no identifier — it does not assert that a dirty question
    // gets sanitised, because nobody has pinned who owns that.
  })
})
