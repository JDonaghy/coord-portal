import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test"

/**
 * Black-box coverage for issue #149 ([portal] a project cannot be named — its
 * title is derived from the newest submission, so it silently renames
 * itself), driving the real Worker under `wrangler dev` — see
 * `playwright.config.ts`. This is the project's own `e2e/` tier, not the
 * sealed acceptance suite under `tests/acceptance/`; per CLAUDE.md this repo
 * still ships its own coverage for behaviour-changing work.
 *
 * SCOPE. `projects.name` (`migrations/0018_project_name.sql`) is nullable and
 * optional everywhere — this file covers naming a brand-new project inline
 * from the "start a new project instead" branch of `POST /leads/:id/reassign`
 * (`e2e/reassign.spec.ts` already covers that flow without a name; this file
 * is additive, not a duplicate), renaming an already-existing project from
 * `/leads/:id`'s own rename card, a blank name falling back to the pre-#149
 * derivation rather than failing, the name reading identically on the
 * operator's own screen and the customer's `/projects/:id` (issue #149's
 * explicit "not operator-only shorthand" decision), the field being withheld
 * on `/requests/:id`'s own reassign panel (`routes/requests.ts` never reads
 * it), and the usual access-control refusal.
 *
 * Also covers the two screens a first review round of this issue found still
 * reading the pre-#149 derived title instead of `project.name`: the
 * operator's own client detail screen (`/clients/:id`'s `client-project`
 * card, `routes/clients.ts`) — the primary motivating case #149 names by
 * issue number (#144) — and the customer's own `/submissions` grouped
 * project row (`routes/dashboard.ts`'s `projectRow`), whose `DashboardRow`
 * shape did not even carry a fetched `Project` to read a name from until
 * this fix. Both need a project with *two* submissions grouped under it —
 * one submission alone never renders as a `project-row` (see
 * `routes/dashboard.ts`'s own carve-out for issue #129) and a title that
 * happened to equal the derived one would not prove anything — so both tests
 * below promote two leads sharing one email and let #129's own client match
 * join the second to the first's project, the same shape
 * `e2e/clients.spec.ts` already uses for its own multi-submission project.
 *
 * ── ISSUE #156 ────────────────────────────────────────────────────────────
 * #149 only ever gave the rename form to `/leads/:id`, so a project with no
 * promoted lead behind it — the `/intake`-only case #145 already carved a
 * reassignment path for — had no reachable rename control anywhere. The
 * tests below cover the project-keyed entry point that closes that gap,
 * `POST /clients/:clientId/projects/:projectId/rename`
 * (`routes/clients.ts`'s `postClientProjectRename`): reachable for a project
 * that never had a lead, reading back identically to #149's own form
 * everywhere a name is shown, and refusing a `projectId`/`clientId` pairing
 * that does not actually belong together.
 *
 * Every string below is invented — see CLAUDE.md rule 1.
 */

const ACCESS_HEADER = "Cf-Access-Authenticated-User-Email"

/** See `DEV_OPERATOR_EMAIL` in `src/operators.ts` — honoured only off Cloudflare's edge. */
const DEV_OPERATOR = "ops@example.test"

const TURNSTILE_FIELD = "cf-turnstile-response"

const SERVICE_TOKEN = {
  "CF-Access-Client-Id": "b4e1a9d073cf4826bf05e3a91c68407d.access",
  "CF-Access-Client-Secret":
    "3f6d8b1ac97e42509fa1c6e0b8d2749fca6712dbe0f4589aa1c3e6d0f9b8c27",
}

function nonce(): string {
  return Math.random().toString(36).slice(2, 10)
}

async function contextFor(browser: Browser, baseURL: string | undefined, email: string | null) {
  return browser.newContext({
    baseURL,
    extraHTTPHeaders: email ? { [ACCESS_HEADER]: email } : {},
  })
}

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
 * Sends one lead through the public form, then promotes it as the operator —
 * same shape as `e2e/reassign.spec.ts`'s own helper, plus the promoted
 * submission's `SUB-XXXXXX` reference this file's naming assertions need.
 */
async function seedPromotedLead(
  browser: Browser,
  baseURL: string | undefined,
  operator: Page,
  summary: string,
  email: string,
): Promise<{ path: string; reference: string }> {
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
  const path = new URL(operator.url()).pathname
  await operator.getByTestId("promote-button").click()
  await expect(operator.getByTestId("lead-detail")).toHaveAttribute("data-status", "promoted")
  const reference = (await operator.getByTestId("promoted-submission-reference").innerText())
    .trim()
    .replace(/^Promoted to submission\s+/, "")
  return { path, reference }
}

/** Open the no-JS disclosure the way an operator does — shared by `/leads/:id` and `/requests/:id`. */
async function openReassign(page: Page) {
  await expect(page.getByTestId("reassign-open-button")).toBeVisible()
  await page.getByTestId("reassign-open-button").click()
  await expect(page.getByTestId("reassign-form")).toBeVisible()
}

/**
 * Files a standalone request through `POST /intake` — no `?from=`, so it gets
 * no lead, no project, no client link of any kind (`e2e/requests-
 * reassign.spec.ts`'s own helper, for issue #145's identical motivating
 * case). This is #156's own motivating case too: a project later minted for
 * this submission never has a `/leads/:id` behind it to rename it from.
 */
async function fileStandaloneRequest(page: Page, email: string, tag: string): Promise<{ id: string }> {
  await page.setExtraHTTPHeaders({ [ACCESS_HEADER]: email })
  await page.goto("/intake")
  await page.getByTestId("field-outcome").fill(`A synthetic intake-only outcome (${tag}).`)
  await page.getByTestId("field-audience").fill("synthetic e2e readers")
  await page.getByTestId("field-done-definition").fill("The #156 e2e suite goes green.")
  await page.getByTestId("submit-intake").click()
  await expect(page.getByTestId("intake-receipt")).toBeVisible()
  const id = new URL(page.url()).pathname.replace(/^\/submissions\//, "")
  return { id }
}

/** Every bridge event for `reference` — the only black-box way to learn a project's id without a dedicated screen for it. */
async function bridgeEventsFor(
  request: APIRequestContext,
  reference: string,
): Promise<Array<{ type: string; payload: Record<string, unknown> }>> {
  const matches: Array<{ type: string; payload: Record<string, unknown> }> = []
  let cursor: string | undefined
  for (let page = 0; page < 50; page++) {
    const res = await request.get("/api/bridge/pull", {
      params: { limit: "200", ...(cursor ? { cursor } : {}) },
      headers: SERVICE_TOKEN,
    })
    expect(res.status()).toBe(200)
    const body = (await res.json()) as {
      events: Array<{ type: string; submission_id: string; payload: Record<string, unknown> }>
      cursor: string
      has_more: boolean
    }
    matches.push(
      ...body.events
        .filter((event) => event.submission_id === reference)
        .map((event) => ({ type: event.type, payload: event.payload })),
    )
    cursor = body.cursor
    if (!body.has_more) return matches
  }
  throw new Error("the stream never drained — the cursor is not advancing")
}

test("renaming an existing project updates the title everywhere, including the customer's own /projects/:id, and a blank name falls back to the derived title", async ({
  browser,
  baseURL,
  request,
}) => {
  const tag = nonce()
  const summary = `A synthetic rename-existing-project check (${tag}).`
  const email = `naming-rename-${tag}@example.test`

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()
  const { reference } = await seedPromotedLead(browser, baseURL, operator, summary, email)

  // #129 already gave this client its first project the moment it promoted —
  // the rename card is present from that instant, no reassignment needed
  // first, and it starts blank (`project.name IS NULL`).
  await expect(operator.getByTestId("rename-project-card")).toBeVisible()
  await expect(operator.getByTestId("rename-project-input")).toHaveValue("")

  const chosenName = `Kitchen remodel, phase two (${tag})`
  await operator.getByTestId("rename-project-input").fill(chosenName)
  await operator.getByTestId("rename-project-submit").click()

  await expect(operator.getByTestId("rename-project-input")).toHaveValue(chosenName)
  await openReassign(operator)
  await expect(operator.getByTestId("reassign-current-project")).toContainText(chosenName)

  // The project this promotion minted — `submission.created`'s own event
  // payload already knows its id synchronously (#129/#146, same reasoning
  // `e2e/reassign.spec.ts` documents), so there is no need to reassign
  // anything just to learn it.
  const created = (await bridgeEventsFor(request, reference)).find(
    (event) => event.type === "submission.created",
  )
  const projectId = created?.payload["project_id"]
  expect(typeof projectId).toBe("string")

  // Issue #149's explicit customer-visibility decision: the name is not
  // operator-only shorthand, it reads back verbatim on the customer's own
  // combined project view.
  const customerContext = await contextFor(browser, baseURL, email)
  const customer = await customerContext.newPage()
  await customer.goto(`/projects/${projectId}`)
  await expect(customer.getByTestId("project-detail")).toBeVisible()
  await expect(customer.getByRole("heading", { level: 1 })).toHaveText(chosenName)
  await customerContext.close()

  // Clearing the name is not an error — it falls back to the pre-#149
  // derivation from the newest (only) submission's own outcome, which for a
  // promoted lead is exactly what they originally sent in.
  await operator.getByTestId("rename-project-input").fill("")
  await operator.getByTestId("rename-project-submit").click()
  await expect(operator.getByTestId("rename-project-input")).toHaveValue("")
  await openReassign(operator)
  await expect(operator.getByTestId("reassign-current-project")).toContainText(summary)
  await expect(operator.getByTestId("reassign-current-project")).not.toContainText(chosenName)

  await operatorContext.close()
})

test("naming a new project inline while reassigning names it everywhere, but the field is withheld on /requests' own reassign panel", async ({
  browser,
  baseURL,
}) => {
  const tag = nonce()
  const summary = `A synthetic inline-name reassignment check (${tag}).`
  const email = `naming-inline-${tag}@example.test`

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()
  const { path, reference } = await seedPromotedLead(browser, baseURL, operator, summary, email)

  await openReassign(operator)
  await expect(operator.getByTestId("reassign-new-project-name")).toBeVisible()
  const chosenName = `A fresh engagement, named up front (${tag})`
  await operator.getByTestId("reassign-project-option-new").click()
  await operator.getByTestId("reassign-new-project-name").fill(chosenName)
  await operator.getByTestId("reassign-submit").click()
  await expect(operator.getByTestId("reassign-form")).toBeHidden()
  expect(new URL(operator.url()).pathname, "reassignment stays on the same screen").toBe(path)

  // The freshly created (and named) project now reads back both as "the
  // project this submission currently sits in" and pre-fills the rename
  // card with the exact name just given it — one name, learned two ways.
  await openReassign(operator)
  await expect(operator.getByTestId("reassign-current-project")).toContainText(chosenName)
  await expect(operator.getByTestId("rename-project-input")).toHaveValue(chosenName)

  // `routes/requests.ts`'s own second entry point onto the identical
  // reassignment mechanic (#145) never reads a `newProjectName` field, so
  // `reassignPanel` withholds it there by default (`opts.allowNaming`) rather
  // than rendering a field that would silently swallow whatever an operator
  // typed into it.
  await operator.goto("/requests")
  const requestRow = operator.getByTestId("request-row").filter({ hasText: reference })
  await requestRow.getByTestId("request-reassign-link").click()
  await expect(operator.getByTestId("request-detail")).toBeVisible()
  await openReassign(operator)
  await expect(operator.getByTestId("reassign-new-project-name")).toHaveCount(0)

  await operatorContext.close()
})

test("a stranger and a non-operator cannot rename a project", async ({ browser, baseURL, request }) => {
  const tag = nonce()
  const summary = `A synthetic rename access-control check (${tag}).`
  const email = `naming-guard-${tag}@example.test`

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()
  const { path } = await seedPromotedLead(browser, baseURL, operator, summary, email)
  await operatorContext.close()

  const anonymous = await request.post(`${path}/project/rename`, {
    form: { name: "should never land" },
    maxRedirects: 0,
    failOnStatusCode: false,
  })
  expect(anonymous.status()).toBe(404)

  const nonOperator = await request.post(`${path}/project/rename`, {
    headers: { [ACCESS_HEADER]: `curious-${tag}@example.test` },
    form: { name: "should never land" },
    maxRedirects: 0,
    failOnStatusCode: false,
  })
  expect(nonOperator.status()).toBe(404)

  const unknownLead = await request.post("/leads/lead_does_not_exist_e2e/project/rename", {
    headers: { [ACCESS_HEADER]: DEV_OPERATOR },
    form: { name: "should never land" },
    maxRedirects: 0,
    failOnStatusCode: false,
  })
  expect(unknownLead.status()).toBe(404)
})

test("a renamed project's chosen name appears on the operator's own /clients/:id, not the derived title", async ({
  browser,
  baseURL,
}) => {
  const tag = nonce()
  const email = `naming-clients-${tag}@example.test`
  const firstSummary = `A synthetic first booking for the client-detail naming check (${tag}).`
  const secondSummary = `A synthetic follow-up for the client-detail naming check (${tag}).`

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()

  // Two leads, same email — #129's own client match joins the second to the
  // first lead's project (`e2e/clients.spec.ts` exercises this identical
  // shape), so this project's derived title (had it stayed derived) would
  // read as the *second* lead's own summary, not the first's — proof this
  // assertion is actually reading `project.name`, not coincidentally
  // agreeing with the derivation.
  await seedPromotedLead(browser, baseURL, operator, firstSummary, email)
  const { path: secondPath } = await seedPromotedLead(browser, baseURL, operator, secondSummary, email)

  await operator.goto(secondPath)
  await expect(operator.getByTestId("rename-project-card")).toBeVisible()
  const chosenName = `Client detail naming check (${tag})`
  await operator.getByTestId("rename-project-input").fill(chosenName)
  await operator.getByTestId("rename-project-submit").click()
  await expect(operator.getByTestId("rename-project-input")).toHaveValue(chosenName)

  await operator.goto("/clients")
  const clientRow = operator.getByTestId("client-row").filter({ hasText: email })
  await clientRow.getByTestId("view-client").click()

  // One shared project (the two leads joined the same one), one
  // `client-project` card, and its title reads the operator-chosen name
  // outright rather than deriving from either submission's own outcome —
  // the primary motivating screen #149 names by issue number (#144).
  const projectTitleEl = operator.getByTestId("client-project-title")
  await expect(projectTitleEl).toHaveCount(1)
  await expect(projectTitleEl).toHaveText(chosenName)

  await operatorContext.close()
})

test("a renamed project's chosen name appears on the customer's own /submissions project row, not just /projects/:id", async ({
  browser,
  baseURL,
}) => {
  const tag = nonce()
  const email = `naming-dashboard-${tag}@example.test`
  const firstSummary = `A synthetic first booking for the dashboard naming check (${tag}).`
  const secondSummary = `A synthetic follow-up for the dashboard naming check (${tag}).`

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()

  await seedPromotedLead(browser, baseURL, operator, firstSummary, email)
  const { path: secondPath } = await seedPromotedLead(browser, baseURL, operator, secondSummary, email)

  await operator.goto(secondPath)
  await expect(operator.getByTestId("rename-project-card")).toBeVisible()
  const chosenName = `Dashboard naming check (${tag})`
  await operator.getByTestId("rename-project-input").fill(chosenName)
  await operator.getByTestId("rename-project-submit").click()
  await expect(operator.getByTestId("rename-project-input")).toHaveValue(chosenName)
  await operatorContext.close()

  const customerContext = await contextFor(browser, baseURL, email)
  const customer = await customerContext.newPage()
  await customer.goto("/submissions")

  // Two submissions sharing one project collapse into a single `project-row`
  // (`groupByProject`, `routes/dashboard.ts`) — before this fix that row's
  // title came straight from `titleOf(newest)`, ignoring `project.name`
  // entirely, so the customer's own request list still showed the old
  // unstable, derived title for a project the operator had just named.
  const projectRow = customer.getByTestId("project-row")
  await expect(projectRow).toHaveCount(1)
  await expect(projectRow).toContainText(chosenName)
  await expect(projectRow).not.toContainText(secondSummary)

  await customerContext.close()
})

test("an /intake-only project with no promoted lead has no rename control on /leads, but can be named from /clients/:id, and the name reads back on /projects/:id", async ({
  browser,
  baseURL,
}) => {
  const tag = nonce()
  const email = `naming-intake-only-${tag}@example.test`

  const customerContext = await contextFor(browser, baseURL, email)
  const customer = await customerContext.newPage()
  const { id: submissionId } = await fileStandaloneRequest(customer, email, tag)
  await customerContext.close()

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()

  // `/intake` never mints a lead (only `/start` does — #145's own framing),
  // so there is no `/leads/:id` for this address anywhere, and therefore no
  // way to reach #149's own rename form for whatever project this
  // submission ends up in.
  await operator.goto("/leads")
  await expect(operator.getByTestId("lead-row").filter({ hasText: email })).toHaveCount(0)

  // Give it a client-linked project the only way a lead-less submission can
  // get one: `/requests`' own second reassignment entry point (#145).
  await operator.goto(`/requests/${submissionId}`)
  await openReassign(operator)
  await operator.getByTestId("reassign-project-option-new").click()
  await operator.getByTestId("reassign-submit").click()
  await expect(new URL(operator.url()).pathname).toBe(`/requests/${submissionId}`)

  await operator.goto("/clients")
  const clientRow = operator.getByTestId("client-row").filter({ hasText: email })
  await expect(clientRow).toHaveCount(1)
  await clientRow.getByTestId("view-client").click()
  await expect(operator.getByTestId("client-detail")).toBeVisible()

  // The rename form is right here, keyed by the project's own id — issue
  // #156's whole point: no lead needed anywhere in this flow.
  const projectCard = operator.getByTestId("client-project")
  await expect(projectCard).toHaveCount(1)
  await expect(projectCard.getByTestId("rename-project-card")).toBeVisible()
  await expect(projectCard.getByTestId("rename-project-input")).toHaveValue("")

  const renameAction = await projectCard.getByTestId("rename-project-form").getAttribute("action")
  const match = renameAction?.match(/^\/clients\/([^/]+)\/projects\/([^/]+)\/rename$/)
  expect(match, `rename form posts to the project-keyed route, got ${renameAction}`).toBeTruthy()
  const [, clientId, projectId] = match as RegExpMatchArray

  const chosenName = `Intake-only project, named at last (${tag})`
  await projectCard.getByTestId("rename-project-input").fill(chosenName)
  await projectCard.getByTestId("rename-project-submit").click()

  await expect(operator.getByTestId("client-project-title")).toHaveText(chosenName)
  await expect(operator.getByTestId("client-project").getByTestId("rename-project-input")).toHaveValue(
    chosenName,
  )

  // Not operator-only shorthand here either — reads back verbatim on the
  // customer's own combined project view, same #149 guarantee this route
  // reuses `renameProject` to keep.
  const customerReadBackContext = await contextFor(browser, baseURL, email)
  const customerReadBack = await customerReadBackContext.newPage()
  await customerReadBack.goto(`/projects/${projectId}`)
  await expect(customerReadBack.getByTestId("project-detail")).toBeVisible()
  await expect(customerReadBack.getByRole("heading", { level: 1 })).toHaveText(chosenName)
  await customerReadBackContext.close()

  // Clearing it is not an error — falls back to the derived title, exactly
  // like `POST /leads/:id/project/rename` already does.
  await operator.goto(`/clients/${clientId}`)
  await operator.getByTestId("rename-project-input").fill("")
  await operator.getByTestId("rename-project-submit").click()
  await expect(operator.getByTestId("rename-project-input")).toHaveValue("")
  await expect(operator.getByTestId("client-project-title")).not.toHaveText(chosenName)

  await operatorContext.close()
})

test("the project-keyed rename route refuses a stranger, a non-operator, an unknown project, and a projectId that does not belong to the clientId in its own URL", async ({
  browser,
  baseURL,
  request,
}) => {
  const tag = nonce()
  const firstEmail = `naming-ownership-a-${tag}@example.test`
  const secondEmail = `naming-ownership-b-${tag}@example.test`

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()

  // Two independent, already-named projects belonging to two different
  // clients — the second is what the mismatched-ownership case below tries
  // (and must fail) to rename through the first client's URL.
  const first = await seedPromotedLead(
    browser,
    baseURL,
    operator,
    `A synthetic first ownership check (${tag}).`,
    firstEmail,
  )
  const second = await seedPromotedLead(
    browser,
    baseURL,
    operator,
    `A synthetic second ownership check (${tag}).`,
    secondEmail,
  )

  const bridgeEventsForBoth = await Promise.all(
    [first, second].map(async ({ reference }) =>
      (await bridgeEventsFor(request, reference)).find(
        (event) => event.type === "submission.created",
      ),
    ),
  )
  const [firstProjectId, secondProjectId] = bridgeEventsForBoth.map((event) => event?.payload["project_id"])
  expect(typeof firstProjectId).toBe("string")
  expect(typeof secondProjectId).toBe("string")

  await operator.goto("/clients")
  const firstClientId = new URL(
    (await operator
      .getByTestId("client-row")
      .filter({ hasText: firstEmail })
      .getByTestId("view-client")
      .getAttribute("href")) ?? "",
    baseURL,
  ).pathname.replace(/^\/clients\//, "")
  await operatorContext.close()

  // A `projectId` that is real, but belongs to a *different* client than the
  // one named in the URL — the ownership check `postClientProjectRename`
  // exists for.
  const mismatchedContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const mismatched = await mismatchedContext.request.post(
    `/clients/${firstClientId}/projects/${secondProjectId}/rename`,
    { form: { name: "should never land" }, maxRedirects: 0, failOnStatusCode: false },
  )
  expect(mismatched.status()).toBe(404)
  await mismatchedContext.close()

  for (const identity of [firstEmail, null]) {
    const context = await contextFor(browser, baseURL, identity)
    const response = await context.request.post(
      `/clients/${firstClientId}/projects/${firstProjectId}/rename`,
      { form: { name: "should never land" }, maxRedirects: 0, failOnStatusCode: false },
    )
    expect(response.status(), `POST as ${identity ?? "nobody"}`).toBe(404)
    await context.close()
  }

  const unknownProjectContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const unknownProject = await unknownProjectContext.request.post(
    `/clients/${firstClientId}/projects/proj_does_not_exist_e2e/rename`,
    { form: { name: "should never land" }, maxRedirects: 0, failOnStatusCode: false },
  )
  expect(unknownProject.status()).toBe(404)
  await unknownProjectContext.close()
})
