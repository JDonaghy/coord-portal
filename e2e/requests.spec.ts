import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test"

/**
 * Black-box coverage for issue #104 ([portal] An operator can see every lead
 * and every delivery, but only their own submissions), driving the real
 * Worker under `wrangler dev` with real local D1 — see `playwright.config.ts`.
 * This is the project's own `e2e/` tier, not the sealed acceptance suite
 * under `tests/acceptance/`; per CLAUDE.md this repo still ships its own
 * black-box coverage for behaviour-changing work, and `GET /requests`
 * (`src/routes/requests.ts`, wired in `src/pages.ts`) had none before this
 * file.
 *
 * WHAT THIS FILE PROVES, the same three things `e2e/deliveries.spec.ts`
 * proves for issue #55's `/deliveries` — the precedent #104 itself names:
 *
 *   UNSCOPED   `GET /requests` lists every customer's submissions on one
 *              screen. `GET /submissions` (issue #12) is ownership-scoped to
 *              the caller's own Access identity and structurally cannot.
 *   GATED      the exact same indistinguishable 404 `/leads` and
 *              `/deliveries` return for anyone `readOperator` rejects — an
 *              ordinary customer, or nobody at all — never a 403 and never a
 *              redirect.
 *   UNCHANGED  `GET /submissions` still shows a customer only their own rows,
 *              never another customer's, even once that other customer's
 *              submission is showing up on `/requests`.
 *
 * Plus the one thing this screen adds beyond a plain list: the current design
 * round and its verdict, read off the same submission `/submissions/:id`
 * would derive a status from — issue #104's own "current round and verdict"
 * requirement.
 *
 * Issue #329 adds a second per-row extra, covered further down: a shipped
 * submission's customer survey response (#328), or an explicit "Not
 * answered" when nobody has given one yet.
 *
 * Every address and string below is invented, on the reserved `example.test`
 * TLD — CLAUDE.md rule 1. `serve:test` does not wipe `.wrangler/state`
 * between runs, so identities are tagged unique per run rather than risking a
 * row a previous run left behind.
 */

const DEV_OPERATOR = "ops@example.test"

const SERVICE_TOKEN = {
  "CF-Access-Client-Id": "a4d1f8c936b0e75218fa63d0c9e17b4a.access",
  "CF-Access-Client-Secret":
    "9e3b7c410fd6285ab13e0c964d8f27a5b619cde3f082a5c17604b9d2e8f31ac",
}

function uniqueEmail(local: string): string {
  const tag = Math.random().toString(36).slice(2, 10)
  return `${local}-${tag}@example.test`
}

async function contextFor(browser: Browser, baseURL: string | undefined, email: string | null) {
  return browser.newContext({
    baseURL,
    extraHTTPHeaders: email ? { "Cf-Access-Authenticated-User-Email": email } : {},
  })
}

interface Seeded {
  reference: string
}

async function seedSubmission(page: Page, email: string, tag: string, outcome?: string): Promise<Seeded> {
  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": email })
  await page.goto("/intake")
  await page
    .getByTestId("field-outcome")
    .fill(outcome ?? `A synthetic outcome for e2e requests coverage (${tag}).`)
  await page.getByTestId("field-audience").fill("synthetic e2e readers")
  await page.getByTestId("field-done-definition").fill("The requests e2e suite goes green.")
  await page.getByTestId("submit-intake").click()
  await expect(page.getByTestId("intake-receipt")).toBeVisible()

  const reference = (await page.getByTestId("submission-reference").innerText())
    .trim()
    .replace(/^Reference\s+/, "")
  return { reference }
}

async function push(
  request: APIRequestContext,
  reference: string,
  revision: number,
  fields: Record<string, unknown>,
): Promise<{ outcome: string }> {
  const res = await request.post("/api/bridge/push", {
    data: { updates: [{ submission_id: reference, revision, fields }] },
    headers: SERVICE_TOKEN,
  })
  expect(res.status()).toBe(200)
  const body = (await res.json()) as { results: Array<{ outcome: string }> }
  const result = body.results[0]
  if (!result) throw new Error("push produced no result")
  return result
}

const TURNSTILE_FIELD = "cf-turnstile-response"

/** Waits for the dev Turnstile stand-in to fill itself in — same wait `e2e/leads.spec.ts` and `e2e/project-naming.spec.ts` use. */
async function settleBotGate(page: Page) {
  await page.waitForFunction(
    (field) => {
      const input = document.querySelector(`input[name="${field}"]`) as HTMLInputElement | null
      return !!input && input.value.length > 0
    },
    TURNSTILE_FIELD,
    { timeout: 15_000 },
  )
}

/**
 * Promotes a lead through `/start` → `/leads/:id` — issue #129's "the first
 * project is minted the instant a lead promotes" gives this submission a
 * project immediately, which is what the naming test below needs: a project
 * `titleFromOutcome`'s fallback would otherwise be the only thing on offer
 * for. Same shape `e2e/project-naming.spec.ts`'s own `seedPromotedLead`
 * uses, duplicated here rather than imported — this repo's `e2e/` specs each
 * carry their own fixture helpers rather than sharing a file across them.
 */
async function seedPromotedLead(
  browser: Browser,
  baseURL: string | undefined,
  operator: Page,
  summary: string,
  email: string,
): Promise<{ reference: string }> {
  const strangerContext = await contextFor(browser, baseURL, null)
  const stranger = await strangerContext.newPage()
  await stranger.goto("/start")
  await stranger.getByTestId("field-lead-summary").fill(summary)
  await stranger.getByTestId("field-lead-email").fill(email)
  await settleBotGate(stranger)
  await stranger.getByTestId("submit-lead").click()
  await expect(stranger.getByTestId("lead-receipt")).toBeVisible()
  await strangerContext.close()

  await operator.goto("/leads")
  const row = operator.getByTestId("lead-row").filter({ hasText: summary })
  await row.getByTestId("review-lead").click()
  await operator.getByTestId("promote-button").click()
  await expect(operator.getByTestId("lead-detail")).toHaveAttribute("data-status", "promoted")
  const reference = (await operator.getByTestId("promoted-submission-reference").innerText())
    .trim()
    .replace(/^Promoted to submission\s+/, "")
  return { reference }
}

function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

interface RequestRow {
  status: string | null
  customer: string
  reference: string
  pillText: string
  round: string | null
  title: string
  titleHref: string | null
  /** Issue #329's rating badge — `null` when the row carries none at all
   * (not yet shipped), otherwise the pill's own text ("Not answered" or the
   * rating label) and whether `data-answered` says "true" or "false". */
  survey: string | null
  surveyAnswered: string | null
}

/** The one `request-row` on `/requests` whose `request-reference` is `reference`. */
async function readRequestRow(operator: Page, reference: string): Promise<RequestRow> {
  await operator.goto("/requests")
  const row = operator.getByTestId("request-row").filter({ hasText: reference })
  await expect(row, `exactly one request-row for ${reference}`).toHaveCount(1)

  const round = row.getByTestId("request-round")
  const title = row.getByTestId("request-title")
  const survey = row.getByTestId("request-survey")
  return {
    status: await row.getAttribute("data-status"),
    customer: flat(await row.getByTestId("request-customer").innerText()),
    reference: flat(await row.getByTestId("request-reference").innerText()),
    pillText: flat(await row.getByTestId("status-pill").innerText()),
    round: (await round.count()) > 0 ? flat(await round.innerText()) : null,
    title: flat(await title.innerText()),
    titleHref: await title.getAttribute("href"),
    survey: (await survey.count()) > 0 ? flat(await survey.innerText()) : null,
    surveyAnswered: (await survey.count()) > 0 ? await survey.getAttribute("data-answered") : null,
  }
}

test("the operator's /requests lists every customer's submissions on one screen — /submissions stays scoped to its own caller", async ({
  browser,
  baseURL,
}) => {
  const aliceEmail = uniqueEmail("e2e-requests-alice")
  const bobEmail = uniqueEmail("e2e-requests-bob")

  const aliceContext = await contextFor(browser, baseURL, aliceEmail)
  const alicePage = await aliceContext.newPage()
  const alice = await seedSubmission(alicePage, aliceEmail, "alice")

  const bobContext = await contextFor(browser, baseURL, bobEmail)
  const bobPage = await bobContext.newPage()
  const bob = await seedSubmission(bobPage, bobEmail, "bob")

  // A design round, published and awaiting sign-off, on Bob's submission only
  // — this is issue #104's "current round and verdict" requirement: the
  // screen must surface it, not just the plain status.
  const roundResult = await push(bobContext.request, bob.reference, 1, {
    design_round: {
      outcome_definition: "A synthetic outcome definition for e2e requests coverage.",
      decomposition: ["A synthetic first step", "A synthetic second step"],
    },
    status: "awaiting-signoff",
  })
  expect(roundResult.outcome).toBe("applied")

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()

  // The operator surface itself: the shared operator header, marked current —
  // same "reuse the /leads precedent" issue #104 explicitly follows.
  await operator.goto("/requests")
  await expect(operator.getByTestId("identity-email")).toHaveText(`signed in as ${DEV_OPERATOR}`)
  await expect(operator.getByTestId("nav-requests")).toHaveAttribute("aria-current", "page")

  const aliceRow = await readRequestRow(operator, alice.reference)
  expect(aliceRow.status).toBe("describing")
  expect(aliceRow.customer).toBe(aliceEmail)
  expect(aliceRow.round, "a submission with no design round shows no round badge").toBeNull()
  // Issue #329: no rating badge at all before a submission ships — see the
  // dedicated test below for the shipped cases.
  expect(aliceRow.survey, "no rating badge before shipped").toBeNull()
  // Issue #316: the title names the request (here, the plain synthetic
  // outcome `seedSubmission` filed — no greeting to skip), and it is itself
  // the link into the detail screen, not an inert span.
  expect(aliceRow.title).toBe("A synthetic outcome for e2e requests coverage (alice).")
  expect(aliceRow.titleHref, "the title links into /requests/:id").toMatch(/^\/requests\/[^/]+$/)

  const bobRow = await readRequestRow(operator, bob.reference)
  expect(bobRow.status).toBe("awaiting-signoff")
  // `status-pill` is `statusText` (`src/submissions.ts`), the same
  // customer-facing status pill the customer's own screens show — unchanged
  // by issue #316, which only touches the round pill below.
  expect(bobRow.pillText).toBe("Awaiting your sign-off")
  expect(bobRow.customer).toBe(bobEmail)
  expect(bobRow.round).toContain("Round 1")
  // Issue #316: the round pill is operator-facing wording, not the
  // customer-visible `VERDICT_TEXT["pending"]` ("Awaiting your sign-off")
  // this same screen used to render verbatim — this operator is not the one
  // being asked to sign off.
  expect(bobRow.round).toContain("Awaiting customer sign-off")
  expect(bobRow.round).not.toContain("Awaiting your sign-off")

  // /submissions is unchanged: each customer still sees only their own
  // reference, never the other's.
  await alicePage.goto("/submissions")
  await expect(alicePage.getByText(alice.reference)).toBeVisible()
  await expect(alicePage.getByText(bob.reference)).toHaveCount(0)

  await bobPage.goto("/submissions")
  await expect(bobPage.getByText(bob.reference)).toBeVisible()
  await expect(bobPage.getByText(alice.reference)).toHaveCount(0)

  await Promise.all([aliceContext.close(), bobContext.close(), operatorContext.close()])
})

/**
 * Issue #316. An email-intake submission's `outcome` is the customer's raw
 * message, so its first line is a salutation — before this fix, `/requests`
 * titled the row with exactly that greeting, and the only clickable thing on
 * the row was a button labelled "Reassign". This pins the two fixes
 * together, the way the issue itself asks for: "an operator can find a known
 * submission by its title and open it from the list".
 */
test("an email-intake greeting does not become the row's title, and the title is what opens the request", async ({
  browser,
  baseURL,
}) => {
  const email = uniqueEmail("e2e-requests-greeting")
  const context = await contextFor(browser, baseURL, email)
  const page = await context.newPage()

  // The second line is deliberately kept to 79 characters — at or under
  // `truncateTitle`'s 80-character threshold (`src/submissions.ts`, issue
  // #319's shared `titleFromOutcome`) — so this test asserts the
  // salutation-skip behaviour on its own, untangled from truncation, which
  // `test/requests.test.ts` already covers on its own.
  const { reference } = await seedSubmission(
    page,
    email,
    "greeting",
    "Hi,\nYour name came up when I was asking about a synthetic project for e2e coverage.",
  )

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()

  const row = await readRequestRow(operator, reference)
  expect(row.title).not.toBe("Hi,")
  expect(row.title).toBe("Your name came up when I was asking about a synthetic project for e2e coverage.")

  // The title itself is the way in — not a button named after an unrelated
  // action available once you arrive.
  const titleLink = operator
    .getByTestId("request-row")
    .filter({ hasText: reference })
    .getByTestId("request-title")
  await titleLink.click()
  await expect(operator.getByTestId("request-detail")).toBeVisible()
  await expect(operator.getByTestId("request-detail-reference")).toHaveText(reference)

  // Issue #319: the detail heading comes from `titleOf`, not
  // `titleFromOutcome` — #316 only fixed the list above. Before #319 this
  // heading, and the round-history back-link built from the same `titleOf`
  // call, still read exactly "Hi,".
  await expect(operator.getByTestId("request-detail-title")).not.toHaveText("Hi,")
  await expect(operator.getByTestId("request-detail-title")).toHaveText(
    "Your name came up when I was asking about a synthetic project for e2e coverage.",
  )

  await operator.getByTestId("request-rounds-link").click()
  await expect(operator.getByTestId("back-to-request")).not.toHaveText("← Hi,")
  await expect(operator.getByTestId("back-to-request")).toHaveText(
    "← Your name came up when I was asking about a synthetic project for e2e coverage.",
  )

  await Promise.all([context.close(), operatorContext.close()])
})

/**
 * Issue #329's "the rating on the request row": `/requests` already carries
 * a project name, client and status per row, and a shipped submission's
 * survey response (#328) now shows up right there too — no second screen for
 * the common case of "did this customer already say how it went". The issue
 * is explicit that a shipped-but-silent submission must read as "not
 * answered", never as a bare absence indistinguishable from "not shipped
 * yet" — the three states this test walks through in order.
 */
test("the request row shows no badge before shipped, 'Not answered' once shipped and silent, and the rating once answered", async ({
  browser,
  baseURL,
}) => {
  const email = uniqueEmail("e2e-requests-survey-badge")
  const context = await contextFor(browser, baseURL, email)
  const page = await context.newPage()
  const { reference } = await seedSubmission(page, email, "survey-badge")
  // `seedSubmission` leaves `page` on the submission's own detail screen —
  // this is the one URL a customer (not an operator) can answer the survey
  // from, captured now before anything else navigates `page` away from it.
  const submissionUrl = page.url()

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()

  // Not shipped yet: no badge at all, same as any other in-flight status.
  const inProgress = await push(context.request, reference, 1, { status: "in-progress" })
  expect(inProgress.outcome).toBe("applied")
  let row = await readRequestRow(operator, reference)
  expect(row.status).toBe("in-progress")
  expect(row.survey, "no rating badge before shipped").toBeNull()

  // Shipped, nobody has answered yet.
  const shipped = await push(context.request, reference, 2, { status: "shipped" })
  expect(shipped.outcome).toBe("applied")
  row = await readRequestRow(operator, reference)
  expect(row.status).toBe("shipped")
  expect(row.surveyAnswered).toBe("false")
  expect(row.survey).toBe("Not answered")

  // The customer answers, on their own shipped screen — the existing #328
  // capture path, untouched by this issue.
  await page.goto(submissionUrl)
  await page.getByTestId("survey-open-button").click()
  await page.locator('[data-testid="survey-rating-option"][data-value="2"] input').check()
  await page.getByTestId("survey-submit").click()
  await expect(page.getByTestId("survey-response")).toHaveAttribute("data-rating", "2")

  row = await readRequestRow(operator, reference)
  expect(row.surveyAnswered).toBe("true")
  expect(row.survey).toBe("2 stars — Unhappy")

  await Promise.all([context.close(), operatorContext.close()])
})

/**
 * Issue #316's "Expected" section, second half: "Prefer the project name
 * where the submission has one; otherwise the first line of `outcome`...".
 * `listAllRequestRows` (`src/routes/requests.ts`) now batches a
 * `getProjectsByIds` lookup and renders `project?.name ?? titleFromOutcome(...)`
 * — this is the black-box assertion that the project-name half of that
 * fallback actually reaches the row, not just the derived-title half the
 * test above already covers.
 */
test("an operator-named project's name is the row title on /requests, ahead of the derived outcome title", async ({
  browser,
  baseURL,
}) => {
  const tag = Math.random().toString(36).slice(2, 10)
  const summary = `A synthetic project-naming request check (${tag}).`
  const email = uniqueEmail("e2e-requests-project-name")

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()
  const { reference } = await seedPromotedLead(browser, baseURL, operator, summary, email)

  // Still on /leads/:id, right after promotion — #129 mints the project the
  // same instant, so the rename card is already there to name it with.
  await expect(operator.getByTestId("rename-project-card")).toBeVisible()
  const chosenName = `A synthetic named engagement (${tag})`
  await operator.getByTestId("rename-project-input").fill(chosenName)
  await operator.getByTestId("rename-project-submit").click()
  await expect(operator.getByTestId("rename-project-input")).toHaveValue(chosenName)

  // The row's title is now the operator-chosen name, not the promoted lead's
  // own summary — even though that summary is exactly what `titleFromOutcome`
  // would otherwise have derived from this submission's `outcome`.
  const row = await readRequestRow(operator, reference)
  expect(row.title).toBe(chosenName)
  expect(row.title).not.toBe(summary)

  await operatorContext.close()
})

test("the requests surface is a 404 to anyone who is not the operator, the same shape as a route that does not exist", async ({
  browser,
  baseURL,
}) => {
  const email = uniqueEmail("e2e-requests-hidden")

  const ownerContext = await contextFor(browser, baseURL, email)
  const ownerPage = await ownerContext.newPage()
  const seeded = await seedSubmission(ownerPage, email, "hidden-404")

  // The row's own owner, and nobody at all, both get a 404 — never a 403, and
  // never a redirect that would itself confirm an operator surface exists.
  for (const identity of [email, null]) {
    const context = await contextFor(browser, baseURL, identity)
    const response = await context.request.get("/requests")
    expect(response.status(), `GET /requests as ${identity ?? "nobody"}`).toBe(404)
    const body = await response.text()
    expect(body).toContain("We can't find that")
    expect(body).not.toContain(email)
    await context.close()
  }

  // Sanity: the row really is there, and the gate above — not a bug that
  // hides the whole route from everyone — is what stood in the way.
  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operatorResponse = await operatorContext.request.get("/requests")
  expect(operatorResponse.status()).toBe(200)
  expect(await operatorResponse.text()).toContain(seeded.reference)
  await operatorContext.close()

  await ownerContext.close()
})

/**
 * Comfortably past D1's ceiling of 100 bound parameters per statement, so the
 * test seeds its own failure condition rather than inheriting it from whatever
 * the rest of the suite happened to leave behind — see `src/d1.ts`.
 */
const OVER_D1_BIND_LIMIT = 105

/**
 * Seeds a submission straight through `POST /intake`, no browser, and returns
 * its customer-visible `SUB-XXXXXX` reference — the identifier `/requests`
 * renders and the bridge addresses a submission by. The 303's `Location`
 * carries the internal `sub_...` id instead, so the detail page it points at
 * is where the reference is read from.
 */
async function seedViaApi(request: APIRequestContext, tag: string): Promise<string> {
  const res = await request.post("/intake", {
    form: {
      outcome: `A synthetic outcome for e2e requests bulk coverage (${tag}).`,
      audience: "synthetic e2e readers",
      doneDefinition: "The requests e2e suite goes green at scale.",
    },
    maxRedirects: 0,
  })
  expect(res.status(), `POST /intake for ${tag}`).toBe(303)
  const location = res.headers()["location"]
  if (!location) throw new Error(`POST /intake for ${tag} returned no Location`)

  const detail = await request.get(location)
  expect(detail.status(), `GET ${location}`).toBe(200)
  const reference = /SUB-[0-9A-F]{6}/.exec(await detail.text())?.[0]
  if (!reference) throw new Error(`no submission reference on ${location}`)
  return reference
}

/**
 * REGRESSION, and the reason this file's other two tests went red in CI while
 * passing locally.
 *
 * `/requests` is the portal's first *unscoped* reader: it asks
 * `loadSignoffStates`/`loadStartWorkStates` (`src/rounds.ts`,
 * `src/startWork.ts`) about every submission the portal holds, and those build
 * one bound parameter per reference. D1 refuses a statement carrying more than
 * 100 of them (`D1_ERROR: too many SQL variables ...: SQLITE_ERROR`), so the
 * screen returned a bare 500 the moment the table passed 100 rows — invisible
 * against a fresh database and permanent against a real one. CI caught it only
 * because the full e2e suite accumulates submissions across every spec into
 * one shared `serve:test` database; this test makes it deterministic by
 * seeding past the ceiling itself.
 *
 * It also pins the half a naive `LIMIT 100` would break: a design round on a
 * submission far down the list still renders, so the chunked reads are being
 * merged rather than truncated.
 */
test("/requests holds up once the portal has more submissions than D1 will bind in one statement", async ({
  browser,
  baseURL,
}) => {
  test.slow()

  const email = uniqueEmail("e2e-requests-bulk")
  const context = await contextFor(browser, baseURL, email)

  // Seeded in small concurrent batches: 105 sequential round trips is most of
  // this test's wall clock, and 105 at once is a thundering herd at one
  // `wrangler dev`.
  const references: string[] = []
  for (let batch = 0; batch * 15 < OVER_D1_BIND_LIMIT; batch += 1) {
    const size = Math.min(15, OVER_D1_BIND_LIMIT - references.length)
    references.push(
      ...(await Promise.all(
        Array.from({ length: size }, (_unused, i) =>
          seedViaApi(context.request, `bulk-${batch * 15 + i}`),
        ),
      )),
    )
  }
  expect(references).toHaveLength(OVER_D1_BIND_LIMIT)

  // A round on the oldest and on the newest of the run. `/requests` orders
  // newest-created first, so these two sit at opposite ends of the list and
  // therefore in different chunks of the reference list the loaders bind —
  // both verdicts surviving is what proves the chunks are merged.
  const oldest = references[0]
  const newest = references[references.length - 1]
  if (!oldest || !newest) throw new Error("bulk seeding produced no references")

  for (const reference of [oldest, newest]) {
    const applied = await push(context.request, reference, 1, {
      design_round: {
        outcome_definition: "A synthetic outcome definition for e2e requests bulk coverage.",
        decomposition: ["A synthetic first step"],
      },
      status: "awaiting-signoff",
    })
    expect(applied.outcome).toBe("applied")
  }

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)

  // The plain HTTP answer first: before this fix the page was a 500, not a
  // rendering the browser could be asked anything about.
  const response = await operatorContext.request.get("/requests")
  expect(response.status(), "GET /requests over D1's bound-parameter ceiling").toBe(200)

  // Not a sample: every reference seeded above is on the one screen. A chunked
  // read that dropped or truncated a batch would show up right here.
  const body = await response.text()
  const missing = references.filter((reference) => !body.includes(reference))
  expect(missing, "every seeded submission is listed on /requests").toEqual([])

  const operator = await operatorContext.newPage()
  await operator.goto("/requests")
  await expect(operator.getByTestId("requests-list")).toBeVisible()
  expect(
    await operator.getByTestId("request-row").count(),
    "at least the submissions this test seeded",
  ).toBeGreaterThanOrEqual(OVER_D1_BIND_LIMIT)

  for (const reference of [oldest, newest]) {
    const row = operator.getByTestId("request-row").filter({ hasText: reference })
    await expect(row, `exactly one request-row for ${reference}`).toHaveCount(1)
    await expect(row).toHaveAttribute("data-status", "awaiting-signoff")
    await expect(row.getByTestId("request-round")).toHaveText(/Round 1/)
  }

  await Promise.all([context.close(), operatorContext.close()])
})

/* ─────────────────── issue #323: client/project filtering ──────────────── */

/**
 * Every `request-reference` currently rendered on `/requests` — for
 * asserting on the *set* of visible rows a filter narrows to, complementing
 * `readRequestRow`'s own "exactly one row" check above.
 */
async function visibleReferences(operator: Page): Promise<string[]> {
  const rows = operator.getByTestId("request-row")
  const count = await rows.count()
  const refs: string[] = []
  for (let i = 0; i < count; i += 1) {
    refs.push(flat(await rows.nth(i).getByTestId("request-reference").innerText()))
  }
  return refs
}

/** Promotes a lead into a submission and names its project — `seedPromotedLead`
 * plus the rename step `an operator-named project's name is the row title…`
 * above already exercises, factored out so the filter tests below can seed
 * two distinctly-labelled projects without repeating it inline. */
async function seedNamedProject(
  browser: Browser,
  baseURL: string | undefined,
  operator: Page,
  summary: string,
  email: string,
  projectName: string,
): Promise<{ reference: string }> {
  const seeded = await seedPromotedLead(browser, baseURL, operator, summary, email)
  await expect(operator.getByTestId("rename-project-card")).toBeVisible()
  await operator.getByTestId("rename-project-input").fill(projectName)
  await operator.getByTestId("rename-project-submit").click()
  await expect(operator.getByTestId("rename-project-input")).toHaveValue(projectName)
  return seeded
}

test("the client filter narrows /requests to one customer, and the project filter hides itself until there is more than one project on offer", async ({
  browser,
  baseURL,
}) => {
  const tag = Math.random().toString(36).slice(2, 10)
  const aliceEmail = uniqueEmail("e2e-requests-filter-alice")
  const bobEmail = uniqueEmail("e2e-requests-filter-bob")
  const carolEmail = uniqueEmail("e2e-requests-filter-carol")
  const alphaProject = `Alpha Engagement (${tag})`
  const betaProject = `Beta Engagement (${tag})`

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()

  // Two clients each with exactly one named project (#129 mints one at
  // promotion time), and a third client with a plain /intake submission that
  // never carries a project at all — issue #323's "a row with no project
  // still shows under All projects" case.
  const alice = await seedNamedProject(
    browser,
    baseURL,
    operator,
    `A synthetic filter-check summary, alice (${tag}).`,
    aliceEmail,
    alphaProject,
  )
  const bob = await seedNamedProject(
    browser,
    baseURL,
    operator,
    `A synthetic filter-check summary, bob (${tag}).`,
    bobEmail,
    betaProject,
  )
  const carolContext = await contextFor(browser, baseURL, carolEmail)
  const carolPage = await carolContext.newPage()
  const carol = await seedSubmission(carolPage, carolEmail, `filter-carol-${tag}`)

  // Default load: every client and both projects are on offer, and every
  // row is visible — "All clients"/"All projects" is exactly today's
  // unfiltered behaviour. `/requests` is unscoped by construction (issue
  // #104) and `serve:test` does not wipe state between runs, so — unlike
  // the sealed acceptance suite's own single-worker, wiped-per-run
  // guarantee (CLAUDE.md's "Determinism") — this file's own other specs,
  // and this project's own `fullyParallel` siblings, can be seeding
  // unrelated rows into the very same list at the very same time. Every
  // check below asserts presence of what this test itself seeded, never an
  // exhaustive "and nothing else" — the same reason every other test in
  // this file scopes a locator with `.filter({ hasText: reference })`
  // rather than asserting on `requests-list`'s full contents.
  await operator.goto("/requests")
  await expect(operator.getByTestId("requests-filter-form")).toBeVisible()
  const clientSelect = operator.getByTestId("requests-filter-client")
  for (const email of [aliceEmail, bobEmail, carolEmail]) {
    await expect(clientSelect.getByRole("option", { name: email, exact: true })).toHaveCount(1)
  }
  const projectSelect = operator.getByTestId("requests-filter-project")
  await expect(projectSelect).toBeVisible()
  for (const label of [alphaProject, betaProject]) {
    await expect(projectSelect.getByRole("option", { name: label, exact: true })).toHaveCount(1)
  }
  const defaultRefs = await visibleReferences(operator)
  expect(defaultRefs).toEqual(expect.arrayContaining([alice.reference, bob.reference, carol.reference]))

  // Selecting alice narrows the list to her own row only, and — since she
  // now has exactly one project on offer — the project select disappears
  // entirely rather than rendering as a single, inert option.
  await clientSelect.selectOption(aliceEmail)
  await operator.getByTestId("requests-filter-submit").click()
  expect(new URL(operator.url()).searchParams.get("client")).toBe(aliceEmail)
  expect(await visibleReferences(operator)).toEqual([alice.reference])
  await expect(operator.getByTestId("requests-filter-project")).toHaveCount(0)
  await expect(operator.getByTestId("requests-filter-client")).toHaveValue(aliceEmail)

  // The selection survives a reload — the query string is the state.
  await operator.reload()
  expect(await visibleReferences(operator)).toEqual([alice.reference])
  await expect(operator.getByTestId("requests-filter-client")).toHaveValue(aliceEmail)

  // Carol has no project at all — her own scope also hides the project
  // select (zero options, not one).
  await operator.goto(`/requests?client=${encodeURIComponent(carolEmail)}`)
  expect(await visibleReferences(operator)).toEqual([carol.reference])
  await expect(operator.getByTestId("requests-filter-project")).toHaveCount(0)

  await Promise.all([operatorContext.close(), carolContext.close()])
})

test("the project filter narrows across every client, and picking a client resets a project selection that no longer belongs to it", async ({
  browser,
  baseURL,
}) => {
  const tag = Math.random().toString(36).slice(2, 10)
  const aliceEmail = uniqueEmail("e2e-requests-filter-reset-alice")
  const bobEmail = uniqueEmail("e2e-requests-filter-reset-bob")
  const alphaProject = `Alpha Reset Engagement (${tag})`
  const betaProject = `Beta Reset Engagement (${tag})`

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()

  const alice = await seedNamedProject(
    browser,
    baseURL,
    operator,
    `A synthetic reset-check summary, alice (${tag}).`,
    aliceEmail,
    alphaProject,
  )
  const bob = await seedNamedProject(
    browser,
    baseURL,
    operator,
    `A synthetic reset-check summary, bob (${tag}).`,
    bobEmail,
    betaProject,
  )

  // Picking Beta alone (client still "All clients") narrows to bob's row —
  // the project filter's own reach, independent of the client filter.
  await operator.goto("/requests")
  await operator.getByTestId("requests-filter-project").selectOption({ label: betaProject })
  await operator.getByTestId("requests-filter-submit").click()
  expect(await visibleReferences(operator)).toEqual([bob.reference])

  // Now, without reloading in between, also switch the client to alice and
  // submit once — the single <form> resubmits both selects together, so the
  // request this sends is exactly the "now-impossible pair" issue #323 calls
  // out: ?client=alice&project=<beta's id>, and Beta is not alice's project.
  await operator.getByTestId("requests-filter-client").selectOption(aliceEmail)
  await operator.getByTestId("requests-filter-submit").click()

  // The impossible pair does not survive: alice's own row renders (not an
  // empty result), and since her own scope now has exactly one project, the
  // project select is gone rather than stuck showing "Beta …".
  expect(await visibleReferences(operator)).toEqual([alice.reference])
  await expect(operator.getByTestId("requests-filter-project")).toHaveCount(0)
  await expect(operator.getByTestId("requests-filter-client")).toHaveValue(aliceEmail)

  await operatorContext.close()
})

test("an empty filtered result names the client filter that produced it, instead of a bare empty list", async ({
  browser,
  baseURL,
}) => {
  const email = uniqueEmail("e2e-requests-filter-empty")
  const strangerEmail = uniqueEmail("e2e-requests-filter-nomatch")

  const context = await contextFor(browser, baseURL, email)
  const page = await context.newPage()
  await seedSubmission(page, email, "filter-empty-anchor")

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()

  // strangerEmail has never submitted anything — there is at least one real
  // submission in the portal (the anchor above), so the filter bar renders,
  // but this particular client matches none of it.
  await operator.goto(`/requests?client=${encodeURIComponent(strangerEmail)}`)
  await expect(operator.getByTestId("requests-list")).toHaveCount(0)
  await expect(operator.getByTestId("requests-list-empty")).toHaveText(`No requests for ${strangerEmail}.`)

  await Promise.all([context.close(), operatorContext.close()])
})
