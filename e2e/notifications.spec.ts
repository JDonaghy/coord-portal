import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test"

import { latestOutboxId, markOutboxFailed, markOutboxSent } from "./outbox-fixtures"

/**
 * Black-box coverage for issue #14 ([portal] Customer notifications — email,
 * digest-first), driving the real Worker under `wrangler dev` with real local
 * D1 — see `playwright.config.ts`. This is the project's own `e2e/` tier, not
 * the sealed acceptance suite under `tests/acceptance/`; per CLAUDE.md this
 * repo still ships its own coverage for behaviour-changing work (this PR adds
 * the `outbox` table, `src/notifications.ts` and `GET /outbox`).
 *
 * Extended for issue #49 ([portal] Outbox delivery state — queued / sent /
 * failed, visible at `/outbox`): the tests below drive `src/routes/outbox.ts`'s
 * `emailPreview`/`deliveryDetail`/`deliveryError` through the real route —
 * `data-status`, the `delivery-status` pill text, and the presence/absence
 * rules for `delivery-sent-at`/`delivery-attempts`/`delivery-last-error` — the
 * same DOM the sealed acceptance suite (`tests/acceptance/ms-3/49-outbox-delivery-state.spec.ts`)
 * pins, but that suite is explicit it only ever drives `queued` rows (nothing
 * black-box in *that* suite can reach `sent`/`failed` before #50's drain and
 * #51's provider seam exist). `e2e/outbox-fixtures.ts` shells out to `wrangler
 * d1 execute --local` to move a row past `queued` so this repo's own `e2e/`
 * tier — unlike the sealed suite — can still exercise every branch of that
 * rendering code today, not just the one state reachable through HTTP.
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
  /** Issue #49: the `email-preview` article's own `data-status`. */
  status: string | null
  /** Issue #49: `delivery-status` pill text — always present, one per row. */
  deliveryPillText: string | null
  /** Issue #49: `delivery-sent-at` text, or `null` when the hook is absent. */
  deliverySentAt: string | null
  /** Issue #49: `delivery-attempts` text, or `null` when the hook is absent. */
  deliveryAttempts: string | null
  /** Issue #49: `delivery-last-error` text, or `null` when the hook is absent. */
  deliveryLastError: string | null
}

/** `null` when the given testid is absent from this row, its flattened text otherwise. */
async function textOrNull(preview: Locator, testid: string): Promise<string | null> {
  const node = preview.getByTestId(testid)
  if ((await node.count()) === 0) return null
  return flat(await node.first().innerText())
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
      status: await preview.getAttribute("data-status"),
      deliveryPillText: await textOrNull(preview, "delivery-status"),
      deliverySentAt: await textOrNull(preview, "delivery-sent-at"),
      deliveryAttempts: await textOrNull(preview, "delivery-attempts"),
      deliveryLastError: await textOrNull(preview, "delivery-last-error"),
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

test("shipped work sends exactly one final email, and nothing before it but the preview gate", async ({
  page,
  request,
}) => {
  const email = uniqueEmail("e2e-shipped")
  const target = await seedSubmission(page, email)

  let revision = 1
  for (const status of ["in-design", "planned", "in-progress"]) {
    expect((await push(request, target.reference, revision++, { status })).outcome).toBe("applied")
  }
  expect((await readOutbox(page, email)).length, "the run-up to quality-check is silent").toBe(0)

  // Issue #107: `quality-check` is the third customer-actionable state and
  // sends its own email — it is not part of "the run-up" this test's name
  // otherwise describes, it is the pre-merge gate this issue adds.
  expect(
    (await push(request, target.reference, revision++, { status: "quality-check" })).outcome,
  ).toBe("applied")
  await awaitOutbox(page, email, 1)

  expect((await push(request, target.reference, revision++, { status: "shipped" })).outcome).toBe(
    "applied",
  )
  const sent = await awaitOutbox(page, email, 2)
  expect(sent.map((s) => s.type)).toEqual(["preview-ready", "shipped"])
  expect(sent[1]?.to).toContain(email)
})

test("only the four sending states ever produce an email — coord churn never does", async ({
  page,
  request,
}) => {
  const email = uniqueEmail("e2e-silence")
  const target = await seedSubmission(page, email)

  let revision = 1
  for (const status of ["describing", "in-design", "planned", "in-progress"]) {
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
  // mechanism did observe. `quality-check` (#107) is the fourth sending state.
  expect(
    (await push(request, target.reference, revision++, { status: "quality-check" })).outcome,
  ).toBe("applied")
  const afterQualityCheck = await awaitOutbox(page, email, 1)
  expect(afterQualityCheck[0]?.type).toBe("preview-ready")

  expect((await push(request, target.reference, revision++, { status: "shipped" })).outcome).toBe(
    "applied",
  )
  const sent = await awaitOutbox(page, email, 2)
  expect(sent[1]?.type).toBe("shipped")
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

// ── issue #49: delivery state, rendered by the real route ──────────────────
//
// Everything below drives `src/routes/outbox.ts`'s actual `emailPreview` /
// `deliveryDetail` / `deliveryError` functions through `GET /outbox`, not a
// fake `DB` — `test/notifications.test.ts` already covers `fromRow` and
// `listOutboxForCustomer` in isolation, but nothing before this drove the
// rendering code itself. `queued` is reachable through the ordinary bridge
// push a customer's own activity would cause; `sent` and `failed` are not
// reachable through this app's HTTP surface at all until #50's drain and
// #51's provider seam exist, so those two use `e2e/outbox-fixtures.ts` to
// move a row past `queued` the same way `e2e/r2-fixtures.ts` seeds R2 —
// shelling out to the CLI that owns the local persisted state `wrangler dev`
// is already serving.

test("a freshly decided send renders the queued delivery state, and none of the detail hooks", async ({
  page,
  request,
}) => {
  const email = uniqueEmail("e2e-delivery-queued")
  const target = await seedSubmission(page, email)

  expect((await push(request, target.reference, 1, { status: "shipped" })).outcome).toBe("applied")
  const [row] = await awaitOutbox(page, email, 1)

  expect(row.status, "the email-preview article carries data-status").toBe("queued")
  expect(row.deliveryPillText, 'the queued pill reads exactly "Queued"').toBe("Queued")
  expect(row.deliverySentAt, "a queued row has not been delivered").toBeNull()
  expect(row.deliveryAttempts, "a queued row shows no attempt count").toBeNull()
  expect(row.deliveryLastError, "a queued row shows no failure copy").toBeNull()
})

test("a delivered send renders the sent delivery state with a delivery time, and no other detail", async ({
  page,
  request,
}) => {
  const email = uniqueEmail("e2e-delivery-sent")
  const target = await seedSubmission(page, email)

  expect((await push(request, target.reference, 1, { status: "shipped" })).outcome).toBe("applied")
  await awaitOutbox(page, email, 1)

  const id = latestOutboxId(email)
  markOutboxSent(id, "2026-01-05T12:34:00Z", "provider-msg-e2e-sent")

  const [row] = await readOutbox(page, email)
  expect(row.status).toBe("sent")
  expect(row.deliveryPillText, 'the sent pill reads exactly "Sent"').toBe("Sent")
  expect(row.deliverySentAt, "a sent row must say something").not.toBeNull()
  expect((row.deliverySentAt as string).length).toBeGreaterThan(0)
  expect(row.deliveryAttempts, "delivery-attempts renders only on failed rows").toBeNull()
  expect(row.deliveryLastError, "delivery-last-error renders only on failed rows").toBeNull()
})

test("a failed send renders the failed state with an attempt count and customer-safe copy, never the raw error", async ({
  page,
  request,
}) => {
  const email = uniqueEmail("e2e-delivery-failed")
  const target = await seedSubmission(page, email)

  expect((await push(request, target.reference, 1, { status: "shipped" })).outcome).toBe("applied")
  await awaitOutbox(page, email, 1)

  const id = latestOutboxId(email)
  markOutboxFailed(id, 3, "Resend API returned 401")

  const [row] = await readOutbox(page, email)
  expect(row.status).toBe("failed")
  expect(row.deliveryPillText, 'the failed pill reads exactly "Delivery failed"').toBe("Delivery failed")
  expect(row.deliverySentAt, "delivery-sent-at renders only on sent rows").toBeNull()
  expect(row.deliveryAttempts, "a failed row explains how many attempts were made").toContain("3")
  expect(row.deliveryAttempts).toMatch(/\btimes\b/)
  expect(row.deliveryLastError, "a failed row must explain itself to the customer").not.toBeNull()
  // Customer-safe copy: never the raw operator string this row was seeded with.
  expect(row.deliveryLastError).not.toMatch(/resend/i)
  expect(row.deliveryLastError).not.toMatch(/\b401\b/)
  expect(row.deliveryLastError).not.toContain("Resend API returned 401")
})

test("a single failed attempt renders the singular 'time', not 'times'", async ({ page, request }) => {
  const email = uniqueEmail("e2e-delivery-failed-once")
  const target = await seedSubmission(page, email)

  expect((await push(request, target.reference, 1, { status: "shipped" })).outcome).toBe("applied")
  await awaitOutbox(page, email, 1)

  const id = latestOutboxId(email)
  markOutboxFailed(id, 1, "RESEND_API_KEY unset")

  const [row] = await readOutbox(page, email)
  expect(row.deliveryAttempts).toContain("1")
  expect(row.deliveryAttempts, "one attempt is singular").toMatch(/\btime\b/)
  expect(row.deliveryAttempts).not.toMatch(/times/)
})

