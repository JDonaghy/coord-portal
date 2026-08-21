import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type Locator,
  type Page,
} from "@playwright/test"

/**
 * ms-4 sealed acceptance slice — issue #130
 * "Operator: reassign a submission to a different (or new) project"
 *
 * Written from `tests/acceptance/ms-4/contract.md` and the three mocks it names
 * for this issue (`mocks/02-lead-promoted-existing-client.html`,
 * `mocks/04-lead-promoted-work-started.html`,
 * `mocks/05-lead-reassign-open.html`), without sight of any implementation.
 *
 * ── WHAT #130 ACTUALLY BUYS ─────────────────────────────────────────────────
 *
 * The issue's own words: an operator action on an already-promoted submission
 * that "moves it to a different project belonging to the same client —
 * including 'create a new project' inline, without leaving the screen", and
 * that "applies to any already-promoted submission, not just at promotion
 * time". Scope is explicitly *within one client's own projects*.
 *
 * The contract turns that into a concrete surface (§ "Reassignment (#130)"):
 * a visually-hidden-but-focusable `reassign-toggle` checkbox, a
 * `reassign-open-button` label, and a `reassign-form` posting to
 * `POST /leads/:id/reassign` with a radio list of *every other* project
 * carrying the same `client_id`, plus "start a new project instead".
 *
 * So this slice asserts four things, and they are the four the issue names:
 *
 *  1. **The control exists, on every promoted lead, closed by default** — and
 *     opens and closes with no JavaScript, the way the mocks render it.
 *  2. **Which projects are offered** — the client's own `client_id`-linked
 *     projects, minus the one the submission is already in, never another
 *     client's, never a `client_id IS NULL` project (contract § "Which
 *     projects are even offered").
 *  3. **Submitting actually moves the submission** — observable through the
 *     panel's own offer list, which is *derived from where the submission now
 *     is*: the project just moved to disappears from "move to", and the one it
 *     came from appears.
 *  4. **"Create a new project" inline works, and reassignment is not consumed
 *     by use** — after moving into a freshly created project, both older
 *     projects are on offer, and the control is still there.
 *
 * ── WHAT THIS SLICE DELIBERATELY DOES NOT ASSERT ────────────────────────────
 *
 *  - **#129's promotion-time client match** (`client-match-card`,
 *    `client-attachment`, `client-project-list`, `data-match`). #129's slice
 *    owns those. This slice *drives* the promotion form — it is the only way a
 *    client with two projects can be brought into existence black-box, the same
 *    way `128-clients-schema.spec.ts` drives `/intake` purely as an instrument
 *    — but asserts nothing about that screen beyond what it must click.
 *  - **#132's "Start work"**. Mock 04 shows `reassign-open-button` surviving
 *    the start-work override, and the contract calls that out under #130
 *    ("reassignment does not depend on, or get consumed by, the start-work
 *    action"). Asserting it here would make this slice red for a *different*
 *    issue's missing button. The #130-only half of that claim — reassignment
 *    survives its own use, days after promotion — is asserted instead, in
 *    "reassignment stays available after it has been used". See the TODO there.
 *  - **`GET /api/bridge/pull`**. Neither #130 nor the contract pins any bridge
 *    event for a reassignment, and contract note 1 is emphatic that this
 *    milestone's event-kind question was unreadable at Gate-A time. Guessing
 *    one here would invent a contract.
 *  - **Idempotency of a double-submitted reassignment** — contract note 6 says
 *    in terms that it is not pinned either way.
 *  - **Moving a submission to a different client.** Out of scope per the issue
 *    itself; asserted only *negatively*, as the absence of any such control.
 *
 * SYNTHETIC DATA. Per CLAUDE.md rule 1 and the contract's "Synthetic data"
 * section, every email, name and phrase below is invented and sits on RFC
 * 6761's reserved `.test` TLD.
 */

const ACCESS_HEADER = "Cf-Access-Authenticated-User-Email"

/**
 * The operator identity.
 *
 * Same value, same escape hatch and same caveat as
 * `tests/acceptance/ms-2/33-lead-triage-promotion.spec.ts`: the contract pins
 * only that `/leads*` is gated on an allowlist of Access identities, and
 * `ops@example.test` is the address every operator mock in this repo renders in
 * `identity-email`. A sealed slice cannot read the implementation's env var
 * name, so it takes the contract's own address and offers the same override.
 */
const OPERATOR_EMAIL = process.env.COORD_PORTAL_OPERATOR_EMAIL ?? "ops@example.test"

/** Contract (ms-2): `lead-reference` text pattern `LEAD-XXXXXX`. */
const LEAD_REFERENCE = /LEAD-[A-Z0-9]{6}/
/** #32's bot gate mints this literal token against a test sitekey. */
const TURNSTILE_FIELD = "cf-turnstile-response"

/**
 * Seeding is expensive here: a client with two projects needs two promoted
 * leads, and every lead has to come in through the public `POST /start`.
 * Between that, the promotion round-trips and the reassignment POSTs, the
 * default 30s per test is not enough headroom on a cold worker.
 */
test.describe.configure({ timeout: 120_000 })

/**
 * …but individual ACTIONS get a short leash, which is the opposite trade and
 * deliberate.
 *
 * Playwright's `click()`, `check()`, `fill()` and `evaluate()` have no default
 * timeout: they wait indefinitely, bounded only by the test timeout above. In a
 * suite written before the implementation exists — where every hook this file
 * touches is *expected* to be missing — that turns each red test into a silent
 * two-minute hang ending in "Test timeout exceeded", which says nothing about
 * which hook was absent. Capped, an action against a hook that is not there
 * fails in seconds and names it. Every action below is additionally preceded by
 * an explicit `expect(...).toBeVisible()`; this is the backstop for the ones a
 * future edit forgets.
 */
test.use({ actionTimeout: 15_000 })

/**
 * TODO(test-author): every lead below is created through `POST /start`, which
 * #32 puts a per-IP rate limit in front of, and neither ms-2's contract nor
 * ms-4's pins the threshold or the window. This file seeds eight leads across a
 * full run, on top of whatever ms-2's own slice already spent from 127.0.0.1.
 * If `seedLead` starts failing with "no receipt", the rate limit is the first
 * thing to look at, not #130. It is kept as low as correctness allows — each
 * *mutating* test gets its own client precisely so that no test depends on
 * another having run first, which is worth more than the saved seeds.
 */

// ── identities ──────────────────────────────────────────────────────────────

/** Local `wrangler dev` has no Access in front of it, so identity is a header. */
function asOperator(browser: Browser, baseURL: string | undefined) {
  return browser.newContext({ baseURL, extraHTTPHeaders: { [ACCESS_HEADER]: OPERATOR_EMAIL } })
}

/** A caller with no Access identity at all. */
function asStranger(browser: Browser, baseURL: string | undefined) {
  return browser.newContext({ baseURL })
}

// ── seeding, through the pinned public surfaces ─────────────────────────────

/**
 * Let #32's widget mint its token before submitting, if it is on the page at
 * all. Failures are swallowed: this removes a race, it asserts nothing.
 * (Lifted from ms-2's slice, which owns the bot gate's behaviour.)
 */
async function settleBotGate(page: Page) {
  if ((await page.getByTestId("turnstile-widget").count()) === 0) return
  await page
    .waitForFunction(
      (field) => {
        const input = document.querySelector(`input[name="${field}"]`) as HTMLInputElement | null
        return !!input && input.value.length > 0
      },
      TURNSTILE_FIELD,
      { timeout: 15_000 },
    )
    .catch(() => {})
}

/**
 * One lead this slice needs to exist.
 *
 * `tag` is a short token front-loaded into the summary, and it — not the email —
 * is how a lead is found again in the inbox. That matters here in a way it did
 * not for ms-2's slice: reassignment is only meaningful for a client with more
 * than one project, which takes **two leads sharing one email address**, so an
 * email no longer identifies a row. `lead-summary` (ms-2's pinned inbox hook)
 * may be rendered as an excerpt, hence "front-loaded".
 */
interface LeadSeed {
  tag: string
  email: string
  summary: string
}

function seedFor(tag: string, email: string, rest: string): LeadSeed {
  return { tag, email, summary: `${tag} — ${rest}` }
}

/** File one lead the way a stranger does. Instrument only — ms-2's slice owns `/start`. */
async function seedLead(browser: Browser, baseURL: string | undefined, seed: LeadSeed) {
  const context = await asStranger(browser, baseURL)
  const page = await context.newPage()
  await page.goto("/start")
  await page.getByTestId("field-lead-summary").fill(seed.summary)
  await page.getByTestId("field-lead-email").fill(seed.email)
  await settleBotGate(page)
  await page.getByTestId("submit-lead").click()
  await expect(
    page.getByTestId("lead-receipt"),
    `seeding lead ${seed.tag} needs POST /start to render its receipt (ms-2, #31) — ` +
      "if this fails, check #32's rate limit before suspecting #130",
  ).toBeVisible()
  const receipt = (await page.getByTestId("lead-reference").innerText()).trim()
  expect(receipt, `POST /start should mint a LEAD-XXXXXX reference, got: ${receipt}`).toMatch(
    LEAD_REFERENCE,
  )
  await context.close()
}

/**
 * The `/leads/:id` path for a seeded lead, seeding it first if this run has not
 * already — found by its `tag` in the inbox row (ms-2's pinned `lead-row` /
 * `lead-summary` / `review-lead` hooks).
 *
 * Find-or-create rather than always-create, deliberately. Several tests below
 * want the *same* single-project client, and the acceptance database is wiped
 * per run rather than per test, so "already there" is a legitimate state. It
 * also keeps this file's total spend on `POST /start` down, which matters while
 * #32's rate limit is unpinned (see the TODO above). No test depends on another
 * having run first: whoever gets there first pays for the seed.
 */
async function leadPath(
  operator: Page,
  browser: Browser,
  baseURL: string | undefined,
  seed: LeadSeed,
): Promise<string> {
  const rows = () => operator.getByTestId("lead-row").filter({ hasText: seed.tag })

  await operator.goto("/leads")
  if ((await rows().count()) === 0) {
    await seedLead(browser, baseURL, seed)
    await operator.goto("/leads")
  }

  await expect(
    rows(),
    `exactly one inbox row tagged ${seed.tag} — the tag is this slice's only way to tell two ` +
      `leads sharing ${seed.email} apart`,
  ).toHaveCount(1)
  const href = await rows().getByTestId("review-lead").getAttribute("href")
  expect(href, "`review-lead` links to the lead's own detail screen").toMatch(/^\/leads\/[^/]+$/)
  return href as string
}

/**
 * Check a radio option regardless of whether the `data-testid` sits on the
 * `<input>` itself or on a `<label>` wrapping it. Mock 05 renders the label
 * form; the contract's prose ("a `<fieldset>` of radio inputs ... one
 * `<hook>` per project") permits either, and this slice has no business
 * failing a worker over which of the two they picked.
 */
async function chooseOption(option: Locator, what: string) {
  await expect(option, `${what} has to be on the screen before it can be picked`).toHaveCount(1)
  const radio = option.locator('input[type="radio"]')
  if ((await radio.count()) > 0) await radio.first().check()
  else await option.click()
}

/**
 * Promote a lead through the pinned `promote-lead-form`.
 *
 * `projectChoice: "new"` picks #129's `client-project-option-new` — the only
 * black-box way to give one client a *second* project, which is the precondition
 * for reassignment having anywhere to go. Instrument, not assertion: the only
 * thing checked about that radio is that it is there to click, with a message
 * saying why this slice needed it.
 */
async function promote(operator: Page, path: string, projectChoice?: "new") {
  await operator.goto(path)
  const detail = operator.getByTestId("lead-detail")
  await expect(detail, "the lead's detail screen should render for an operator").toBeVisible()
  // Already promoted earlier in this run — promotion is one-way and idempotent
  // (ms-2's contract), so this is the state the caller asked for.
  if ((await detail.getAttribute("data-status")) === "promoted") return

  await expect(
    detail,
    "a lead has to be un-promoted before it can be promoted",
  ).toHaveAttribute("data-status", "new")

  if (projectChoice === "new") {
    const newOption = operator.getByTestId("client-project-option-new")
    await expect(
      newOption,
      "this slice needs a client with two projects, and the only way to make one black-box is " +
        "#129's 'create a new project' radio on the promotion form (contract § 'Before " +
        "promotion — client match'). Its absence is a #129 gap, not a #130 failure — but #130 " +
        "has nothing to reassign *between* without it",
    ).toHaveCount(1)
    await chooseOption(newOption, "#129's 'start a new project' radio")
  }

  await operator.getByTestId("promote-button").click()
  await expect(
    operator.getByTestId("lead-detail"),
    "promotion redirects back to GET /leads/:id, now promoted (ms-2's contract)",
  ).toHaveAttribute("data-status", "promoted")
}

/**
 * File a request through `POST /intake`, returning the new submission's id.
 * Used only to manufacture a project the customer's own way (#109), which is
 * the population the contract says must NOT show up in the offer list.
 */
async function fileRequest(
  request: APIRequestContext,
  email: string,
  outcome: string,
  followUpFrom?: string,
): Promise<string> {
  const path = followUpFrom ? `/intake?from=${encodeURIComponent(followUpFrom)}` : "/intake"
  const res = await request.post(path, {
    headers: { [ACCESS_HEADER]: email },
    form: {
      outcome,
      audience: "The team that owns this surface",
      doneDefinition: "It is live and nobody has to explain it twice",
    },
    maxRedirects: 0,
  })
  const status = res.status()
  expect(status, `POST ${path} should redirect to the new submission, got ${status}`).toBeGreaterThanOrEqual(300)
  expect(status, `POST ${path} should redirect to the new submission, got ${status}`).toBeLessThan(400)
  const location = res.headers()["location"] ?? ""
  const id = /\/submissions\/([A-Za-z0-9_-]+)/.exec(location)?.[1]
  expect(id, `POST ${path} should redirect to /submissions/:id, got ${location || "(no Location)"}`).toBeTruthy()
  return id as string
}

/** Every `/projects/:id` the caller's own dashboard links to. */
async function dashboardProjectIds(request: APIRequestContext, email: string): Promise<string[]> {
  const res = await request.get("/submissions", { headers: { [ACCESS_HEADER]: email } })
  expect(res.status(), `the dashboard should render for ${email}`).toBe(200)
  const body = await res.text()
  return [...new Set([...body.matchAll(/href="\/projects\/([A-Za-z0-9_-]+)"/g)].map((m) => m[1]))]
}

// ── the reassignment panel itself ───────────────────────────────────────────

/** Open the disclosure by clicking its label, the way an operator does. No JS. */
async function openReassign(page: Page) {
  // Assert the label is there BEFORE clicking it. Playwright's `click()` has no
  // default timeout, so clicking a hook that does not exist yet hangs until the
  // whole test times out — a 120s wait and an unreadable "test timeout" instead
  // of a 5s "this hook is missing". Every action in this file is guarded the
  // same way, because at authoring time NONE of these hooks exist.
  await expect(
    page.getByTestId("reassign-open-button"),
    "#130's reassignment panel is opened by `reassign-open-button` — it must be on the screen",
  ).toBeVisible()
  await page.getByTestId("reassign-open-button").click()
  await expect(
    page.getByTestId("reassign-form"),
    "clicking `reassign-open-button` reveals `reassign-form` — the checkbox-and-label " +
      "disclosure the contract pins, which needs no JavaScript",
  ).toBeVisible()
}

/** The `data-project-id` of every project currently on offer, sorted. */
async function offeredProjectIds(page: Page): Promise<string[]> {
  const options = page.getByTestId("reassign-project-option")
  const count = await options.count()
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const id = await options.nth(i).getAttribute("data-project-id")
    expect(
      id,
      "every `reassign-project-option` carries `data-project-id` (contract § 'data-testid hooks')",
    ).toBeTruthy()
    ids.push(id as string)
  }
  return ids.sort()
}

/**
 * Submit the panel and wait for the screen to come back.
 *
 * The redirect target is the pinned part ("without leaving the screen", #130;
 * every other form in this portal 303s back to a GET of itself). The panel
 * being closed again afterwards is the sync point: it can only be true once the
 * fresh `GET /leads/:id` has replaced the page, because the toggle is a
 * checkbox whose checked state does not survive a navigation.
 *
 * TODO(test-author): the contract does not pin the redirect's *status code*
 * for `POST /leads/:id/reassign` (it pins the route and the repo's PRG
 * convention, not a number), so this asserts where the operator lands, not
 * which 3xx took them there.
 */
async function submitReassign(page: Page, path: string) {
  await expect(
    page.getByTestId("reassign-submit"),
    "the panel's submit must be on the screen before it can be pressed",
  ).toBeVisible()
  await page.getByTestId("reassign-submit").click()
  await expect(
    page.getByTestId("reassign-form"),
    "submitting reassignment lands back on a fresh GET /leads/:id with the panel closed again",
  ).toBeHidden()
  expect(
    new URL(page.url()).pathname,
    "#130: the operator reassigns 'without leaving the screen'",
  ).toBe(path)
}

test.describe("ms-4 issue 130 reassign a submission to a different project", () => {
  // ── the clients this slice needs ──────────────────────────────────────────

  /**
   * A client whose only project is the one its promotion created — the state
   * mock 03 renders, and the one most of the read-only tests below want.
   *
   * Shared by tag, not by a cached value: `leadPath` finds it if an earlier test
   * in this run already seeded it and creates it otherwise, and `promote` is a
   * no-op on an already-promoted lead. Every test that wants this client can
   * therefore ask for it independently, in any order, running alone or with the
   * whole file — which a module-level cache does not actually guarantee.
   */
  const SOLO = seedFor(
    "SOLO130",
    "rowan.solo.130@example.test",
    "a one-page menu for a market stall, currently a photo of a chalkboard.",
  )

  /** The single-project client's promoted lead, ready to look at. */
  async function soloLead(browser: Browser, baseURL: string | undefined, operator: Page) {
    const path = await leadPath(operator, browser, baseURL, SOLO)
    await promote(operator, path)
    return path
  }

  /**
   * A client with TWO projects, which is the only state in which reassignment
   * has anywhere to go. Both leads share one email — that is what makes them one
   * client (#129) — and are told apart by their tags.
   *
   * The mutating tests each get their own pair, so that neither depends on the
   * other having run, or not having run, first.
   */
  function twoProjectClient(tag: string, email: string, first: string, second: string) {
    return {
      first: seedFor(`${tag}A`, email, first),
      second: seedFor(`${tag}B`, email, second),
    }
  }

  /**
   * Promote both of a pair's leads, the second into a project of its own, and
   * return the second lead's path — the submission this slice then moves around.
   */
  async function twoProjectLead(
    browser: Browser,
    baseURL: string | undefined,
    operator: Page,
    pair: { first: LeadSeed; second: LeadSeed },
  ): Promise<string> {
    const firstPath = await leadPath(operator, browser, baseURL, pair.first)
    await promote(operator, firstPath)
    const secondPath = await leadPath(operator, browser, baseURL, pair.second)
    expect(
      secondPath,
      "the two leads of one client are two different leads",
    ).not.toBe(firstPath)
    await promote(operator, secondPath, "new")
    return secondPath
  }

  /**
   * Mocks 02, 03 and 04 all render exactly this pair on a promoted lead, closed:
   * the checkbox and its label, with the form itself not showing. Mock 05 is the
   * same screen with the toggle checked.
   *
   * `toBeHidden()` rather than `toHaveCount(0)` for the form on purpose: mock 02
   * keeps a collapsed `reassign-form` in the DOM while mocks 03 and 04 omit it
   * entirely. Both are "closed", and #130 cares about neither.
   */
  test("a promoted lead offers reassignment, closed by default", async ({ browser, baseURL }) => {
    const context = await asOperator(browser, baseURL)
    const page = await context.newPage()
    const path = await soloLead(browser, baseURL, page)
    await page.goto(path)

    await expect(page.getByTestId("lead-detail")).toHaveAttribute("data-status", "promoted")

    const openButton = page.getByTestId("reassign-open-button")
    await expect(
      openButton,
      "#130's entry point: 'Present on every data-status=\"promoted\" rendering of /leads/:id'",
    ).toBeVisible()
    await expect(openButton, "contract: text 'Reassign project'").toHaveText("Reassign project")
    await expect(openButton, "a label acting as a button").toHaveAttribute("role", "button")
    await expect(
      openButton,
      "the label drives `reassign-toggle` — this is the no-JavaScript disclosure",
    ).toHaveAttribute("for", "reassign-toggle")

    const toggle = page.getByTestId("reassign-toggle")
    await expect(toggle, "`reassign-toggle` is a real checkbox").toHaveAttribute("type", "checkbox")
    await expect(toggle, "closed by default").not.toBeChecked()

    await expect(
      page.getByTestId("reassign-form"),
      "closed by default — the panel is not showing until the operator asks for it",
    ).toBeHidden()
    await expect(page.getByTestId("reassign-submit"), "…and neither is its submit").toBeHidden()

    await context.close()
  })

  /**
   * "A real, focusable checkbox, visually hidden ... the checkbox itself is the
   * keyboard's tab stop" — contract § "Reassignment (#130)".
   *
   * This is not pedantry about a hidden input: the *whole* disclosure is
   * keyboard-operable only if the checkbox can take focus. Hiding it with
   * `display: none` or `hidden` would render the panel unreachable without a
   * mouse, which is exactly what the clip-rect technique in `src/render.ts`'s
   * `.composer-toggle` exists to avoid. Focus is driven through `evaluate` so
   * this asserts the element's own focusability rather than Playwright's
   * actionability rules.
   */
  test("the disclosure opens and closes from the keyboard-reachable toggle", async ({
    browser,
    baseURL,
  }) => {
    const context = await asOperator(browser, baseURL)
    const page = await context.newPage()
    const path = await soloLead(browser, baseURL, page)
    await page.goto(path)

    const toggle = page.getByTestId("reassign-toggle")
    // `evaluate()` has no default timeout either — assert the checkbox exists
    // first, so a missing hook fails in 5s with a message rather than hanging.
    await expect(
      toggle,
      "`reassign-toggle` is the checkbox the whole disclosure hangs off (contract § 'Reassignment')",
    ).toHaveCount(1)
    await toggle.evaluate((el: HTMLElement) => el.focus())
    expect(
      await toggle.evaluate((el) => el === document.activeElement),
      "`reassign-toggle` must be focusable — it is the keyboard's only way into this panel",
    ).toBe(true)

    await openReassign(page)
    await expect(toggle, "the label's click checks the toggle").toBeChecked()
    await expect(page.getByTestId("reassign-current-project")).toBeVisible()
    await expect(page.getByTestId("reassign-project-list")).toBeVisible()
    await expect(page.getByTestId("reassign-submit"), "contract: 'Move to this project'").toHaveText(
      "Move to this project",
    )

    const form = page.getByTestId("reassign-form")
    await expect(form, "the panel posts to #130's new route").toHaveAttribute(
      "action",
      `${path}/reassign`,
    )
    await expect(form, "…as a POST").toHaveAttribute("method", /post/i)

    const cancel = page.getByTestId("reassign-cancel")
    await expect(cancel, "the panel closes without submitting via `reassign-cancel`").toBeVisible()
    await expect(cancel, "a label acting as a button").toHaveAttribute("role", "button")
    await cancel.click()
    await expect(toggle, "cancel closes the panel without submitting").not.toBeChecked()
    await expect(form, "…and the panel goes away again").toBeHidden()
    expect(
      new URL(page.url()).pathname,
      "cancel submits nothing — the operator has not left the lead",
    ).toBe(path)

    await context.close()
  })

  /**
   * Contract: "A client with only one project ... still renders
   * `reassign-open-button` — opening it shows `reassign-project-list` with **no**
   * `reassign-project-option` (nothing to move to) and only
   * `reassign-project-option-new`."
   *
   * TODO(test-author): the contract explicitly declines to pin whether this
   * empty state carries explanatory copy ("a worker is free to add it"), so
   * nothing here asserts any text — only the presence of the list and of the
   * new-project option, and the absence of any sibling to move to.
   */
  test("a client with a single project is offered nothing but a new one", async ({
    browser,
    baseURL,
  }) => {
    const context = await asOperator(browser, baseURL)
    const page = await context.newPage()
    const path = await soloLead(browser, baseURL, page)
    await page.goto(path)
    await openReassign(page)

    await expect(page.getByTestId("reassign-project-list")).toBeVisible()
    await expect(
      page.getByTestId("reassign-project-option"),
      "this client's only project is the one the submission is already in, and a submission is " +
        "never offered a move to where it already is (contract: 'current project excluded')",
    ).toHaveCount(0)
    await expect(
      page.getByTestId("reassign-project-option-new"),
      "'Start a new project instead' is always on offer — it is #130's inline-create half",
    ).toHaveCount(1)

    await context.close()
  })

  /**
   * #130: "Scope: reassignment within one client's own projects. Moving a
   * submission to a *different client* entirely is out of scope here."
   * Contract: "There is no control anywhere in this contract for changing which
   * client a submission belongs to."
   *
   * A negative assertion, because that is the only kind this scope admits: the
   * panel must offer no field that names a client, a customer or an email.
   *
   * TODO(test-author): the contract's prose does not pin the reassignment
   * radios' `name` (mock 05 shows `projectChoice`, matching the promotion form
   * #129 pins by name). This asserts only what radio semantics actually require
   * — that every option belongs to ONE group — rather than the literal string,
   * so a worker who names the group differently is not failed for it.
   */
  test("the panel offers no way to move a submission to a different client", async ({
    browser,
    baseURL,
  }) => {
    const context = await asOperator(browser, baseURL)
    const page = await context.newPage()
    const path = await soloLead(browser, baseURL, page)
    await page.goto(path)
    await openReassign(page)

    const fields = await page
      .getByTestId("reassign-form")
      .locator("input, select, textarea")
      .evaluateAll((els) =>
        els.map((el) => (el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).name ?? ""),
      )

    expect(
      fields.filter((name) => /client|customer|owner|email/i.test(name)),
      "#130 is explicit that changing the owning client is out of scope — the panel must not " +
        `carry a field for it. Fields found: ${JSON.stringify(fields)}`,
    ).toEqual([])

    const radioNames = await page
      .getByTestId("reassign-form")
      .locator('input[type="radio"]')
      .evaluateAll((els) => [...new Set(els.map((el) => (el as HTMLInputElement).name))])
    expect(
      radioNames.length,
      "the project choices are one radio group — picking a project must unpick the others, or " +
        `the form can submit two destinations at once. Groups found: ${JSON.stringify(radioNames)}`,
    ).toBe(1)

    await context.close()
  })

  /**
   * Contract § "Which projects are even offered": the list is built from
   * `SELECT * FROM projects WHERE client_id = ?`, so a project the customer
   * made themselves through "Start a follow-up" (#109) — same `customer_email`,
   * `client_id IS NULL`, because #128 does no backfill and infers nothing from a
   * matching address — "will **not** appear in either list. A test may create
   * such a project and assert it is absent from both."
   *
   * Taking the contract up on that offer, and getting the cross-client half for
   * free: this client's offer list is asserted to be *exactly* the one sibling
   * project it should have, at a point in the run where at least one other
   * client (the single-project one above, seeded on demand) already has
   * projects of its own. A leak in either direction breaks the count.
   */
  test("only this client's own client-linked projects are on offer", async ({
    browser,
    baseURL,
    request,
  }) => {
    const context = await asOperator(browser, baseURL)
    const page = await context.newPage()

    // Guarantee some *other* client with projects of its own exists, whatever
    // order this file's tests are filtered into.
    await soloLead(browser, baseURL, page)

    const email = "imani.mixed.130@example.test"

    // First, a project made the customer's own way (#109): client_id IS NULL.
    const origin = await fileRequest(request, email, "A booking page that stops double-booking Saturdays")
    await fileRequest(request, email, "The same booking page, now with deposits", origin)
    const nullClientProjects = await dashboardProjectIds(request, email)
    expect(
      nullClientProjects.length,
      "a follow-up (#109) creates exactly one project for this customer, and this slice needs " +
        "its id to assert it is never offered as a reassignment target",
    ).toBe(1)
    const orphanProjectId = nullClientProjects[0]

    // Then two promoted leads on that same address: the first mints the client
    // and its first project, the second creates a second one via #129's "new"
    // radio. Only these two carry the client's id.
    const secondPath = await twoProjectLead(
      browser,
      baseURL,
      page,
      twoProjectClient(
        "MIXED130",
        email,
        "a seasonal pop-up microsite for the same shop.",
        "a print flyer to match the pop-up microsite, separate job.",
      ),
    )

    await page.goto(secondPath)
    await openReassign(page)
    const offered = await offeredProjectIds(page)

    expect(
      offered,
      "this client has exactly two `client_id`-linked projects and the submission sits in one of " +
        `them, so exactly one is on offer. Offered: ${JSON.stringify(offered)}`,
    ).toHaveLength(1)
    expect(
      offered,
      `the customer's own follow-up project ${orphanProjectId} has client_id IS NULL (#128: no ` +
        "backfill, no inference from a matching email) and is not this client's to be moved into",
    ).not.toContain(orphanProjectId)

    await context.close()
  })

  /**
   * The move itself.
   *
   * What makes this observable without reading the database is that the offer
   * list is *derived from where the submission currently is* — the contract
   * builds it as "every **other** project belonging to the same client
   * (`client_id` match, current project excluded)". So after a successful move
   * into project A, A must drop off the list and the project the submission
   * came from must appear on it. A no-op POST leaves the list exactly as it
   * was, and fails here.
   *
   * TODO(test-author): the contract pins `reassign-current-project` as "the
   * submission's current project, by name" but pins no *text*, and § "The
   * 'Project 1' title" makes clear the name is derived from the project's
   * newest submission — which is the submission that just moved. So the label's
   * wording is asserted only to be present and non-empty; the ids carry the
   * real assertion.
   */
  test("moving to another project takes the submission out of the one it was in", async ({
    browser,
    baseURL,
  }) => {
    const context = await asOperator(browser, baseURL)
    const page = await context.newPage()
    const secondPath = await twoProjectLead(
      browser,
      baseURL,
      page,
      twoProjectClient(
        "MOVE130",
        "sasha.move.130@example.test",
        "a recipe archive that survives the next site rebuild.",
        "a newsletter template built from the recipe archive.",
      ),
    )

    await page.goto(secondPath)
    await openReassign(page)
    await expect(
      page.getByTestId("reassign-current-project"),
      "the panel says which project the submission is in today",
    ).not.toBeEmpty()

    const before = await offeredProjectIds(page)
    expect(before, `exactly one sibling project to move to. Offered: ${JSON.stringify(before)}`).toHaveLength(1)
    const destination = before[0]

    await chooseOption(page.getByTestId("reassign-project-option").first(), "the sibling project on offer")
    await submitReassign(page, secondPath)

    await openReassign(page)
    const after = await offeredProjectIds(page)
    expect(
      after,
      `the submission is now in ${destination}, so that project is no longer somewhere to move ` +
        `it to — and the project it came from is. Offered after the move: ${JSON.stringify(after)}`,
    ).toHaveLength(1)
    expect(
      after,
      "a submission is never offered a move to the project it is already in " +
        "(contract: 'current project excluded')",
    ).not.toContain(destination)

    await context.close()
  })

  /**
   * #130's other half: "including 'create a new project' inline, without leaving
   * the screen", and "wants to split one submission's follow-up work into a
   * fresh project".
   *
   * Also this slice's #130-only reading of "applies to any already-promoted
   * submission, not just at promotion time": the control is still there, and
   * still works, after a reassignment has already happened to this submission.
   *
   * TODO(test-author): the contract's fuller version of that claim is mock 04 —
   * `reassign-open-button` surviving #132's "Start work" override. That
   * crosses into another issue's slice (a missing `start-work-button` would
   * fail this test for a reason that is not #130's), so it is left to #132's
   * author, who has the button. Flagged rather than silently dropped.
   */
  test("creating a new project inline moves the submission into it, and reassignment stays available", async ({
    browser,
    baseURL,
  }) => {
    const context = await asOperator(browser, baseURL)
    const page = await context.newPage()
    const secondPath = await twoProjectLead(
      browser,
      baseURL,
      page,
      twoProjectClient(
        "SPLIT130",
        "devi.split.130@example.test",
        "a volunteer rota that fits on a phone screen.",
        "printable rota cards for the noticeboard.",
      ),
    )

    await page.goto(secondPath)
    await openReassign(page)
    const before = await offeredProjectIds(page)
    expect(before, "one sibling project before the split").toHaveLength(1)
    const sibling = before[0]

    await chooseOption(page.getByTestId("reassign-project-option-new"), "'Start a new project instead'")
    await submitReassign(page, secondPath)

    // The submission now sits in a project that did not exist a moment ago, so
    // BOTH of the client's older projects are somewhere it could move back to.
    await expect(
      page.getByTestId("reassign-open-button"),
      "reassignment is not consumed by use — #130 applies to any already-promoted submission",
    ).toBeVisible()
    await openReassign(page)
    const after = await offeredProjectIds(page)
    expect(
      after,
      "the submission moved into a brand-new third project, leaving both older ones on offer — " +
        `if the POST had done nothing there would still be just one. Offered: ${JSON.stringify(after)}`,
    ).toHaveLength(2)
    expect(
      after,
      `the project the submission came from (${sibling}) is now somewhere it can be moved back to`,
    ).toContain(sibling)

    await context.close()
  })

  // ── controls and ratchets: green now, and must stay green ─────────────────

  /**
   * CONTROL — expected GREEN both before and after #130, and therefore absent
   * from the manifest's `expected_red` block (observed, not intended).
   *
   * The contract puts reassignment on "every `data-status="promoted"`
   * rendering" — and mock 01, the *un*promoted lead, carries none of it. That
   * is not decoration: there is no attached submission to move before promotion,
   * and #130's own text scopes itself to "any already-promoted submission".
   * A worker who rendered the panel unconditionally would break this.
   */
  test("an unpromoted lead offers no reassignment at all", async ({ browser, baseURL }) => {
    const context = await asOperator(browser, baseURL)
    const page = await context.newPage()
    const path = await leadPath(
      page,
      browser,
      baseURL,
      seedFor(
        "UNPROMOTED130",
        "kit.unpromoted.130@example.test",
        "a gallery page for a ceramics studio, nothing decided yet.",
      ),
    )
    await page.goto(path)

    await expect(page.getByTestId("lead-detail")).toHaveAttribute("data-status", "new")
    for (const hook of [
      "reassign-open-button",
      "reassign-toggle",
      "reassign-form",
      "reassign-submit",
    ]) {
      await expect(
        page.getByTestId(hook),
        `${hook} belongs to a promoted lead — before promotion there is no submission to move`,
      ).toHaveCount(0)
    }

    await context.close()
  })

  /**
   * CONTROL — expected GREEN both before and after #130.
   *
   * Contract: `/leads/:id/reassign` "sits next to `/leads/:id/promote` ... same
   * operator gate (`readOperator`), same 'any other method on a `/leads…` path
   * gets the lead-not-found 404' rule ms-2's contract already pins". So a
   * stranger who guesses the URL is told nothing — not 403, not a login
   * redirect, and above all the submission does not move.
   *
   * Green today only because the route does not exist yet and everything under
   * `/leads` 404s a stranger; it earns its place by staying green *after* the
   * route lands, which is the moment the gate could actually be got wrong.
   */
  test("a stranger cannot reassign anything", async ({ browser, baseURL, request }) => {
    const operator = await asOperator(browser, baseURL)
    const path = await soloLead(browser, baseURL, await operator.newPage())
    await operator.close()

    const stranger = await asStranger(browser, baseURL)
    const anonymous = await stranger.request.post(`${path}/reassign`, {
      form: {},
      maxRedirects: 0,
      failOnStatusCode: false,
    })
    expect(
      anonymous.status(),
      "an anonymous caller gets the lead-not-found 404, never a 403 and never a login redirect",
    ).toBe(404)
    await stranger.close()

    const nonOperator = await request.post(`${path}/reassign`, {
      headers: { [ACCESS_HEADER]: "curious.customer.130@example.test" },
      form: {},
      maxRedirects: 0,
      failOnStatusCode: false,
    })
    expect(
      nonOperator.status(),
      "a signed-in customer is not an operator — reassignment is an operator action (#130's title)",
    ).toBe(404)

    const unknownLead = await request.post("/leads/lead_does_not_exist_130/reassign", {
      headers: { [ACCESS_HEADER]: OPERATOR_EMAIL },
      form: {},
      maxRedirects: 0,
      failOnStatusCode: false,
    })
    expect(
      unknownLead.status(),
      "a lead that does not exist 404s for the operator too",
    ).toBe(404)
  })

  /**
   * RATCHET — expected GREEN both before and after #130.
   *
   * #130 *adds* a control to a screen ms-2 already pins. The contract is
   * explicit that "every hook ms-2 already pins ... keeps exactly its ms-2
   * meaning and rendering. This contract only adds to that surface." The most
   * plausible way to get #130 wrong is not "the panel is missing" — the tests
   * above catch that — it is "the panel arrived and pushed something off the
   * screen". This is what notices.
   */
  test("adding reassignment disturbs nothing ms-2 already pins on a promoted lead", async ({
    browser,
    baseURL,
  }) => {
    const context = await asOperator(browser, baseURL)
    const page = await context.newPage()
    const path = await soloLead(browser, baseURL, page)
    await page.goto(path)

    await expect(page.getByTestId("lead-detail")).toHaveAttribute("data-status", "promoted")
    for (const hook of [
      "back-to-leads",
      "lead-status-pill",
      "lead-reference",
      "lead-summary-full",
      "lead-contact-email",
      "access-seat-manual-step",
      "promoted-submission-reference",
    ]) {
      await expect(
        page.getByTestId(hook),
        `ms-2's ${hook} keeps exactly its ms-2 meaning and rendering on a promoted lead`,
      ).toBeVisible()
    }
    await expect(
      page.getByTestId("promote-lead-form"),
      "promotion is still one-way in the UI — reassignment does not bring the promote form back",
    ).toHaveCount(0)

    await context.close()
  })
})
