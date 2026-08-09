import { expect, test, type APIRequestContext, type Page } from "@playwright/test"

/**
 * Black-box coverage for issue #15 (the sync bridge), driving the real Worker
 * under `wrangler dev` with real local D1 — see `playwright.config.ts`. This is
 * the project's own `e2e/` tier, not the sealed acceptance suite under
 * `tests/acceptance/`.
 *
 * The bridge has no screen; it is driven through `APIRequestContext`. The
 * browser appears only to author the one customer fact this milestone can
 * produce (a submission, via #9's intake form) and to read a coord-owned
 * `status` write back off the customer's own page — which is the only honest
 * proof that a push landed somewhere a customer can see.
 *
 * WRITTEN FOR A SHARED, CONCURRENT DATABASE. `playwright.config.ts` runs
 * `fullyParallel` across two projects against one `wrangler dev`, and
 * `serve:test` does not wipe state between runs. So nothing below asserts on
 * the *global* contents of the stream: every assertion is scoped to a cursor
 * this test took and a reference this test created. The sealed suite runs
 * single-worker against a wiped database and can be stricter.
 *
 * Every string below is invented — see CLAUDE.md rule 1.
 */

const SERVICE_TOKEN = {
  "CF-Access-Client-Id": "b7c41e9028fa4d6ea15c39f8027bd461.access",
  "CF-Access-Client-Secret":
    "5c8e1a37d024b96f81e7350ac6d24f9b1e0a7d63c85f492a70b3e18d5c6a29f4",
}

const CUSTOMER = { "Cf-Access-Authenticated-User-Email": "e2e-bridge@example.test" }

interface BridgeEvent {
  id: string
  revision: number
  type: string
  submission_id: string
  occurred_at: string
  payload: Record<string, unknown>
}

interface PullPage {
  events: BridgeEvent[]
  cursor: string
  has_more: boolean
}

interface PushResult {
  submission_id: string
  outcome: string
  reason?: string
}

async function pull(
  request: APIRequestContext,
  opts: { cursor?: string; limit?: number } = {},
): Promise<PullPage> {
  const params: Record<string, string> = {}
  if (opts.cursor) params["cursor"] = opts.cursor
  if (opts.limit) params["limit"] = String(opts.limit)

  const res = await request.get("/api/bridge/pull", { params, headers: SERVICE_TOKEN })
  expect(res.status()).toBe(200)
  return (await res.json()) as PullPage
}

/** Reads to the end of the stream and returns the cursor that sits past it. */
async function drain(request: APIRequestContext): Promise<string> {
  let cursor: string | undefined
  for (let page = 0; page < 50; page++) {
    const body: PullPage = await pull(request, { cursor, limit: 200 })
    cursor = body.cursor
    if (!body.has_more) return body.cursor
  }
  throw new Error("the stream never drained — the cursor is not advancing")
}

/** Everything on the stream after `cursor`, following `has_more` to the end. */
async function collectFrom(
  request: APIRequestContext,
  cursor: string,
): Promise<BridgeEvent[]> {
  const events: BridgeEvent[] = []
  let next = cursor
  for (let page = 0; page < 50; page++) {
    const body: PullPage = await pull(request, { cursor: next, limit: 200 })
    events.push(...body.events)
    next = body.cursor
    if (!body.has_more) return events
  }
  throw new Error("the stream never drained — the cursor is not advancing")
}

async function push(
  request: APIRequestContext,
  updates: Array<{ submission_id: string; revision: number; fields: Record<string, unknown> }>,
): Promise<PushResult[]> {
  const res = await request.post("/api/bridge/push", {
    data: { updates },
    headers: SERVICE_TOKEN,
  })
  // A rejection is a per-item outcome inside a 200, never a transport failure.
  expect(res.status()).toBe(200)
  const body = (await res.json()) as { results: PushResult[] }
  expect(body.results).toHaveLength(updates.length)
  return body.results
}

async function seedSubmission(page: Page): Promise<{ url: string; reference: string }> {
  await page.setExtraHTTPHeaders(CUSTOMER)
  await page.goto("/intake")
  await page.getByTestId("field-outcome").fill("A synthetic outcome for bridge coverage.")
  await page.getByTestId("field-audience").fill("the synthetic e2e reader")
  await page.getByTestId("field-done-definition").fill("The bridge spec goes green.")
  await page.getByTestId("submit-intake").click()
  await expect(page.getByTestId("intake-receipt")).toBeVisible()

  const shown = (await page.getByTestId("submission-reference").innerText()).trim()
  const reference = shown.replace(/^Reference\s+/, "")
  expect(reference).toMatch(/^SUB-[A-Z0-9]{6}$/)
  return { url: page.url(), reference }
}

async function readStatus(page: Page, url: string): Promise<string | null> {
  await page.setExtraHTTPHeaders(CUSTOMER)
  await page.goto(url)
  return page.getByTestId("status-pill").getAttribute("data-status")
}

test("every bridge route refuses a caller without a service token", async ({ request }) => {
  const attempts = [
    () => request.get("/api/bridge/pull", { headers: {} }),
    () => request.post("/api/bridge/push", { data: { updates: [] }, headers: {} }),
    () =>
      request.post("/api/bridge/heartbeat", {
        data: { at: "2026-08-09T09:00:00Z" },
        headers: {},
      }),
    // Half a credential is not a credential.
    () =>
      request.get("/api/bridge/pull", {
        headers: { "CF-Access-Client-Id": SERVICE_TOKEN["CF-Access-Client-Id"] },
      }),
    // A signed-in human is not the daemon: /api/bridge is not a general bypass.
    () => request.get("/api/bridge/pull", { headers: CUSTOMER }),
  ]

  const bodies: string[] = []
  for (const attempt of attempts) {
    const res = await attempt()
    expect(res.status()).toBe(401)
    bodies.push(await res.text())
  }

  // No detail about what was wrong — the failures are indistinguishable.
  expect(new Set(bodies).size).toBe(1)
})

test("a new submission reaches the stream once, and replays from the same cursor", async ({
  page,
  request,
}) => {
  const start = await drain(request)
  const seeded = await seedSubmission(page)

  const mine = (await collectFrom(request, start)).filter(
    (event) => event.submission_id === seeded.reference,
  )
  expect(mine).toHaveLength(1)

  const event = mine[0]
  expect(event.id).toMatch(/^evt_[0-9a-f]+$/)
  expect(Number.isInteger(event.revision)).toBe(true)
  expect(event.type).toBe("submission.created")
  expect(event.occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/)
  expect(event.payload["reference"]).toBe(seeded.reference)
  expect(event.payload["outcome"]).toBe("A synthetic outcome for bridge coverage.")
  // The customer's email is a portal-side fact and does not cross the bridge.
  expect(JSON.stringify(event.payload)).not.toContain("@example.test")

  // Replay-safety: the same cursor, pulled again, returns the same events in
  // the same order.
  //
  // Asserted as a *prefix*, not as equality, and the returned cursor is not
  // compared at all: this file runs fully parallel against a shared stream, so
  // a sibling test can legitimately append between the two pulls. Prefix
  // stability is the invariant that survives that, and it is the one the daemon
  // actually depends on — everything it already consumed stays put.
  const once = await pull(request, { cursor: start, limit: 200 })
  const twice = await pull(request, { cursor: start, limit: 200 })
  expect(twice.events.length).toBeGreaterThanOrEqual(once.events.length)
  expect(twice.events.slice(0, once.events.length)).toEqual(once.events)

  // A drained cursor yields nothing rather than starting over.
  const drained = await pull(request, { cursor: await drain(request), limit: 200 })
  expect(drained.events.filter((e) => e.submission_id === seeded.reference)).toEqual([])
})

test("limit pages the stream in revision order without losing an event", async ({
  page,
  request,
}) => {
  const start = await drain(request)
  const first = await seedSubmission(page)
  const second = await seedSubmission(page)

  const collected: BridgeEvent[] = []
  let cursor = start
  for (let i = 0; i < 20; i++) {
    const body = await pull(request, { cursor, limit: 1 })
    expect(body.events.length).toBeLessThanOrEqual(1)
    collected.push(...body.events)
    cursor = body.cursor
    if (collected.some((e) => e.submission_id === second.reference)) break
  }

  const references = collected.map((e) => e.submission_id)
  expect(references).toContain(first.reference)
  expect(references.indexOf(first.reference)).toBeLessThan(
    references.indexOf(second.reference),
  )

  const revisions = collected.map((e) => e.revision)
  for (let i = 1; i < revisions.length; i++) {
    expect(revisions[i]).toBeGreaterThan(revisions[i - 1])
  }
})

test("a bogus cursor is refused rather than silently replaying all of history", async ({
  request,
}) => {
  const res = await request.get("/api/bridge/pull", {
    params: { cursor: "not-a-cursor-this-portal-issued" },
    headers: SERVICE_TOKEN,
  })
  expect(res.status()).toBe(400)
  expect(await res.json()).toMatchObject({ error: "invalid_cursor" })
})

test("the same push twice is applied then already_applied, with one stored change", async ({
  page,
  request,
}) => {
  const target = await seedSubmission(page)
  expect(await readStatus(page, target.url)).toBe("describing")

  const update = {
    submission_id: target.reference,
    revision: 12,
    fields: { status: "in-progress" },
  }

  expect((await push(request, [update]))[0]).toMatchObject({
    submission_id: target.reference,
    outcome: "applied",
  })
  expect(await readStatus(page, target.url)).toBe("in-progress")

  // "Assume every request arrives twice."
  expect((await push(request, [update]))[0]?.outcome).toBe("already_applied")
  expect(await readStatus(page, target.url)).toBe("in-progress")

  // A stale redelivery must not roll the record backwards either.
  expect(
    (
      await push(request, [
        { submission_id: target.reference, revision: 3, fields: { status: "describing" } },
      ])
    )[0]?.outcome,
  ).toBe("already_applied")
  expect(await readStatus(page, target.url)).toBe("in-progress")

  // A genuinely newer revision still moves.
  expect(
    (
      await push(request, [
        { submission_id: target.reference, revision: 13, fields: { status: "shipped" } },
      ])
    )[0]?.outcome,
  ).toBe("applied")
  expect(await readStatus(page, target.url)).toBe("shipped")
})

test("an update touching a portal-owned field is rejected whole and leaves no watermark", async ({
  page,
  request,
}) => {
  const target = await seedSubmission(page)

  const [rejected] = await push(request, [
    {
      submission_id: target.reference,
      revision: 30,
      // A valid coord-owned sibling must not smuggle the unauthorised field in.
      fields: { status: "planned", outcome: "written by the wrong side" },
    },
  ])
  expect(rejected).toMatchObject({ outcome: "rejected", reason: "not_owned:outcome" })
  expect(await readStatus(page, target.url)).toBe("describing")

  // The rejection recorded nothing, so the corrected retry at the same revision
  // is still fresh rather than being swallowed as already-applied.
  const [retried] = await push(request, [
    { submission_id: target.reference, revision: 30, fields: { status: "planned" } },
  ])
  expect(retried?.outcome).toBe("applied")
  expect(await readStatus(page, target.url)).toBe("planned")
})

test("a batch answers one result per update, in order, without poisoning siblings", async ({
  page,
  request,
}) => {
  const a = await seedSubmission(page)
  const b = await seedSubmission(page)

  const results = await push(request, [
    { submission_id: a.reference, revision: 61, fields: { status: "in-progress" } },
    {
      submission_id: b.reference,
      revision: 61,
      fields: { status: "planned", answer: "written by the wrong side" },
    },
    { submission_id: "SUB-000000", revision: 61, fields: { status: "planned" } },
  ])

  expect(results.map((r) => r.submission_id)).toEqual([
    a.reference,
    b.reference,
    "SUB-000000",
  ])
  expect(results.map((r) => r.outcome)).toEqual(["applied", "rejected", "rejected"])
  expect(results[1]?.reason).toBe("not_owned:answer")
  // An unknown submission is a per-item outcome too, not a 404 for the batch.
  expect(results[2]?.reason).toBe("unknown_submission")

  expect(await readStatus(page, a.url)).toBe("in-progress")
  expect(await readStatus(page, b.url)).toBe("describing")
})

test("a status outside the customer vocabulary is refused, not rendered", async ({
  page,
  request,
}) => {
  const target = await seedSubmission(page)

  const [result] = await push(request, [
    { submission_id: target.reference, revision: 80, fields: { status: "yak-shaving" } },
  ])
  expect(result).toMatchObject({ outcome: "rejected", reason: "invalid_value:status" })
  expect(await readStatus(page, target.url)).toBe("describing")
})

test("a coord-owned write produces no event — the two sides do not echo", async ({
  page,
  request,
}) => {
  const target = await seedSubmission(page)
  const afterSeed = await drain(request)

  expect(
    (
      await push(request, [
        { submission_id: target.reference, revision: 70, fields: { status: "quality-check" } },
      ])
    )[0]?.outcome,
  ).toBe("applied")
  expect(await readStatus(page, target.url)).toBe("quality-check")

  const events = await collectFrom(request, afterSeed)
  expect(events.filter((e) => e.submission_id === target.reference)).toEqual([])
})

test("a heartbeat is accepted, repeatable, and refuses a non-timestamp", async ({
  request,
}) => {
  for (const at of ["2026-08-09T09:00:00Z", "2026-08-09T09:00:30Z"]) {
    const res = await request.post("/api/bridge/heartbeat", {
      data: { at },
      headers: SERVICE_TOKEN,
    })
    expect(res.status()).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  }

  const bad = await request.post("/api/bridge/heartbeat", {
    data: { at: "some time yesterday" },
    headers: SERVICE_TOKEN,
  })
  expect(bad.status()).toBe(400)
})

test("an oversized batch is refused out loud, not silently truncated", async ({
  request,
}) => {
  const updates = Array.from({ length: 51 }, (_, i) => ({
    submission_id: "SUB-000000",
    revision: i + 1,
    fields: { status: "planned" },
  }))

  const res = await request.post("/api/bridge/push", {
    data: { updates },
    headers: SERVICE_TOKEN,
  })
  expect(res.status()).toBe(400)
  // The limit is in the answer, so the daemon can page instead of guessing.
  expect(await res.json()).toMatchObject({ error: "too_many_updates", limit: 50 })
})

test("the bridge exposes no inbound registration path", async ({ request }) => {
  // CLAUDE.md rule 2: nothing here lets the daemon hand this side an address to
  // call — not even behind a valid service token.
  for (const path of [
    "/api/bridge/subscribe",
    "/api/bridge/webhook",
    "/api/bridge/register",
    "/api/bridge/callback",
    "/api/bridge/notify",
  ]) {
    const res = await request.post(path, {
      data: { url: "https://callback.example.test/hook" },
      headers: SERVICE_TOKEN,
    })
    expect(res.status(), path).toBe(404)
  }
})
