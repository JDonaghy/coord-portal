import { expect, test, type Page } from "@playwright/test"

/**
 * ms-1 sealed acceptance slice — issue #9
 * "[portal] Async intake -> outcome definition + decomposition (no live chat)"
 *
 * Written from `tests/acceptance/ms-1/contract.md` and the mocks it pins
 * (`mocks/01-intake-form.html`, `mocks/02-intake-received.html`), without sight
 * of any implementation.
 *
 * SCOPE. Issue #9 was re-scoped on 2026-08-07 from a live requirements chat to
 * an asynchronous form: "It is now asynchronous — a form, not a conversation."
 * The customer-visible half of that issue is therefore exactly two screens —
 * the intake form (`GET /intake`) and the receipt it produces
 * (`GET /submissions/:id`, status `Describing`) — plus one boundary: the draft
 * design round the daemon produces from a submission is a *proposal an engineer
 * reviews*, so it must NOT be visible to the customer at `Describing`.
 * Publishing a round and the sign-off loop are #13; the dashboard list, the
 * status vocabulary as a whole, Access scoping and emails are #10/#12/#14.
 * Those surfaces are deliberately untouched here.
 *
 * The daemon-side agent run is not black-box testable from the portal: the
 * portal never runs a model, and the bridge is outbound-only (CLAUDE.md rule
 * 2), so nothing this suite can drive causes it to happen. What *is* assertable
 * from the customer side is the shape that re-scope guarantees — one write, no
 * conversation, a durable record, and no engineer-side detail leaking through.
 *
 * SYNTHETIC DATA. Per CLAUDE.md rule 1 and the contract's "Synthetic data"
 * section, every string submitted below is invented.
 */

const CUSTOMER_EMAIL = "ada@example.test"

/**
 * Local `wrangler dev` has no Cloudflare Access in front of it, so the caller's
 * identity is supplied the way `src/identity.ts` reads it in production. The
 * contract's screens all "assume a verified identity is already present", and
 * note that nothing may branch on `verified` being `true` (it is hard-coded
 * `false` until #1981) — so this header is the whole mechanism.
 */
test.use({
  extraHTTPHeaders: { "Cf-Access-Authenticated-User-Email": CUSTOMER_EMAIL },
})

/** Contract: `submission-reference` text pattern `Reference SUB-XXXXXX`. */
// TODO(test-author): the contract writes the reference as `SUB-XXXXXX` and the
// mock renders `SUB-7F3A2C`, but neither pins the alphabet (hex? base32?
// lowercase?) or says whether the length is fixed. Asserted here as six
// upper-case alphanumerics, which is the literal reading of both.
const REFERENCE_TEXT = /^Reference SUB-[A-Z0-9]{6}$/

/** Contract route surface: the POST from `/intake` redirects to `/submissions/:id`. */
const SUBMISSION_URL = /\/submissions\/[^/?#]+$/

const INTAKE = {
  outcome: "A weekly digest of overdue library books, sent to each branch.",
  audience: "our branch librarians",
  doneDefinition:
    "Every Monday, each branch receives one email listing only its own overdue items.",
  constraints: "No new login — the team already lives in email.",
  projectScope: "Circulation tools",
}

/** Fill the intake form. `optional: false` leaves the two optional fields blank. */
async function fillIntake(page: Page, { optional = true }: { optional?: boolean } = {}) {
  await page.getByTestId("field-outcome").fill(INTAKE.outcome)
  await page.getByTestId("field-audience").fill(INTAKE.audience)
  await page.getByTestId("field-done-definition").fill(INTAKE.doneDefinition)
  if (optional) {
    await page.getByTestId("field-constraints").fill(INTAKE.constraints)
    await page.getByTestId("field-project-scope").fill(INTAKE.projectScope)
  }
}

/**
 * Submit the intake form and wait for the receipt. Transport-agnostic on
 * purpose: contract note 3 leaves the request/response shape unpinned and note
 * 5 leaves server-rendered-vs-client-routing unpinned, so this asserts only
 * what the contract does pin — the customer ends up on `/submissions/:id`
 * looking at `intake-receipt`.
 */
async function submitIntake(page: Page): Promise<{ url: string; reference: string }> {
  await page.getByTestId("submit-intake").click()
  await expect(page.getByTestId("intake-receipt")).toBeVisible()
  await expect(page).toHaveURL(SUBMISSION_URL)
  const reference = (await page.getByTestId("submission-reference").innerText()).trim()
  return { url: page.url(), reference }
}

test.describe("ms-1 issue 9 async intake", () => {
  test("the intake screen is a form, not a conversation", async ({ page }) => {
    await page.goto("/intake")

    await expect(page.getByTestId("intake-form")).toBeVisible()

    // The five fields issue #9 names: "what they want, who it's for, what
    // 'done' looks like, constraints, optional project scope".
    for (const field of [
      "field-outcome",
      "field-audience",
      "field-done-definition",
      "field-constraints",
      "field-project-scope",
    ]) {
      await expect(page.getByTestId(field)).toBeVisible()
      await expect(page.getByTestId(field)).toBeEditable()
    }

    await expect(page.getByTestId("submit-intake")).toBeVisible()
    await expect(page.getByTestId("submit-intake")).toHaveText("Send to the team")

    // "A form, not a conversation": one write, not a turn in a thread. There is
    // exactly one control that submits, and none of the contract's
    // conversational surface (the question channel of #11) appears here.
    await expect(page.getByTestId("intake-form").getByRole("button")).toHaveCount(1)
    await expect(page.getByTestId("question-thread")).toHaveCount(0)
    await expect(page.getByTestId("answer-field")).toHaveCount(0)
    await expect(page.getByTestId("submit-answer")).toHaveCount(0)
  })

  test("submitting the form creates a submission and returns a reference", async ({
    page,
  }) => {
    await page.goto("/intake")
    await fillIntake(page)
    const { reference } = await submitIntake(page)

    expect(reference).toMatch(REFERENCE_TEXT)

    // The receipt is the `Describing` state of the submission detail route.
    await expect(page.getByTestId("status-pill")).toHaveAttribute(
      "data-status",
      "describing",
    )
    await expect(page.getByTestId("status-pill")).toHaveText("Describing")

    await expect(page.getByTestId("view-submission")).toHaveAttribute(
      "href",
      /\/submissions\//,
    )
    await expect(page.getByTestId("back-to-dashboard")).toHaveAttribute(
      "href",
      "/submissions",
    )
  })

  test("constraints and project scope really are optional", async ({ page }) => {
    await page.goto("/intake")
    await fillIntake(page, { optional: false })
    const { reference } = await submitIntake(page)

    expect(reference).toMatch(REFERENCE_TEXT)
    await expect(page.getByTestId("status-pill")).toHaveText("Describing")
  })

  test("an empty form creates no submission", async ({ page }) => {
    await page.goto("/intake")
    await page.getByTestId("submit-intake").click()

    // TODO(test-author): the contract pins the three required fields (issue #9:
    // "what they want, who it's for, what 'done' looks like") and the mock
    // marks them `required`, but neither pins any validation message, its
    // wording, or where it renders. Asserted here only as "nothing was
    // created", which is the part the contract does commit to.
    await page.waitForTimeout(1000) // no navigation to wait for; give one a chance to happen
    await expect(page).toHaveURL(/\/intake$/)
    await expect(page.getByTestId("intake-receipt")).toHaveCount(0)
  })

  test("each submission gets its own reference", async ({ page }) => {
    await page.goto("/intake")
    await fillIntake(page)
    const first = await submitIntake(page)

    await page.goto("/intake")
    await fillIntake(page)
    const second = await submitIntake(page)

    expect(second.reference).not.toBe(first.reference)
    expect(second.url).not.toBe(first.url)
  })

  test("a submission is a durable record, not a live session", async ({ page }) => {
    await page.goto("/intake")
    await fillIntake(page)
    const { url, reference } = await submitIntake(page)

    // "A form submission is a row in a table" — the customer can walk away and
    // come back to the same record. Nothing about it depends on a session that
    // was alive during the request.
    // TODO(test-author): the contract's hook list says the detail root is
    // `submission-detail` "all statuses", but `02-intake-received.html` roots
    // the same route in `intake-receipt` instead, and nothing pins whether a
    // later visit to a `Describing` submission still renders the receipt copy.
    // Asserted here only on the two hooks both readings agree on.
    await page.goto(url)
    await expect(page.getByTestId("submission-reference")).toHaveText(reference)
    await expect(page.getByTestId("status-pill")).toHaveAttribute(
      "data-status",
      "describing",
    )
  })

  test("a fresh submission shows the customer no design round", async ({ page }) => {
    await page.goto("/intake")
    await fillIntake(page)
    const { url } = await submitIntake(page)
    await page.goto(url)

    // Issue #9 ends at "a reviewed draft round exists": the decomposition is a
    // proposal an engineer reviews *before* it reaches the customer, and
    // publishing the round is #13. So at `Describing` none of the sign-off
    // surface exists yet.
    await expect(page.getByTestId("status-pill")).toHaveAttribute(
      "data-status",
      "describing",
    )
    for (const hook of [
      "design-round",
      "outcome-definition",
      "decomposition-list",
      "decomposition-item",
      "mock-bundle-link",
      "approve-button",
      "request-changes-button",
    ]) {
      await expect(page.getByTestId(hook)).toHaveCount(0)
    }
  })

  test("no engineer-side identifier reaches the intake surface", async ({ page }) => {
    // Contract note 6, treated there as absolute: "no mock renders any GitHub
    // issue number, PR number, branch name, or coord-side identifier anywhere
    // in customer-facing copy". The `SUB-XXXXXX` reference is portal-minted and
    // is explicitly not a GitHub number.
    // TODO(test-author): the contract also says customers never see "a live
    // agent", but does not pin whether the *word* agent is forbidden in copy
    // (as opposed to an agent identity/session id), so that is not asserted.
    const forbidden = [/#\d+/, /\bbranch\b/i, /\bpull request\b/i, /\bPR\s*#/i]

    await page.goto("/intake")
    const intakeText = await page.locator("body").innerText()
    for (const pattern of forbidden) expect(intakeText).not.toMatch(pattern)

    await fillIntake(page)
    const { reference } = await submitIntake(page)

    const receiptText = await page.locator("body").innerText()
    for (const pattern of forbidden) expect(receiptText).not.toMatch(pattern)
    expect(reference).toMatch(REFERENCE_TEXT)
  })
})
