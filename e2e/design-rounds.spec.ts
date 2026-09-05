import { expect, test, type APIRequestContext, type Page } from "@playwright/test"

import { seedR2Object } from "./r2-fixtures"

/**
 * Black-box coverage for issue #13 ([portal] Design rounds + versioned sign-off
 * loop), driving the real Worker under `wrangler dev` with real local D1 — see
 * `playwright.config.ts`. This is the project's own `e2e/` tier, not the sealed
 * acceptance suite under `tests/acceptance/`; per CLAUDE.md this repo still
 * ships its own coverage for behaviour-changing work.
 *
 * SCOPE. The loop:
 *
 *   In design -> Awaiting sign-off -> (changes requested) -> In design -> ... -> Signed off
 *
 * A round's content is coord-owned and arrives over the bridge; the verdict is
 * portal-owned and leaves as a `signoff.approved` / `signoff.changes_requested`
 * event. Nothing on this side ever writes `submissions.status` — the return to
 * `In design` is derived (see `src/rounds.ts`), which is what the status
 * assertions below are really checking.
 *
 * Every string below is invented — see CLAUDE.md rule 1.
 */

const SERVICE_TOKEN = {
  "CF-Access-Client-Id": "b28f4c1e90a7d3652f8ba041cd97e236.access",
  "CF-Access-Client-Secret":
    "1f6ce3a90b4d752c81af06de394b27c5081fa6b3e29d47f0a2c6d8b91e457a3c",
}

/**
 * `serve:test` does not wipe `.wrangler/state` between runs (see the note in
 * `e2e/bridge.spec.ts`), so identities are tagged unique per run rather than
 * risking a row another run left behind.
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
  await page.getByTestId("field-outcome").fill("A synthetic outcome for e2e design-round coverage.")
  await page.getByTestId("field-audience").fill("synthetic e2e readers")
  await page.getByTestId("field-done-definition").fill("The design-round e2e suite goes green.")
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

interface RoundContent {
  outcome_definition: string
  decomposition: string[]
  mock_bundle?: string
}

/** Publishes a design round and asks for sign-off, in one push, as coord would. */
async function publishRound(
  request: APIRequestContext,
  reference: string,
  revision: number,
  round: RoundContent,
): Promise<void> {
  const result = await push(request, reference, revision, {
    design_round: round,
    status: "awaiting-signoff",
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

async function pullAll(
  request: APIRequestContext,
  cursor?: string,
): Promise<{ events: BridgeEvent[]; cursor: string }> {
  const events: BridgeEvent[] = []
  let next = cursor
  for (let attempt = 0; attempt < 50; attempt++) {
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

const ROUND_ONE: RoundContent = {
  outcome_definition: "Let a coordinator drop in a list of contacts and see them appear.",
  decomposition: ["An upload step with a preview", "Column mapping so headers need not match"],
  mock_bundle: "https://mocks.example.test/synthetic/round-1",
}

const ROUND_TWO: RoundContent = {
  outcome_definition:
    "Let a coordinator drop in a list of contacts and see them appear, with bad rows reported back.",
  decomposition: [
    "An upload step with a preview",
    "Column mapping so headers need not match",
    "A results screen listing exactly which rows failed and why",
  ],
  mock_bundle: "https://mocks.example.test/synthetic/round-2",
}

test("a published round renders the pinned awaiting-sign-off screen", async ({ page, request }) => {
  const seeded = await seedSubmission(page, uniqueEmail("e2e-round"))
  await publishRound(request, seeded.reference, 1, ROUND_ONE)
  await page.goto(seeded.url)

  await expect(page.getByTestId("submission-detail")).toHaveAttribute("data-status", "awaiting-signoff")
  await expect(page.getByTestId("status-pill")).toHaveText("Awaiting your sign-off")

  await expect(page.getByTestId("design-round")).toHaveAttribute("data-round", "1")
  await expect(page.getByTestId("design-round")).toHaveAttribute("data-verdict", "pending")
  await expect(page.getByTestId("round-number")).toHaveText("Round 1")
  await expect(page.getByTestId("outcome-definition")).toHaveText(ROUND_ONE.outcome_definition)
  await expect(page.getByTestId("decomposition-item")).toHaveCount(2)
  await expect(page.getByTestId("mock-bundle-link")).toHaveAttribute("href", ROUND_ONE.mock_bundle!)
  await expect(page.getByTestId("round-history-link")).toBeVisible()
  await expect(page.getByTestId("approve-button")).toBeVisible()
  await expect(page.getByTestId("request-changes-button")).toBeVisible()

  // #11's pause screen is a different surface and must not leak onto this one.
  await expect(page.getByTestId("pause-banner")).toHaveCount(0)
  await expect(page.getByTestId("answer-field")).toHaveCount(0)
})

test("a decomposition never shows an issue number, branch or agent identifier", async ({
  page,
  request,
}) => {
  const seeded = await seedSubmission(page, uniqueEmail("e2e-wall"))
  await publishRound(request, seeded.reference, 1, {
    outcome_definition: "Ship the importer, tracked in issue 412.",
    decomposition: [
      "An upload step with a preview (#412)",
      "Column mapping — see feat/csv-import",
      "Hand the final pass to agent-carla",
    ],
  })
  await page.goto(seeded.url)

  const rendered = await page.getByTestId("submission-detail").innerText()
  expect(rendered).not.toMatch(/#\d+/)
  expect(rendered).not.toMatch(/feat\//)
  expect(rendered).not.toMatch(/agent-/)
  expect(rendered).not.toMatch(/issue 412/i)
  // The work items themselves survive — the wall removes the identifier, not
  // the sentence around it.
  await expect(page.getByTestId("decomposition-item")).toHaveCount(3)
  await expect(page.getByTestId("decomposition-item").first()).toContainText(
    "An upload step with a preview",
  )
})

test("the request-changes composer opens and cancels without leaving the page", async ({
  page,
  request,
}) => {
  const seeded = await seedSubmission(page, uniqueEmail("e2e-composer"))
  await publishRound(request, seeded.reference, 1, ROUND_ONE)
  await page.goto(seeded.url)

  await expect(page.getByTestId("request-changes-form")).toBeHidden()

  await page.getByTestId("request-changes-button").click()
  await expect(page.getByTestId("request-changes-form")).toBeVisible()
  await expect(page.getByTestId("changes-comment")).toBeVisible()
  await expect(page.getByTestId("next-round-note")).toContainText("Round 2")
  // Same URL — the contract is explicit that the composer is not a distinct route.
  await expect(page).toHaveURL(seeded.url)

  await page.getByTestId("cancel-changes").click()
  await expect(page.getByTestId("request-changes-form")).toBeHidden()
  await expect(page.getByTestId("design-round")).toHaveAttribute("data-verdict", "pending")
})

/**
 * The composer toggle is a real checkbox precisely so a keyboard-only user (no
 * mouse, no screen reader) can open and close it with nothing but Tab and
 * Space — a `<label role="button" tabindex="0">` alone does not get that for
 * free (see the doc comment on `awaitingSignoffDetail` in
 * `src/routes/submission.ts`). This drives it the way that user actually
 * would: focus the control, press Space, never click anything.
 */
test("the request-changes composer opens and closes with only Tab and Space", async ({
  page,
  request,
}) => {
  const seeded = await seedSubmission(page, uniqueEmail("e2e-keyboard"))
  await publishRound(request, seeded.reference, 1, ROUND_ONE)
  await page.goto(seeded.url)

  const toggle = page.locator("#request-changes-toggle")
  await expect(page.getByTestId("request-changes-form")).toBeHidden()

  await toggle.focus()
  await page.keyboard.press("Space")
  await expect(page.getByTestId("request-changes-form")).toBeVisible()

  await page.keyboard.press("Space")
  await expect(page.getByTestId("request-changes-form")).toBeHidden()
})

test("requesting changes opens round N+1 and never mutates round N", async ({ page, request }) => {
  const seeded = await seedSubmission(page, uniqueEmail("e2e-loop"))
  const before = await pullAll(request)
  await publishRound(request, seeded.reference, 1, ROUND_ONE)
  await page.goto(seeded.url)

  await page.getByTestId("request-changes-button").click()
  await page
    .getByTestId("changes-comment")
    .fill("Tell me which rows failed — silently dropping them is worse than not having it.")
  await page.getByTestId("submit-changes").click()

  // Back to In design. The stored status is still coord's `awaiting-signoff` —
  // the portal owns no part of that column — but there is nothing left awaiting
  // this customer, so that is what the screen says.
  await expect(page).toHaveURL(seeded.url)
  await expect(page.getByTestId("submission-detail")).toHaveAttribute("data-status", "in-design")
  await expect(page.getByTestId("status-pill")).toHaveText("In design")
  await expect(page.getByTestId("approve-button")).toHaveCount(0)
  await expect(page.getByTestId("request-changes-button")).toHaveCount(0)

  // The verdict reached the coordinator, exactly once, replayably.
  const after = await pullAll(request, before.cursor)
  const decided = after.events.filter(
    (event) => event.submission_id === seeded.reference && event.type === "signoff.changes_requested",
  )
  expect(decided).toHaveLength(1)
  expect(decided[0]?.payload["round"]).toBe(1)
  const replay = await pullAll(request, before.cursor)
  expect(
    replay.events.filter(
      (event) =>
        event.submission_id === seeded.reference && event.type === "signoff.changes_requested",
    )[0]?.id,
  ).toBe(decided[0]?.id)

  // Coord answers with the next round. It is round 2 — round 1 keeps its own
  // content and its own verdict.
  await publishRound(request, seeded.reference, 2, ROUND_TWO)
  await page.goto(seeded.url)
  await expect(page.getByTestId("design-round")).toHaveAttribute("data-round", "2")
  await expect(page.getByTestId("outcome-definition")).toHaveText(ROUND_TWO.outcome_definition)
  await expect(page.getByTestId("decomposition-item")).toHaveCount(3)

  await page.goto(`/submissions/${seeded.id}/rounds`)
  await expect(page.getByTestId("round-entry")).toHaveCount(2)
  const first = page.getByTestId("round-entry").first()
  await expect(first).toHaveAttribute("data-round", "2")
  await expect(first).toHaveAttribute("data-verdict", "pending")
  const second = page.getByTestId("round-entry").nth(1)
  await expect(second).toHaveAttribute("data-round", "1")
  await expect(second).toHaveAttribute("data-verdict", "changes-requested")
  await expect(second).toContainText(ROUND_ONE.outcome_definition)
  await expect(second.getByTestId("round-comment")).toHaveText(
    "Tell me which rows failed — silently dropping them is worse than not having it.",
  )
  await expect(page.getByTestId("verdict-pill").nth(1)).toHaveText("Changes requested")
  await expect(page.getByTestId("back-to-submission")).toBeVisible()
})

test("a blank comment does not burn a round", async ({ page, request }) => {
  const seeded = await seedSubmission(page, uniqueEmail("e2e-blank"))
  await publishRound(request, seeded.reference, 1, ROUND_ONE)
  await page.goto(seeded.url)

  await page.getByTestId("request-changes-button").click()
  // A real browser honours `required` and refuses to submit at all — a
  // legitimate first line of defence that proves nothing about the server.
  await page.getByTestId("changes-comment").evaluate((el) => el.removeAttribute("required"))
  await page.getByTestId("submit-changes").click()

  // Still awaiting sign-off, still round 1, composer still open and reachable.
  await expect(page.getByTestId("submission-detail")).toHaveAttribute("data-status", "awaiting-signoff")
  await expect(page.getByTestId("design-round")).toHaveAttribute("data-round", "1")
  await expect(page.getByTestId("request-changes-form")).toBeVisible()
  await expect(page.getByTestId("changes-comment")).toBeVisible()

  await page.goto(`/submissions/${seeded.id}/rounds`)
  await expect(page.getByTestId("round-entry")).toHaveCount(1)
  await expect(page.getByTestId("round-entry").first()).toHaveAttribute("data-verdict", "pending")
})

test("approve is the only action that moves a submission past sign-off", async ({
  page,
  request,
}) => {
  const seeded = await seedSubmission(page, uniqueEmail("e2e-approve"))
  const before = await pullAll(request)
  await publishRound(request, seeded.reference, 1, ROUND_ONE)
  await page.goto(seeded.url)

  await page.getByTestId("approve-button").click()

  await expect(page).toHaveURL(seeded.url)
  await expect(page.getByTestId("submission-detail")).toHaveAttribute("data-status", "planned")
  await expect(page.getByTestId("status-pill")).toHaveText("Planned")
  await expect(page.getByTestId("approve-button")).toHaveCount(0)
  await expect(page.getByTestId("request-changes-button")).toHaveCount(0)

  const after = await pullAll(request, before.cursor)
  const approved = after.events.filter(
    (event) => event.submission_id === seeded.reference && event.type === "signoff.approved",
  )
  expect(approved).toHaveLength(1)
  expect(approved[0]?.payload["verdict"]).toBe("approved")

  // The approved round stays readable, with its verdict, forever.
  await page.goto(`/submissions/${seeded.id}/rounds`)
  await expect(page.getByTestId("round-entry").first()).toHaveAttribute("data-verdict", "approved")
  await expect(page.getByTestId("verdict-pill").first()).toHaveText("Approved")
  await expect(page.getByTestId("round-comment")).toHaveCount(0)
})

test("awaiting sign-off with no round published offers no sign-off affordance", async ({
  page,
  request,
}) => {
  const seeded = await seedSubmission(page, uniqueEmail("e2e-noround"))
  const result = await push(request, seeded.reference, 1, { status: "awaiting-signoff" })
  expect(result.outcome).toBe("applied")
  await page.goto(seeded.url)

  await expect(page.getByTestId("status-pill")).toHaveAttribute("data-status", "awaiting-signoff")
  await expect(page.getByTestId("design-round")).toHaveCount(0)
  await expect(page.getByTestId("approve-button")).toHaveCount(0)
  await expect(page.getByTestId("request-changes-button")).toHaveCount(0)
})

test("coord may never write the customer's verdict", async ({ page, request }) => {
  const seeded = await seedSubmission(page, uniqueEmail("e2e-owned"))
  await publishRound(request, seeded.reference, 1, ROUND_ONE)

  for (const field of ["signoff_verdict", "signoff_comment"]) {
    const res = await request.post("/api/bridge/push", {
      data: {
        updates: [{ submission_id: seeded.reference, revision: 2, fields: { [field]: "approved" } }],
      },
      headers: SERVICE_TOKEN,
    })
    expect(res.status()).toBe(200)
    const body = (await res.json()) as { results: Array<{ outcome: string; reason?: string }> }
    expect(body.results[0]?.outcome).toBe("rejected")
    expect(body.results[0]?.reason).toBe(`not_owned:${field}`)
  }

  // The round is still pending — the rejected writes changed nothing.
  await page.goto(seeded.url)
  await expect(page.getByTestId("design-round")).toHaveAttribute("data-verdict", "pending")
  await expect(page.getByTestId("approve-button")).toBeVisible()
})

test("the dashboard row follows the same derived status as the detail screen", async ({
  page,
  request,
}) => {
  const seeded = await seedSubmission(page, uniqueEmail("e2e-dash"))
  await publishRound(request, seeded.reference, 1, ROUND_ONE)

  await page.goto("/submissions")
  await expect(page.getByTestId("submission-row")).toHaveAttribute("data-status", "awaiting-signoff")

  await page.goto(seeded.url)
  await page.getByTestId("request-changes-button").click()
  await page.getByTestId("changes-comment").fill("Please cover the failure reporting too.")
  await page.getByTestId("submit-changes").click()
  await expect(page.getByTestId("status-pill")).toHaveText("In design")

  await page.goto("/submissions")
  await expect(page.getByTestId("submission-row")).toHaveAttribute("data-status", "in-design")
  await expect(page.getByTestId("status-pill")).toHaveText("In design")
})

/**
 * `roundStatementsForPush` (`src/rounds.ts`): a stale, out-of-order coord push
 * that explicitly names an already-decided round while a *newer* round is
 * still open and pending must land on that newer round rather than opening
 * yet another one on top of it — the latter would silently orphan the round
 * the customer is actually looking at, forever unreachable via
 * `getCurrentRound`. Only the implicit "coord names no round" path was
 * exercised before this test; this covers the explicit, out-of-order one.
 */
test("a push naming an already-decided round redirects to the newer pending round instead of orphaning it", async ({
  page,
  request,
}) => {
  const seeded = await seedSubmission(page, uniqueEmail("e2e-stale-round"))
  await publishRound(request, seeded.reference, 1, ROUND_ONE)
  await page.goto(seeded.url)
  await page.getByTestId("approve-button").click()
  await expect(page.getByTestId("submission-detail")).toHaveAttribute("data-status", "planned")

  // Coord's next push names no round — this opens round 2, still pending.
  await publishRound(request, seeded.reference, 2, ROUND_TWO)

  // A stale push, naming round 1 (already decided) explicitly, as if coord's
  // own state had not yet caught up with the approval.
  const stale = await push(request, seeded.reference, 3, {
    design_round: {
      round: 1,
      outcome_definition: "A stale revision of round 1, pushed after it was approved.",
      decomposition: ["Whatever round 1 used to say"],
    },
    status: "awaiting-signoff",
  })
  expect(stale.outcome).toBe("applied")

  await page.goto(`/submissions/${seeded.id}/rounds`)
  // Still exactly two rounds — the stale push landed on round 2, not a new
  // round 3, and round 2 is still there to receive a real verdict later.
  await expect(page.getByTestId("round-entry")).toHaveCount(2)
  const newest = page.getByTestId("round-entry").first()
  await expect(newest).toHaveAttribute("data-round", "2")
  await expect(newest).toHaveAttribute("data-verdict", "pending")
  await expect(newest).toContainText("A stale revision of round 1, pushed after it was approved.")
  const oldest = page.getByTestId("round-entry").nth(1)
  await expect(oldest).toHaveAttribute("data-round", "1")
  await expect(oldest).toHaveAttribute("data-verdict", "approved")
})

/**
 * `routes/mocks.ts`'s `mockBundle` — the R2-backed route the earlier tests
 * above never touch, because every `mock_bundle` they push is an absolute
 * external URL and `mockBundleHref` links straight to those without going near
 * this route. Here `mock_bundle` is a bare R2 key instead, which is what
 * routes it through `/submissions/:id/rounds/:n/mock` for real: the ownership
 * gate, `resolveBundleKey` wired to an actual request, the R2 `.get()`, and
 * the CSP / nosniff / cache-control headers the route's own doc comment
 * promises. `e2e/r2-fixtures.ts` seeds the objects via the same
 * `wrangler r2 object put --local` CLI that populates the real bucket,
 * against the same local R2 `wrangler dev` is already serving (see
 * `playwright.config.ts`).
 */
test.describe("the mock bundle route (routes/mocks.ts)", () => {
  test("serves a real R2 object, resolves a sibling asset beside it, and carries the pinned security headers", async ({
    page,
    request,
  }) => {
    const email = uniqueEmail("e2e-mock")
    const seeded = await seedSubmission(page, email)
    const indexKey = `rounds/${seeded.reference}/1/index.html`
    const cssKey = `rounds/${seeded.reference}/1/tokens.css`
    seedR2Object(
      indexKey,
      "<!doctype html><title>synthetic mock</title><p>hello from the mock bundle</p>",
      "text/html; charset=utf-8",
    )
    seedR2Object(cssKey, "body { color: red }", "text/css; charset=utf-8")
    await publishRound(request, seeded.reference, 1, { ...ROUND_ONE, mock_bundle: indexKey })

    const identity = { "Cf-Access-Authenticated-User-Email": email }
    const bundlePath = `/submissions/${seeded.id}/rounds/1/mock`

    const doc = await request.get(bundlePath, { headers: identity })
    expect(doc.status()).toBe(200)
    expect(doc.headers()["content-type"]).toBe("text/html; charset=utf-8")
    expect(doc.headers()["x-content-type-options"]).toBe("nosniff")
    expect(doc.headers()["content-security-policy"]).toBe(
      "default-src 'self'; script-src 'none'; style-src 'self' 'unsafe-inline'; frame-ancestors 'self'",
    )
    // Customer material behind Access — never a shared cache.
    expect(doc.headers()["cache-control"]).toBe("private, no-store")
    expect(await doc.text()).toContain("hello from the mock bundle")

    // A self-contained page's own stylesheet link resolves beside it — the
    // "single-document bundle" shape `resolveBundleKey`'s doc comment describes.
    const css = await request.get(`${bundlePath}/tokens.css`, { headers: identity })
    expect(css.status()).toBe(200)
    expect(css.headers()["content-type"]).toBe("text/css; charset=utf-8")
    expect(await css.text()).toBe("body { color: red }")
  })

  /**
   * Issue #314: the CSP had no `style-src`, so it fell back to `default-src
   * 'self'` — which does not permit an inline `<style>` block. The header
   * assertion above pins the string but would not have caught that: it never
   * loads the bundle in a real browser and checks whether the stylesheet the
   * bundle ships inline (the only mechanism available — R2 holds one object
   * per round, so there is no external stylesheet to fall back to) actually
   * took effect. This test drives the real Worker with a real page load so
   * the browser's own CSP enforcement is what's being exercised, not a
   * re-implementation of it.
   */
  test("the bundle's own inline stylesheet is actually applied, not merely present in the DOM", async ({
    page,
    request,
  }) => {
    const email = uniqueEmail("e2e-mock-styled")
    const seeded = await seedSubmission(page, email)
    const indexKey = `rounds/${seeded.reference}/1/index.html`
    seedR2Object(
      indexKey,
      `<!doctype html>
<html>
<head><style>body { background-color: rgb(12, 34, 56); }</style></head>
<body><p>styled synthetic mock</p></body>
</html>`,
      "text/html; charset=utf-8",
    )
    await publishRound(request, seeded.reference, 1, { ...ROUND_ONE, mock_bundle: indexKey })

    await page.goto(`/submissions/${seeded.id}/rounds/1/mock`)

    // The `<style>` element being in the DOM proves nothing on its own — a
    // blocking CSP still leaves it there while refusing to apply it. What
    // matters is whether the browser actually adopted the sheet.
    expect(await page.evaluate(() => document.styleSheets.length)).toBeGreaterThan(0)
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    expect(background).toBe("rgb(12, 34, 56)")
  })

  test("a stranger, a missing round, and a signed-out caller all get the exact same 404 a real bundle would give a non-owner", async ({
    page,
    request,
  }) => {
    const ownerEmail = uniqueEmail("e2e-mock-owner")
    const seeded = await seedSubmission(page, ownerEmail)
    const indexKey = `rounds/${seeded.reference}/1/index.html`
    seedR2Object(indexKey, "<!doctype html><p>owner-only content</p>", "text/html; charset=utf-8")
    await publishRound(request, seeded.reference, 1, { ...ROUND_ONE, mock_bundle: indexKey })

    const bundlePath = `/submissions/${seeded.id}/rounds/1/mock`
    const strangerEmail = uniqueEmail("e2e-mock-stranger")

    // A stranger who guesses the URL — the bundle exists, but not for them.
    const stranger = await request.get(bundlePath, {
      headers: { "Cf-Access-Authenticated-User-Email": strangerEmail },
    })
    // The owner, but a round number nothing was ever published under.
    const missingRound = await request.get(`/submissions/${seeded.id}/rounds/99/mock`, {
      headers: { "Cf-Access-Authenticated-User-Email": ownerEmail },
    })
    // No identity at all.
    const signedOut = await request.get(bundlePath)

    for (const res of [stranger, missingRound, signedOut]) expect(res.status()).toBe(404)

    // Byte-identical, per the route's own comment: "a 404 that only fires for
    // someone else's bundle would itself confirm it exists."
    const bodies = await Promise.all([stranger.text(), missingRound.text(), signedOut.text()])
    expect(new Set(bodies).size).toBe(1)
    for (const body of bodies) expect(body).not.toContain("owner-only content")
  })

  test("refuses to serve a mock_bundle that tries to climb out of its own subtree, even once the push has landed", async ({
    page,
    request,
  }) => {
    const email = uniqueEmail("e2e-mock-traversal")
    const seeded = await seedSubmission(page, email)

    // `asBundle` does not validate the shape — only `resolveBundleKey`, inside
    // the route, does. This proves the route itself is the backstop, not just
    // the unit test against the pure function in `test/rounds.test.ts`.
    const result = await push(request, seeded.reference, 1, {
      design_round: {
        round: 1,
        outcome_definition: "A synthetic outcome.",
        decomposition: ["A single work item"],
        mock_bundle: "../outside/secret.html",
      },
      status: "awaiting-signoff",
    })
    expect(result.outcome).toBe("applied")

    const res = await request.get(`/submissions/${seeded.id}/rounds/1/mock`, {
      headers: { "Cf-Access-Authenticated-User-Email": email },
    })
    expect(res.status()).toBe(404)
  })

  test("an unknown file extension inside a bundle is served as a download, never guessed as HTML", async ({
    page,
    request,
  }) => {
    const email = uniqueEmail("e2e-mock-contenttype")
    const seeded = await seedSubmission(page, email)
    const bundlePrefix = `rounds/${seeded.reference}/1`
    seedR2Object(`${bundlePrefix}/index.html`, "<!doctype html><p>index</p>", "text/html; charset=utf-8")
    seedR2Object(`${bundlePrefix}/data.bin`, "not markup, just bytes", "application/octet-stream")
    await publishRound(request, seeded.reference, 1, { ...ROUND_ONE, mock_bundle: bundlePrefix })

    const res = await request.get(`/submissions/${seeded.id}/rounds/1/mock/data.bin`, {
      headers: { "Cf-Access-Authenticated-User-Email": email },
    })
    expect(res.status()).toBe(200)
    expect(res.headers()["content-type"]).toBe("application/octet-stream")
  })
})
