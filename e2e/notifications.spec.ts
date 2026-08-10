import { expect, test, type APIRequestContext, type Page } from "@playwright/test"

/**
 * Black-box coverage for issue #14 ([portal] Customer notifications — email,
 * digest-first), driving the real Worker under `wrangler dev` with real local
 * D1 — see `playwright.config.ts`. This is the project's own `e2e/` tier, not
 * the sealed acceptance suite under `tests/acceptance/`; per CLAUDE.md this
 * repo still ships its own coverage for behaviour-changing work (this PR adds
 * the `outbox` table, `src/notifications.ts` and `GET /outbox`).
 *
 * SHAPE. Issue #14 is one rule with two halves, and both need their own test:
 *
 *   REACH    a design round ready for sign-off (`awaiting-signoff`), a
 *            question raised (`needs-input`) and work shipped (`shipped`)
 *            each put exactly one email in the customer's outbox.
 *   RESTRAIN every other status transition — and coord-side churn that never
 *            even touches `status` — produces none.
 *
 * `GET /outbox` (src/routes/outbox.ts) is this repo's own black-box read-back
 * of "what the portal decided to send" — nothing here can observe a real
 * inbox. `status`, `question` and `design_round` are all coord-owned, so the
 * only way to drive a submission into a sending state is a bridge push (#15's
 * surface); the only way to author one is #9's pinned intake form. Both are
 * used here as instruments, not as subjects.
 *
 * Every string below is invented — see CLAUDE.md rule 1.
 */

const SERVICE_TOKEN = {
  "CF-Access-Client-Id": "e91a4c7b3d6f0852a1eb4907c3d612f8.access",
  "CF-Access-Client-Secret":
    "6b2e0c9a17df4358b0c67ea4152d9f7038c165ae2fb804d13c6a09e754fdc12b",
}

/**
 * `serve:test` does not wipe `.wrangler/state` between runs (see the note in
 * `e2e/bridge.spec.ts`), so identities are tagged unique per run rather than
 * risking a row another run left behind — an outbox is cumulative, so this is
 * the only isolation available.
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
  await page.getByTestId("field-outcome").fill("A synthetic outcome for e2e notifications coverage.")
  await page.getByTestId("field-audience").fill("synthetic e2e readers")
  await page.getByTestId("field-done-definition").fill("The notifications e2e suite goes green.")
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

/** Collapse the incidental whitespace of rendered HTML before comparing copy. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

interface Sent {
  type: string | null
  from: string
  to: string
  subject: string
  preheader: string
  body: string
  ctaText: string
  ctaHref: string | null
  text: string
}

/** Read every `email-preview` `/outbox` renders for the signed-in caller. */
async function readOutbox(page: Page, email: string): Promise<Sent[]> {
  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": email })
  await page.goto("/outbox")

  const previews = page.getByTestId("email-preview")
  const count = await previews.count()
  const sent: Sent[] = []
  for (let i = 0; i < count; i++) {
    const preview = previews.nth(i)
    const cta = preview.getByTestId("email-cta")
    sent.push({
      type: await preview.getAttribute("data-email-type"),
      from: flat(await preview.getByTestId("email-from").innerText()),
      to: flat(await preview.getByTestId("email-to").innerText()),
      subject: flat(await preview.getByTestId("email-subject").innerText()),
      preheader: flat(await preview.getByTestId("email-preheader").innerText()),
      body: flat(await preview.getByTestId("email-body").innerText()),
      ctaText: flat(await cta.innerText()),
      ctaHref: await cta.getAttribute("href"),
      text: flat(await preview.innerText()),
    })
  }
  return sent
}

/**
 * Sends may be queued rather than synchronous — issue #14 is explicitly
 * "digest-first, not instant" — so this polls the outbox rather than reading
 * it once.
 */
async function awaitOutbox(page: Page, email: string, expected: number): Promise<Sent[]> {
  let sent: Sent[] = []
  await expect
    .poll(
      async () => {
        sent = await readOutbox(page, email)
        return sent.length
      },
      { message: `${email} must have exactly ${expected} email(s)`, timeout: 15_000 },
    )
    .toBe(expected)
  return sent
}

test("a design ready for sign-off sends exactly one signoff-ready email", async ({ page, request }) => {
  const email = uniqueEmail("e2e-signoff")
  const target = await seedSubmission(page, email)

  expect((await readOutbox(page, email)).length, "authoring a submission sends nothing").toBe(0)

  const applied = await push(request, target.reference, 1, {
    design_round: {
      round: 1,
      outcome_definition: "A rota page volunteers can check on their phone.",
      decomposition: ["A rota page showing who waters which beds this week"],
      mock_bundle_url: "https://mocks.example.test/rota/round-1/",
    },
    status: "awaiting-signoff",
  })
  expect(applied.outcome).toBe("applied")

  const [sent] = await awaitOutbox(page, email, 1)
  expect(sent.type).toBe("signoff-ready")
  expect(sent.to).toContain(email)
  expect(sent.from).toContain("@")
  expect(sent.subject.length).toBeGreaterThan(0)
  expect(sent.preheader.length).toBeGreaterThan(0)
  expect(sent.body.length).toBeGreaterThan(0)
  expect(sent.ctaText.length).toBeGreaterThan(0)
})

test("a raised question sends exactly one needs-input email", async ({ page, request }) => {
  const email = uniqueEmail("e2e-question")
  const target = await seedSubmission(page, email)

  const applied = await push(request, target.reference, 1, {
    question: "Should a swapped shift need the rota owner to confirm it?",
    status: "needs-input",
  })
  expect(applied.outcome).toBe("applied")

  const [sent] = await awaitOutbox(page, email, 1)
  expect(sent.type).toBe("needs-input")
  expect(sent.to).toContain(email)
  expect(sent.ctaText.length).toBeGreaterThan(0)
})

test("shipped work sends exactly one final email, and nothing before it", async ({ page, request }) => {
  const email = uniqueEmail("e2e-shipped")
  const target = await seedSubmission(page, email)

  let revision = 1
  for (const status of ["in-design", "planned", "in-progress", "quality-check"]) {
    expect((await push(request, target.reference, revision++, { status })).outcome).toBe("applied")
  }
  expect((await readOutbox(page, email)).length, "the run-up to shipping is silent").toBe(0)

  expect((await push(request, target.reference, revision++, { status: "shipped" })).outcome).toBe(
    "applied",
  )
  const [sent] = await awaitOutbox(page, email, 1)
  expect(sent.type).toBe("shipped")
  expect(sent.to).toContain(email)
})

test("only the three sending states ever produce an email — coord churn never does", async ({
  page,
  request,
}) => {
  const email = uniqueEmail("e2e-silence")
  const target = await seedSubmission(page, email)

  let revision = 1
  for (const status of ["describing", "in-design", "planned", "in-progress", "quality-check"]) {
    expect((await push(request, target.reference, revision++, { status })).outcome).toBe("applied")
    expect(
      (await readOutbox(page, email)).length,
      `\`${status}\` is neither customer-actionable nor terminal`,
    ).toBe(0)
  }

  // Coord-side churn that never even names `status`: a decomposition edit, a
  // replaced artifact, a heartbeat. None of it is the customer's business.
  expect(
    (await push(request, target.reference, revision++, {
      decomposition: ["A revised plan, pass two"],
    })).outcome,
  ).toBe("applied")
  expect(
    (await push(request, target.reference, revision++, {
      artifacts: [{ kind: "screenshot", url: "https://mocks.example.test/rota/churn.png" }],
    })).outcome,
  ).toBe("applied")
  const heartbeat = await request.post("/api/bridge/heartbeat", {
    data: { at: "2026-01-05T12:00:00Z" },
    headers: SERVICE_TOKEN,
  })
  expect(heartbeat.status()).toBe(200)
  expect((await readOutbox(page, email)).length, "field churn with no status is not news").toBe(0)

  // Positive control: absence is only meaningful next to a presence the same
  // mechanism did observe.
  expect((await push(request, target.reference, revision++, { status: "shipped" })).outcome).toBe(
    "applied",
  )
  const sent = await awaitOutbox(page, email, 1)
  expect(sent[0]?.type).toBe("shipped")
})

test("a replayed push never re-sends an email", async ({ page, request }) => {
  const email = uniqueEmail("e2e-replay")
  const target = await seedSubmission(page, email)

  const round = {
    status: "awaiting-signoff",
    design_round: {
      round: 1,
      outcome_definition: "A rota page volunteers can check on their phone.",
      decomposition: ["A rota page"],
    },
  }
  expect((await push(request, target.reference, 1, round)).outcome).toBe("applied")
  await awaitOutbox(page, email, 1)

  // The identical push again, and a stale one behind it — both idempotent.
  expect((await push(request, target.reference, 1, round)).outcome).toBe("already_applied")
  expect((await push(request, target.reference, 1, round)).outcome).toBe("already_applied")

  // A genuinely new sending state flushes the queue and proves the replays
  // above added nothing: if either had sent, this would read 3, not 2.
  expect(
    (await push(request, target.reference, 2, { question: "Which region first?", status: "needs-input" }))
      .outcome,
  ).toBe("applied")
  const sent = await awaitOutbox(page, email, 2)
  expect(sent.map((s) => s.type).sort()).toEqual(["needs-input", "signoff-ready"])
})

test("the email's call to action returns the customer to the submission it is about", async ({
  page,
  request,
}) => {
  const email = uniqueEmail("e2e-cta")
  const target = await seedSubmission(page, email)

  expect(
    (await push(request, target.reference, 1, { question: "Any blackout dates?", status: "needs-input" }))
      .outcome,
  ).toBe("applied")
  const [sent] = await awaitOutbox(page, email, 1)

  expect(sent.ctaHref).toBeTruthy()
  await page.goto(sent.ctaHref as string)
  await expect(page.getByTestId("submission-detail")).toBeVisible()
  expect(await page.getByTestId("submission-reference").innerText()).toContain(target.reference)
  expect(await page.getByTestId("status-pill").getAttribute("data-status")).toBe("needs-input")
})

test("an outbox is scoped to its own customer, never another's", async ({ browser, request }) => {
  const aliceEmail = uniqueEmail("e2e-alice")
  const bobEmail = uniqueEmail("e2e-bob")

  const aliceContext = await browser.newContext({
    extraHTTPHeaders: { "Cf-Access-Authenticated-User-Email": aliceEmail },
  })
  const bobContext = await browser.newContext({
    extraHTTPHeaders: { "Cf-Access-Authenticated-User-Email": bobEmail },
  })
  const alice = await aliceContext.newPage()
  const bob = await bobContext.newPage()

  const target = await seedSubmission(alice, aliceEmail)
  await seedSubmission(bob, bobEmail)

  expect(
    (await push(request, target.reference, 1, { question: "One question for Alice.", status: "needs-input" }))
      .outcome,
  ).toBe("applied")

  const [toAlice] = await awaitOutbox(alice, aliceEmail, 1)
  expect(toAlice.to).toContain(aliceEmail)

  const bobsOutbox = await readOutbox(bob, bobEmail)
  expect(bobsOutbox.length, "nothing happened to Bob's submission").toBe(0)

  await aliceContext.close()
  await bobContext.close()
})

test("no other portal screen renders an email-preview", async ({ page, request }) => {
  const email = uniqueEmail("e2e-screens")
  const target = await seedSubmission(page, email)

  expect(
    (await push(request, target.reference, 1, { question: "One question.", status: "needs-input" }))
      .outcome,
  ).toBe("applied")
  await awaitOutbox(page, email, 1)

  for (const route of ["/intake", "/submissions", target.url]) {
    await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": email })
    await page.goto(route)
    await expect(page.getByTestId("email-preview")).toHaveCount(0)
  }
})

test("the outbox link is reachable from the dashboard's own navigation", async ({ page }) => {
  // Nit fixed alongside the sealed slice's own gap: the contract pins no route
  // that renders a sent email, but a customer still needs an in-product way to
  // find the one this repo ships (`GET /outbox`).
  const email = uniqueEmail("e2e-nav")
  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": email })
  await page.goto("/submissions")

  const navLink = page.getByTestId("nav-outbox")
  await expect(navLink).toBeVisible()
  await navLink.click()
  await expect(page).toHaveURL(/\/outbox$/)
  await expect(page.getByTestId("outbox-empty")).toBeVisible()
})

