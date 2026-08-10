import { expect, test, type Browser, type Page } from "@playwright/test"

/**
 * Black-box coverage for issue #33 (lead triage — promote a lead to a
 * submission, and issue the Access seat), driving the real Worker under
 * `wrangler dev` — see `playwright.config.ts`. This is the project's own
 * `e2e/` tier, not the sealed acceptance suite under `tests/acceptance/`; per
 * CLAUDE.md this repo still ships its own coverage for behaviour-changing work.
 *
 * Every string below is invented — see CLAUDE.md rule 1.
 *
 * ── WRITTEN FOR A SHARED, ACCUMULATING DATABASE ────────────────────────────
 * `serve:test` (unlike `serve:acceptance`) does not wipe `.wrangler/state`, the
 * suite runs `fullyParallel`, and `/leads` is the one unscoped list in this
 * repo — it shows every lead anyone has ever sent, including the ones the last
 * three runs left behind. So nothing here counts rows globally: every
 * assertion is scoped to a nonce this test minted, and "exactly one submission"
 * is asserted against the customer's own dashboard, which is scoped by
 * construction (#12).
 */

const ACCESS_HEADER = "Cf-Access-Authenticated-User-Email"

/**
 * The operator identity `wrangler dev` honours when `OPERATOR_EMAILS` is unset
 * — see `DEV_OPERATOR_EMAIL` in `src/operators.ts`. Locally there is no Access
 * and no secret store, so this is what stands in for the configured allowlist;
 * behind Cloudflare's edge it is honoured by nothing.
 */
const DEV_OPERATOR = "ops@example.test"

function nonce(): string {
  return Math.random().toString(36).slice(2, 10)
}

async function contextFor(browser: Browser, baseURL: string | undefined, email: string | null) {
  return browser.newContext({
    baseURL,
    extraHTTPHeaders: email ? { [ACCESS_HEADER]: email } : {},
  })
}

/** Sends one lead through the public form and returns what a stranger would quote. */
async function sendLead(
  page: Page,
  lead: { summary: string; email: string; name?: string },
): Promise<{ reference: string }> {
  await page.goto("/start")
  await page.getByTestId("field-lead-summary").fill(lead.summary)
  await page.getByTestId("field-lead-email").fill(lead.email)
  if (lead.name) await page.getByTestId("field-lead-name").fill(lead.name)
  await page.getByTestId("submit-lead").click()
  await expect(page.getByTestId("lead-receipt")).toBeVisible()

  const reference = (await page.getByTestId("lead-reference").innerText())
    .replace(/^Reference\s+/, "")
    .trim()
  return { reference }
}

/** The operator's row for one lead, found by the summary this run minted. */
function rowFor(page: Page, summary: string) {
  return page.getByTestId("lead-row").filter({ hasText: summary })
}

test("an operator reads a lead, promotes it, and is told the Access seat is manual", async ({
  browser,
  baseURL,
}) => {
  const tag = nonce()
  const summary = `A synthetic booking flow for e2e lead triage (${tag}).`
  const customerEmail = `lead-${tag}@example.test`

  const strangerContext = await contextFor(browser, baseURL, null)
  const stranger = await strangerContext.newPage()
  const { reference } = await sendLead(stranger, {
    summary,
    email: customerEmail,
    name: "Synthetic Stranger",
  })
  expect(reference).toMatch(/^LEAD-[A-Z0-9]{6}$/)
  await strangerContext.close()

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()

  // The inbox: enough of each lead to decide, and who the operator is.
  await operator.goto("/leads")
  await expect(operator.getByTestId("identity-email")).toHaveText(`signed in as ${DEV_OPERATOR}`)
  await expect(operator.getByTestId("nav-leads")).toHaveAttribute("aria-current", "page")

  const row = rowFor(operator, summary)
  await expect(row).toHaveCount(1)
  await expect(row).toHaveAttribute("data-status", "new")
  await expect(row.getByTestId("lead-contact-email")).toHaveText(customerEmail)
  await expect(row.getByTestId("lead-status-pill")).toHaveText("New")
  await expect(row.getByTestId("lead-submitted-at")).toHaveText(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
  )

  // The detail screen, before the operator acts.
  await row.getByTestId("review-lead").click()
  await expect(operator).toHaveURL(/\/leads\/lead_[0-9a-f]{12}$/)
  await expect(operator.getByTestId("lead-detail")).toHaveAttribute("data-status", "new")
  await expect(operator.getByTestId("lead-reference")).toContainText(reference)
  await expect(operator.getByTestId("lead-summary-full")).toHaveText(summary)
  await expect(operator.getByTestId("lead-contact-email")).toHaveText(customerEmail)
  await expect(operator.getByTestId("lead-name")).toHaveText("Synthetic Stranger")

  // Issue #33's non-negotiable, half one: the warning lands BEFORE the click,
  // while it can still stop a submission being made for an address nobody
  // checked, and it names the exact address the seat has to be issued to.
  const reminder = operator.getByTestId("access-seat-reminder")
  await expect(reminder).toBeVisible()
  await expect(reminder).toContainText(customerEmail)
  await expect(reminder).toContainText(/access policy/i)

  await operator.getByTestId("promote-button").click()

  // Half two: the same instruction after the fact, verbatim, as an alert. A
  // promoted customer nobody adds to the policy is accepted and never told.
  await expect(operator.getByTestId("lead-detail")).toHaveAttribute("data-status", "promoted")
  const manualStep = operator.getByTestId("access-seat-manual-step")
  await expect(manualStep).toHaveAttribute("role", "alert")
  await expect(manualStep).toHaveText(
    `This customer cannot sign in yet. Add ${customerEmail} to the Access policy by hand to finish onboarding them.`,
  )

  // What it produced, as plain text: `/submissions/:id` is scoped to the
  // customer (#12), so a link here would 404 for the only person who clicks it.
  const promoted = operator.getByTestId("promoted-submission-reference")
  await expect(promoted).toHaveText(/Promoted to submission SUB-[A-Z0-9]{6}/)
  await expect(promoted.locator("a")).toHaveCount(0)

  // Promotion is a one-way transition in the UI.
  await expect(operator.getByTestId("promote-lead-form")).toHaveCount(0)
  await expect(operator.getByTestId("promote-button")).toHaveCount(0)

  // ...and the inbox agrees, at the same URL, after a reload.
  await operator.goto("/leads")
  await expect(rowFor(operator, summary)).toHaveAttribute("data-status", "promoted")
  await expect(rowFor(operator, summary).getByTestId("lead-status-pill")).toHaveText("Promoted")
  await operatorContext.close()

  // The submission is an ordinary one, owned by the lead's email — visible to
  // that customer the moment somebody issues them the seat, and to nobody else.
  const customerContext = await contextFor(browser, baseURL, customerEmail)
  const customer = await customerContext.newPage()
  await customer.goto("/submissions")
  const rows = customer.getByTestId("submission-row")
  await expect(rows).toHaveCount(1)
  await expect(rows).toContainText(summary)
  await expect(rows.getByTestId("status-pill")).toHaveText("Describing")
  await customerContext.close()
})

test("promoting the same lead twice produces one submission", async ({ browser, baseURL }) => {
  const tag = nonce()
  const summary = `A synthetic idempotency check for e2e lead triage (${tag}).`
  const customerEmail = `twice-${tag}@example.test`

  const strangerContext = await contextFor(browser, baseURL, null)
  const stranger = await strangerContext.newPage()
  await sendLead(stranger, { summary, email: customerEmail })
  await strangerContext.close()

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()
  await operator.goto("/leads")
  await rowFor(operator, summary).getByTestId("review-lead").click()
  const leadUrl = operator.url()

  await operator.getByTestId("promote-button").click()
  const first = await operator.getByTestId("promoted-submission-reference").innerText()

  // The second promote is the retry the UI no longer offers: a resubmitted
  // POST, exactly what a double-click or a refreshed form does.
  const retry = await operatorContext.request.post(`${leadUrl}/promote`)
  expect(retry.status()).toBe(200) // 303 followed to the lead's detail screen

  await operator.goto(leadUrl)
  await expect(operator.getByTestId("promoted-submission-reference")).toHaveText(first.trim())
  await operatorContext.close()

  // One submission on the customer's own dashboard — the scoped list, so this
  // counts what promotion actually created and nothing another test wrote.
  const customerContext = await contextFor(browser, baseURL, customerEmail)
  const customer = await customerContext.newPage()
  await customer.goto("/submissions")
  await expect(customer.getByTestId("submission-row")).toHaveCount(1)
  await customerContext.close()
})

test("the leads surface is a 404 to anyone who is not the operator", async ({
  browser,
  baseURL,
}) => {
  const tag = nonce()
  const summary = `A synthetic lead nobody else may read (${tag}).`

  const strangerContext = await contextFor(browser, baseURL, null)
  const stranger = await strangerContext.newPage()
  await sendLead(stranger, { summary, email: `hidden-${tag}@example.test` })
  await strangerContext.close()

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()
  await operator.goto("/leads")
  await rowFor(operator, summary).getByTestId("review-lead").click()
  const leadUrl = new URL(operator.url()).pathname
  await operatorContext.close()

  // A customer, and an anonymous caller, get the same answer for all three
  // routes: 404, never a 403 and never a login redirect. A response that only
  // fires for "someone else" would itself confirm the surface exists.
  for (const identity of [`customer-${tag}@example.test`, null]) {
    const context = await contextFor(browser, baseURL, identity)
    for (const path of ["/leads", leadUrl]) {
      const response = await context.request.get(path)
      expect(response.status(), `GET ${path} as ${identity ?? "nobody"}`).toBe(404)
      expect(await response.text()).not.toContain(summary)
    }
    const promote = await context.request.post(`${leadUrl}/promote`)
    expect(promote.status(), `POST promote as ${identity ?? "nobody"}`).toBe(404)
    await context.close()
  }

  // ...and it really was not promoted by any of that.
  const recheck = await contextFor(browser, baseURL, DEV_OPERATOR)
  const page = await recheck.newPage()
  await page.goto(leadUrl)
  await expect(page.getByTestId("lead-detail")).toHaveAttribute("data-status", "new")
  await recheck.close()
})

test("a lead sent without a name renders no name at all", async ({ browser, baseURL }) => {
  const tag = nonce()
  const summary = `A synthetic anonymous-ish lead (${tag}).`

  const strangerContext = await contextFor(browser, baseURL, null)
  const stranger = await strangerContext.newPage()
  await sendLead(stranger, { summary, email: `noname-${tag}@example.test` })
  await strangerContext.close()

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()
  await operator.goto("/leads")
  await rowFor(operator, summary).getByTestId("review-lead").click()
  await expect(operator.getByTestId("lead-summary-full")).toHaveText(summary)
  await expect(operator.getByTestId("lead-name")).toHaveCount(0)
  await operatorContext.close()
})

interface PulledEvent {
  type: string
  submission_id: string
  payload: Record<string, unknown>
}

/** Every event the daemon can see today, following the cursor to the end. */
async function pullAll(request: {
  get: (url: string) => Promise<{ json: () => Promise<unknown> }>
}): Promise<PulledEvent[]> {
  const all: PulledEvent[] = []
  let cursor: string | null = null

  for (let page = 0; page < 50; page++) {
    const query = cursor === null ? "?limit=200" : `?cursor=${encodeURIComponent(cursor)}&limit=200`
    const body = (await (await request.get(`/api/bridge/pull${query}`)).json()) as {
      events: PulledEvent[]
      cursor: string
      has_more: boolean
    }
    all.push(...body.events)
    cursor = body.cursor
    if (!body.has_more) break
  }
  return all
}

test("promotion tells the bridge about a submission, and never about the lead", async ({
  browser,
  baseURL,
}) => {
  const tag = nonce()
  // Deliberately does not contain the word this test greps the wire for.
  const summary = `A synthetic first-contact note the daemon must never see (${tag}).`
  const contact = `bridge-${tag}@example.test`

  const bridgeContext = await browser.newContext({
    baseURL,
    extraHTTPHeaders: {
      "CF-Access-Client-Id": `e2e-lead-daemon-${tag}.access`,
      "CF-Access-Client-Secret": `e2e-lead-daemon-secret-${tag}`,
    },
  })

  const strangerContext = await contextFor(browser, baseURL, null)
  const stranger = await strangerContext.newPage()
  await sendLead(stranger, { summary, email: contact })
  await strangerContext.close()

  // A lead on its own is inert: nothing about it crosses, at all.
  const afterLead = await pullAll(bridgeContext.request)
  expect(JSON.stringify(afterLead)).not.toContain(summary)
  expect(JSON.stringify(afterLead)).not.toContain(contact)

  const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
  const operator = await operatorContext.newPage()
  await operator.goto("/leads")
  await rowFor(operator, summary).getByTestId("review-lead").click()
  await operator.getByTestId("promote-button").click()
  const promotedRef = (await operator.getByTestId("promoted-submission-reference").innerText())
    .replace(/^Promoted to submission\s+/, "")
    .trim()
  await operatorContext.close()

  // Promotion looks like ordinary intake from the daemon's side: exactly one
  // `submission.created`, keyed by the submission's reference, and nothing in
  // it that so much as hints a lead was involved.
  const mine = (await pullAll(bridgeContext.request)).filter(
    (event) => event.submission_id === promotedRef,
  )
  expect(mine.map((event) => event.type)).toEqual(["submission.created"])

  const wire = JSON.stringify(mine)
  expect(wire).not.toContain("lead")
  expect(wire).not.toContain("LEAD-")
  // The customer's email is #14's business, not the fleet's — same as intake.
  expect(wire).not.toContain(contact)
  // ...and what the stranger actually wrote does cross, as the outcome, which
  // is what makes this indistinguishable from a customer filling in /intake.
  expect(mine[0]?.payload["outcome"]).toBe(summary)

  await bridgeContext.close()
})
