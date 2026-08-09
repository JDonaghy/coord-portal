import { expect, test, type APIRequestContext, type Page } from "@playwright/test"

/**
 * ms-1 sealed acceptance slice — issue #15
 * "[portal] Sync bridge — the portal-side API the daemon polls"
 *
 * Written from `tests/acceptance/ms-1/contract.md` (§ "Sync bridge (issue #15)
 * — pinned wire contract") without sight of any implementation.
 *
 * SCOPE. Three routes under `/api/bridge` — `GET /pull`, `POST /push`,
 * `POST /heartbeat` — plus the service-token auth in front of them and the
 * sole-writer ownership table they enforce. Per the contract's "Traps for the
 * test-author": this surface has **no customer-visible screen**, no mock
 * renders it, and it is driven here through Playwright's `APIRequestContext`
 * rather than a page.
 *
 * The browser IS used, but only as a *seed and read-back* mechanism, never as
 * the subject: the only customer-authored fact this milestone can produce
 * black-box is a submission (issue #9's pinned intake form), and the only
 * black-box read-back of a coord-owned `status` write is the `status-pill` on
 * `/submissions/:id`. Contract note 3 leaves every portal-internal JSON shape
 * unpinned, so the DOM is the only honest observation point.
 *
 * NOT COVERED HERE, deliberately:
 *  - `signoff.approved` / `signoff.changes_requested` / `question.answered`
 *    events. Those facts are authored on the #13 and #11 screens, which this
 *    slice must not assume exist. The event *type vocabulary* is asserted as a
 *    closed set instead, which is the part #15 owns.
 *  - The "daemon looks stale past a threshold" rendering. The contract pins no
 *    route, `data-testid` or threshold for it — see the TODO on the heartbeat
 *    test.
 *
 * SYNTHETIC DATA. Per CLAUDE.md rule 1 and the contract's "Synthetic data"
 * section, every string below is invented.
 */

const CUSTOMER_EMAIL = "grace@example.test"

/**
 * The daemon's service-token credential.
 *
 * TODO(test-author): the contract pins the two *header names* and pins that
 * missing-or-invalid ⇒ 401, but it does not pin how a Worker running without
 * Cloudflare Access in front of it (which is exactly what
 * `npm run serve:acceptance` boots) learns which credential pair is valid. In
 * production the Service Auth application validates the token before the
 * request reaches the Worker; locally there is nothing to validate against.
 *
 * This suite therefore takes the same position `src/identity.ts` already takes
 * for `Cf-Access-Authenticated-User-Email` — the header is the mechanism, and a
 * well-formed pair is honoured when no credential is configured — while leaving
 * an escape hatch for an implementation that *does* check a configured secret:
 * export `COORD_BRIDGE_CLIENT_ID` / `COORD_BRIDGE_CLIENT_SECRET` and the suite
 * presents those instead. An implementation that hard-fails a well-formed pair
 * with no configured credential makes this slice unrunnable in the
 * coordinator's external re-run, which sets neither variable.
 *
 * The values below are invented and match Cloudflare's service-token shape
 * (a `.access`-suffixed id, a 64-hex secret). They are not a real credential.
 */
const CLIENT_ID =
  process.env.COORD_BRIDGE_CLIENT_ID ?? "9f2c17b4a8de40518c6b3ad0e75f1c62.access"
const CLIENT_SECRET =
  process.env.COORD_BRIDGE_CLIENT_SECRET ??
  "4d1e9c07b35a2f68e4c81079ba6d35f2c9017e4ab8d562309fc71ea48b0d63a5"

const SERVICE_TOKEN = {
  "CF-Access-Client-Id": CLIENT_ID,
  "CF-Access-Client-Secret": CLIENT_SECRET,
}

/** Contract: `type` is a closed set of customer-authored facts. */
const EVENT_TYPES = [
  "submission.created",
  "signoff.approved",
  "signoff.changes_requested",
  "question.answered",
] as const

/** Contract: portal owns these; coord may never write them. */
const PORTAL_OWNED = [
  "outcome",
  "audience",
  "done_definition",
  "constraints",
  "project_scope",
  "signoff_verdict",
  "signoff_comment",
  "answer",
] as const

/** Contract: coord owns these; the portal mirrors them read-only. */
const COORD_OWNED = [
  "status",
  "decomposition",
  "question",
  "design_round",
  "artifacts",
] as const

/** The customer-visible reference, which the contract uses as `submission_id`. */
const REFERENCE = /^SUB-[A-Z0-9]{6}$/
const ISO_8601_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

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

interface PushUpdate {
  submission_id: string
  revision: number
  fields: Record<string, unknown>
}

interface PushResult {
  submission_id: string
  outcome: string
  reason?: string
}

// ── bridge transport ────────────────────────────────────────────────────────

function pull(
  request: APIRequestContext,
  opts: {
    cursor?: string | null
    limit?: number
    headers?: Record<string, string>
  } = {},
) {
  const params: Record<string, string> = {}
  if (opts.cursor != null) params.cursor = opts.cursor
  if (opts.limit != null) params.limit = String(opts.limit)
  return request.get("/api/bridge/pull", {
    params,
    headers: opts.headers ?? SERVICE_TOKEN,
  })
}

async function pullPage(
  request: APIRequestContext,
  opts: { cursor?: string | null; limit?: number } = {},
): Promise<PullPage> {
  const res = await pull(request, opts)
  expect(res.status(), "a pull with a valid service token is 200").toBe(200)
  const body = (await res.json()) as PullPage
  expect(Array.isArray(body.events), "`events` is an array").toBe(true)
  expect(typeof body.has_more, "`has_more` is a boolean").toBe("boolean")
  return body
}

/**
 * Read the stream to its end and return the cursor that now points past every
 * event. Every test establishes its own baseline this way: the acceptance
 * database is wiped per *run*, not per *test*, and README.md forbids depending
 * on rows another test left behind.
 *
 * TODO(test-author): the contract does not pin whether `cursor` is present, and
 * whether it is stable, on a page whose `events` array is empty. This keeps the
 * last cursor it was actually given, which is tolerant of either reading.
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

function push(
  request: APIRequestContext,
  updates: PushUpdate[],
  headers: Record<string, string> = SERVICE_TOKEN,
) {
  return request.post("/api/bridge/push", { data: { updates }, headers })
}

async function pushResults(
  request: APIRequestContext,
  updates: PushUpdate[],
): Promise<PushResult[]> {
  const res = await push(request, updates)
  // Contract trap: `rejected` and `already_applied` are per-item outcomes
  // inside a 200 batch, never transport failures.
  expect(res.status(), "a push with a valid service token is always 200").toBe(200)
  const body = (await res.json()) as { results: PushResult[] }
  expect(Array.isArray(body.results), "`results` is an array").toBe(true)
  expect(body.results, "one result per update").toHaveLength(updates.length)
  return body.results
}

function heartbeat(
  request: APIRequestContext,
  at: string,
  headers: Record<string, string> = SERVICE_TOKEN,
) {
  return request.post("/api/bridge/heartbeat", { data: { at }, headers })
}

// ── seeding and read-back, through the pinned customer surface ──────────────

const SEEDS = [
  {
    outcome: "A shared board showing which greenhouse beds are due for watering.",
    audience: "our volunteer growers",
    doneDefinition: "Anyone on shift can see, in one glance, which beds are overdue.",
  },
  {
    outcome: "A monthly summary of tool loans that never came back.",
    audience: "the workshop steward",
    doneDefinition: "The steward gets one list on the first of each month.",
  },
  {
    outcome: "A printable rota for the Saturday repair café.",
    audience: "the front-desk rota planner",
    doneDefinition: "The planner can print next month's rota without editing a spreadsheet.",
  },
  {
    outcome: "A reminder when a seed order has not been acknowledged.",
    audience: "our purchasing volunteer",
    doneDefinition: "An unacknowledged order is flagged after five days.",
  },
]

function asCustomer(page: Page) {
  // Local `wrangler dev` has no Access in front of it, so identity arrives the
  // way `src/identity.ts` reads it in production. Same mechanism issue #9's
  // slice uses.
  return page.setExtraHTTPHeaders({
    "Cf-Access-Authenticated-User-Email": CUSTOMER_EMAIL,
  })
}

/**
 * Create one submission through the contract-pinned intake form and return both
 * identifiers it hands back: the URL (`/submissions/:id`) and the customer-
 * visible `SUB-XXXXXX` reference, which is what the contract's wire examples use
 * as `submission_id` on both `pull` and `push`.
 */
async function seedSubmission(
  page: Page,
  n: number,
): Promise<{ url: string; reference: string }> {
  const seed = SEEDS[n % SEEDS.length]
  await asCustomer(page)
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

/** Read the submission's status slug back off its detail screen. */
async function readStatus(page: Page, url: string): Promise<string | null> {
  await asCustomer(page)
  await page.goto(url)
  return page.getByTestId("status-pill").getAttribute("data-status")
}

function eventsFor(events: BridgeEvent[], reference: string): BridgeEvent[] {
  return events.filter((e) => e.submission_id === reference)
}

// ── the slice ───────────────────────────────────────────────────────────────

test.describe("ms-1 issue 15 sync bridge", () => {
  test("an unauthenticated request is 401 on every bridge route", async ({
    request,
  }) => {
    const noHeaders: Record<string, string> = {}

    expect((await pull(request, { headers: noHeaders })).status()).toBe(401)
    expect(
      (
        await push(
          request,
          [{ submission_id: "SUB-000000", revision: 1, fields: { status: "planned" } }],
          noHeaders,
        )
      ).status(),
    ).toBe(401)
    expect(
      (await heartbeat(request, "2026-08-09T09:00:00Z", noHeaders)).status(),
    ).toBe(401)

    // Half a credential is not a credential.
    expect(
      (await pull(request, { headers: { "CF-Access-Client-Id": CLIENT_ID } })).status(),
      "client id alone is not enough",
    ).toBe(401)
    expect(
      (
        await pull(request, {
          headers: { "CF-Access-Client-Secret": CLIENT_SECRET },
        })
      ).status(),
      "client secret alone is not enough",
    ).toBe(401)
    expect(
      (
        await pull(request, {
          headers: { "CF-Access-Client-Id": "", "CF-Access-Client-Secret": "" },
        })
      ).status(),
      "empty credentials are missing credentials",
    ).toBe(401)

    // TODO(test-author): the contract also says *invalid* credentials ⇒ 401,
    // but with no Access in front of a local Worker there is nothing that can
    // tell a well-formed-but-wrong pair from the right one, and the contract
    // pins no local credential source. Not asserted — see the CLIENT_ID note.
  })

  test("a customer Access identity is not a bridge credential", async ({ request }) => {
    // Contract: the Service Auth application is a *third* Access application
    // scoped to `/api/bridge`, separate from the site application — "that path
    // must never widen into a general bypass". A signed-in human is not the
    // daemon.
    const asHuman = { "Cf-Access-Authenticated-User-Email": CUSTOMER_EMAIL }

    expect((await pull(request, { headers: asHuman })).status()).toBe(401)
    expect(
      (
        await push(
          request,
          [{ submission_id: "SUB-000000", revision: 1, fields: { status: "planned" } }],
          asHuman,
        )
      ).status(),
    ).toBe(401)
    expect((await heartbeat(request, "2026-08-09T09:00:00Z", asHuman)).status()).toBe(401)
  })

  test("a 401 says nothing about what was wrong", async ({ request }) => {
    const missingBoth = await pull(request, { headers: {} })
    const missingSecret = await pull(request, {
      headers: { "CF-Access-Client-Id": CLIENT_ID },
    })
    const missingId = await pull(request, {
      headers: { "CF-Access-Client-Secret": CLIENT_SECRET },
    })

    const bodies = [
      await missingBoth.text(),
      await missingSecret.text(),
      await missingId.text(),
    ]

    // "no detail about what was wrong" is only true if the three failure modes
    // are indistinguishable from the outside.
    expect(new Set(bodies).size, "every 401 body is byte-identical").toBe(1)

    for (const body of bodies) {
      // TODO(test-author): the contract says "401, empty body" in one place and
      // "empty body semantics" in the issue, which hedges. An empty body and a
      // bare `{}` are both read as empty here; anything else is detail.
      expect(["", "{}"], "401 has empty body semantics").toContain(body.trim())
      expect(body).not.toMatch(/secret|client[-_ ]?id|token|expired|invalid|unknown/i)
    }
  })

  test("a pull returns the customer-authored events after the cursor", async ({
    page,
    request,
  }) => {
    const start = await drainToCursor(request)

    const first = await seedSubmission(page, 0)
    const second = await seedSubmission(page, 1)
    const third = await seedSubmission(page, 2)

    const body = await pullPage(request, { cursor: start })

    // Only what happened after the cursor.
    expect(
      body.events.map((e) => e.submission_id),
      "exactly the three submissions created after the cursor, in creation order",
    ).toEqual([first.reference, second.reference, third.reference])
    expect(body.events.every((e) => e.type === "submission.created")).toBe(true)
    expect(body.has_more).toBe(false)

    // Ordered by `revision` ascending, monotonic, never reused.
    const revisions = body.events.map((e) => e.revision)
    for (let i = 1; i < revisions.length; i++) {
      expect(revisions[i]).toBeGreaterThan(revisions[i - 1])
    }
    expect(new Set(body.events.map((e) => e.id)).size).toBe(body.events.length)

    // The cursor it hands back really is past all of them.
    const drained = await pullPage(request, { cursor: body.cursor })
    expect(drained.events, "a drained cursor yields nothing").toEqual([])
    expect(drained.has_more).toBe(false)

    // ...and picks up only what happens next.
    const fourth = await seedSubmission(page, 3)
    const next = await pullPage(request, { cursor: body.cursor })
    expect(next.events.map((e) => e.submission_id)).toEqual([fourth.reference])
  })

  test("replaying the same cursor returns the same events", async ({
    page,
    request,
  }) => {
    // "The daemon replays from its cursor on restart, so a submission is never
    // lost to a daemon outage."
    const start = await drainToCursor(request)
    await seedSubmission(page, 0)
    await seedSubmission(page, 1)

    const once = await pullPage(request, { cursor: start })
    const twice = await pullPage(request, { cursor: start })
    const thrice = await pullPage(request, { cursor: start })

    expect(once.events.length, "the replay has something to prove").toBeGreaterThan(0)
    expect(twice.events).toEqual(once.events)
    expect(thrice.events).toEqual(once.events)
    expect(twice.has_more).toBe(once.has_more)
    expect(twice.cursor).toEqual(once.cursor)
  })

  test("limit pages the stream without losing or reordering events", async ({
    page,
    request,
  }) => {
    const start = await drainToCursor(request)
    const seeded = [
      (await seedSubmission(page, 0)).reference,
      (await seedSubmission(page, 1)).reference,
      (await seedSubmission(page, 2)).reference,
    ]

    const collected: BridgeEvent[] = []
    let cursor = start
    for (let i = 0; i < 3; i++) {
      const body = await pullPage(request, { cursor, limit: 1 })
      expect(body.events.length, "limit=1 returns at most one event").toBeLessThanOrEqual(
        1,
      )
      collected.push(...body.events)
      cursor = body.cursor
      const drainedNow = collected.length === seeded.length
      expect(body.has_more, "has_more is true while events remain").toBe(!drainedNow)
      if (drainedNow) break
    }

    expect(collected.map((e) => e.submission_id)).toEqual(seeded)

    // TODO(test-author): the contract pins `limit` as "1–200, default 50" but
    // says nothing about what an out-of-range or non-numeric `limit` does
    // (400? clamp? ignore?), and testing the default of 50 would mean seeding
    // 51 submissions through the browser. Neither is asserted.
  })

  test("every event carries the pinned envelope", async ({ page, request }) => {
    const start = await drainToCursor(request)
    const seeded = await seedSubmission(page, 0)

    const body = await pullPage(request, { cursor: start })
    const [event] = eventsFor(body.events, seeded.reference)
    expect(event, "the created submission produced an event").toBeTruthy()

    expect(typeof event.id, "`id` is an opaque string").toBe("string")
    expect(event.id.length).toBeGreaterThan(0)
    expect(Number.isInteger(event.revision), "`revision` is an integer").toBe(true)
    expect(EVENT_TYPES).toContain(event.type)
    expect(event.type).toBe("submission.created")
    expect(event.submission_id).toBe(seeded.reference)
    expect(event.occurred_at, "`occurred_at` is ISO-8601 UTC").toMatch(ISO_8601_Z)
    expect(typeof event.payload, "`payload` is an object").toBe("object")
    expect(event.payload).not.toBeNull()
    expect(Array.isArray(event.payload)).toBe(false)

    // TODO(test-author): the contract illustrates `id` as `evt_01H…` and
    // `submission_id` as `SUB-7F3A2C`, but only the latter is pinned elsewhere
    // (as the customer-visible reference). The `evt_` prefix is an example, not
    // a stated rule, so only opacity is asserted for `id`.
    // TODO(test-author): the contract shows `payload` as `{ }` and never says
    // what a `submission.created` payload contains, so its contents are not
    // asserted. #1982 cannot depend on fields nobody pinned either.
  })

  test("the same push applied twice yields applied then already_applied", async ({
    page,
    request,
  }) => {
    const target = await seedSubmission(page, 0)
    expect(await readStatus(page, target.url)).toBe("describing")

    const update: PushUpdate = {
      submission_id: target.reference,
      revision: 12,
      fields: { status: "in-progress" },
    }

    const [first] = await pushResults(request, [update])
    expect(first.submission_id).toBe(target.reference)
    expect(first.outcome).toBe("applied")
    expect(await readStatus(page, target.url)).toBe("in-progress")

    // "Assume every request arrives twice."
    const [second] = await pushResults(request, [update])
    expect(second.submission_id).toBe(target.reference)
    expect(second.outcome).toBe("already_applied")

    // One stored change, not two: the second delivery is a no-op, not a
    // re-write, and the state is exactly where the first one left it.
    expect(await readStatus(page, target.url)).toBe("in-progress")

    // A genuinely newer revision still moves.
    const [third] = await pushResults(request, [
      {
        submission_id: target.reference,
        revision: 13,
        fields: { status: "quality-check" },
      },
    ])
    expect(third.outcome).toBe("applied")
    expect(await readStatus(page, target.url)).toBe("quality-check")
  })

  test("a stale revision is already_applied, not an error", async ({
    page,
    request,
  }) => {
    const target = await seedSubmission(page, 1)

    const [applied] = await pushResults(request, [
      { submission_id: target.reference, revision: 20, fields: { status: "planned" } },
    ])
    expect(applied.outcome).toBe("applied")
    expect(await readStatus(page, target.url)).toBe("planned")

    // "A revision less than or equal to the stored one is `already_applied` —
    // not an error." An out-of-order redelivery must not roll the record back.
    for (const stale of [19, 1]) {
      const [result] = await pushResults(request, [
        {
          submission_id: target.reference,
          revision: stale,
          fields: { status: "in-progress" },
        },
      ])
      expect(result.outcome, `revision ${stale} is stale`).toBe("already_applied")
      expect(await readStatus(page, target.url)).toBe("planned")
    }
  })

  test("a push touching a portal-owned field is rejected and applies nothing", async ({
    page,
    request,
  }) => {
    const target = await seedSubmission(page, 2)
    expect(await readStatus(page, target.url)).toBe("describing")

    // Every field on the portal's side of the sole-writer table, each paired
    // with a *valid* coord-owned sibling — whole-update atomicity means the
    // valid sibling must not sneak the write through.
    for (const field of PORTAL_OWNED) {
      const [result] = await pushResults(request, [
        {
          submission_id: target.reference,
          revision: 30,
          fields: { status: "in-progress", [field]: "written by the wrong side" },
        },
      ])
      expect(result.submission_id).toBe(target.reference)
      expect(result.outcome, `${field} is portal-owned`).toBe("rejected")
      expect(result.reason, `${field} is portal-owned`).toBe(`not_owned:${field}`)

      // Contract trap: this is a 200 with a per-item outcome, already asserted
      // in `pushResults`. And nothing in the update was applied — the valid
      // `status` sibling did not land.
      expect(
        await readStatus(page, target.url),
        `a rejected update must not apply its valid sibling field (${field})`,
      ).toBe("describing")
    }
  })

  test("a rejected update does not advance the revision watermark", async ({
    page,
    request,
  }) => {
    // TODO(test-author): inferred, not stated. The contract says of a rejected
    // update that "nothing in that update is applied"; recording its revision
    // would be applying part of it, and would silently swallow the daemon's
    // next legitimate write at that revision. Flagged because the contract does
    // not say so in as many words.
    const target = await seedSubmission(page, 3)

    const [rejected] = await pushResults(request, [
      {
        submission_id: target.reference,
        revision: 40,
        fields: { status: "planned", answer: "the portal owns this" },
      },
    ])
    expect(rejected.outcome).toBe("rejected")
    expect(rejected.reason).toBe("not_owned:answer")

    const [retried] = await pushResults(request, [
      { submission_id: target.reference, revision: 40, fields: { status: "planned" } },
    ])
    expect(
      retried.outcome,
      "the same revision, corrected, is still fresh — the rejection left no watermark",
    ).toBe("applied")
    expect(await readStatus(page, target.url)).toBe("planned")
  })

  test("coord-owned fields are never rejected for ownership", async ({
    page,
    request,
  }) => {
    const target = await seedSubmission(page, 0)

    // TODO(test-author): the contract pins *which side owns* each field but not
    // the value type of `decomposition`, `question`, `design_round` or
    // `artifacts`, and this milestone models none of them in the schema. So
    // this asserts only the half the ownership table actually states — a field
    // coord owns is never refused *for ownership* — and stays silent on whether
    // it must be applied, and on what a valid value looks like.
    let revision = 50
    for (const field of COORD_OWNED) {
      const value = field === "status" ? "in-progress" : `synthetic ${field} value`
      const [result] = await pushResults(request, [
        { submission_id: target.reference, revision: revision++, fields: { [field]: value } },
      ])
      expect(["applied", "already_applied", "rejected"]).toContain(result.outcome)
      if (result.outcome === "rejected") {
        expect(result.reason ?? "", `${field} is coord-owned`).not.toMatch(/^not_owned:/)
      }
    }
  })

  test("a batch returns one result per update, in request order", async ({
    page,
    request,
  }) => {
    const a = await seedSubmission(page, 0)
    const b = await seedSubmission(page, 1)
    const c = await seedSubmission(page, 2)

    // Prime `b` so its slot in the batch is a stale redelivery.
    const [primed] = await pushResults(request, [
      { submission_id: b.reference, revision: 60, fields: { status: "planned" } },
    ])
    expect(primed.outcome).toBe("applied")

    const results = await pushResults(request, [
      { submission_id: a.reference, revision: 61, fields: { status: "in-progress" } },
      { submission_id: b.reference, revision: 60, fields: { status: "quality-check" } },
      {
        submission_id: c.reference,
        revision: 61,
        fields: { status: "planned", outcome: "written by the wrong side" },
      },
    ])

    expect(results.map((r) => r.submission_id)).toEqual([
      a.reference,
      b.reference,
      c.reference,
    ])
    expect(results.map((r) => r.outcome)).toEqual([
      "applied",
      "already_applied",
      "rejected",
    ])
    expect(results[2].reason).toBe("not_owned:outcome")

    // One rejected sibling in the batch does not poison the others, and does
    // not apply itself.
    expect(await readStatus(page, a.url)).toBe("in-progress")
    expect(await readStatus(page, b.url)).toBe("planned")
    expect(await readStatus(page, c.url)).toBe("describing")
  })

  test("a coord-owned write produces no event", async ({ page, request }) => {
    // "The portal never emits an event about a coord-owned fact." Without this
    // the two sides feed each other their own writes forever.
    const target = await seedSubmission(page, 1)
    const start = await drainToCursor(request)

    const [applied] = await pushResults(request, [
      { submission_id: target.reference, revision: 70, fields: { status: "in-progress" } },
    ])
    expect(applied.outcome).toBe("applied")
    expect(await readStatus(page, target.url)).toBe("in-progress")

    const body = await pullPage(request, { cursor: start })
    expect(body.events, "a coord-owned status write is not a customer-authored fact").toEqual(
      [],
    )
    expect(body.has_more).toBe(false)
  })

  test("a heartbeat is accepted and repeatable", async ({ request }) => {
    for (const at of [
      "2026-08-09T09:00:00Z",
      "2026-08-09T09:00:30Z",
      "2026-08-09T09:01:00Z",
    ]) {
      const res = await heartbeat(request, at)
      expect(res.status()).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
    }

    // TODO(test-author): "the portal records last-seen" and "past a threshold it
    // must say the daemon looks stale" are the reason this endpoint exists, but
    // the contract pins no read route, no `data-testid` and no threshold value
    // for the staleness surface, and no mock renders it. The recording is
    // therefore not black-box observable from this suite — only that the
    // endpoint accepts a heartbeat, requires the service token (asserted above)
    // and is safe to call repeatedly.
  })

  test("the bridge exposes no inbound registration path", async ({ request }) => {
    // CLAUDE.md rule 2 and the contract's "Non-negotiable": no webhook, no
    // callback URL, no push endpoint for the daemon to register — "not even
    // behind a shared secret". So these must not exist even *with* a valid
    // service token.
    for (const path of [
      "/api/bridge/subscribe",
      "/api/bridge/webhook",
      "/api/bridge/webhooks",
      "/api/bridge/register",
      "/api/bridge/callback",
      "/api/bridge/notify",
    ]) {
      const res = await request.post(path, {
        data: { url: "https://callback.example.test/hook" },
        headers: SERVICE_TOKEN,
      })
      expect(res.ok(), `${path} must not exist`).toBe(false)
      expect(res.status(), `${path} must not exist`).toBeGreaterThanOrEqual(400)
    }
  })
})
