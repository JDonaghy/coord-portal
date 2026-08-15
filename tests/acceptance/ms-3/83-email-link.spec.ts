import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test"

/**
 * ms-3 sealed acceptance slice — issue #83
 * "[portal] The notification email contains no link — the CTA is built, stored
 *  and rendered on /outbox, then dropped at the provider boundary"
 *
 * Written from `tests/acceptance/ms-3/contract.md` (§ "The provider seam",
 * § "Triggering the drain in the sealed suite", § "Route surface",
 * § "`data-testid` hooks", § "Delivery state vocabulary", § "Synthetic data",
 * Notes item 5) and from issue #83's own Scope section, and from the `/outbox`
 * mocks the contract pins — `mocks/01-outbox-queued.html` and
 * `mocks/02-outbox-sent.html`, both of which render
 * `<a class="email-cta" href="/submissions/sub_2b91ee" data-testid="email-cta">`
 * — without sight of any implementation of #83.
 *
 * WHAT THIS SLICE IS FOR. #83 is not a new feature; it is the milestone's own
 * blind spot, found on the first real customer email this pipeline ever sent.
 * The call to action is built, persisted on `outbox`, and rendered on the
 * portal's own `/outbox` preview — and 147/147 sealed tests were green while
 * every delivered mail went out linkless, because every assertion about the CTA
 * was made against `GET /outbox`, "the portal's own rendering of what it decided
 * to send," and the delivered artefact is a different one. #83's Scope item 4
 * says where the missing assertion belongs, in as many words:
 *
 *   "**Assert it in the sealed slice**, on the recorded provider payload: the
 *    sent email contains an absolute URL for *this* submission. That is the
 *    assertion whose absence is the actual root cause here, and it belongs on
 *    ms-3's own declared observable surface."
 *
 * So this slice asserts nothing about `/outbox` (that surface is already gated
 * by #49's and ms-1's slices, and it was green throughout the defect). It
 * asserts on what the provider was handed.
 *
 * ⚠ THE ONE THING THIS SLICE NEEDS THAT THE CONTRACT DOES NOT PIN — READ THIS
 * BEFORE TREATING A FAILURE HERE AS A BEHAVIOUR BUG.
 *
 * `contract.md` § "The provider seam" says the sealed suite may observe #51
 * "only… through `outbox` row transitions", and pins NO route, dev-only or
 * otherwise, that exposes the recording fake's captured payloads. The #51 slice
 * flagged that as "the single largest unassertable clause in #51" and declined
 * to invent one; #50's slice flagged it from the other side. #83 is the bug that
 * gap produced, and its Scope item 4 now requires the assertion the gap made
 * impossible — so the surface has to exist for this milestone to be gateable at
 * all.
 *
 * TODO(test-author): the contract needs a Gate-A amendment naming that surface.
 * This slice does NOT get to pin product, so it probes rather than dictates: it
 * accepts a dev-only JSON read route at any of `RECORDINGS_PATHS` below (the
 * recommendation, and the first probed, is **`GET /__outbound`** — the sibling
 * of the contract's own dev-only `GET /__scheduled`, same `__` convention, same
 * "local dev / acceptance only, never in production" rule), and it makes no
 * assumption at all about field names inside the recorded objects — every
 * assertion below is made against the string values the payload contains,
 * wherever they sit. If the implementer exposes the fake's log under a different
 * path, that is a contract amendment, not a free choice: say so in the PR, the
 * same way contract § "Triggering the drain" requires of `/__scheduled`.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED:
 *
 *  - **The name and semantics of the base-URL config var.** #83 flags this
 *    explicitly as undecided ("The decision this needs — flagging, not
 *    deciding": a `wrangler.toml` var `PUBLIC_BASE_URL` is the recommendation,
 *    "Decide this in the issue thread before writing code"). So nothing here
 *    reads `wrangler.toml`, names a var, or pins a value. The assertions are
 *    behavioural: a link that a mail client can actually follow — i.e. one with
 *    a scheme and a host — pointing at the submission the email is about. Any of
 *    the three candidate mechanisms satisfies that; two of the three are
 *    rejected by #83 on other grounds this slice has no business re-litigating.
 *  - **What an UNSET base URL does.** Same reason: #83 states the intended
 *    behaviour ("leave the email exactly as it is today (no link) rather than
 *    emit `undefined/…` or a relative href, and should be visible to an
 *    operator") but routes the decision to the issue thread, and the acceptance
 *    environment cannot boot a second Worker with the var removed anyway (the
 *    same constraint #51's slice hit with `MAIL_PROVIDER`). What IS asserted, in
 *    the last test, is the half of that sentence which holds under every
 *    candidate decision and needs no second environment: whatever the payload
 *    carries, it is never `undefined`-shaped garbage.
 *  - **Whether the mail is delivered, or renders correctly in any client.**
 *    #53's framing, unchanged: "nothing in this repo can observe a real inbox."
 *    #83's own Acceptance section keeps the real send as an operator's manual
 *    check "(it cannot be a gate)" and asks only the payload assertion of the
 *    sealed suite.
 *  - **`Reply-To`.** #83, Not in scope: "Do not change `REPLY_TO` handling."
 *    Nothing here reads or constrains it.
 *  - **The drain's transitions, the retry arc, the `mailfail` hook.** #50's
 *    slice owns those; they appear here only as instruments — a payload cannot
 *    be recorded until a row is actually sent.
 *
 * SYNTHETIC DATA. Per CLAUDE.md rule 1 and contract § "Synthetic data", every
 * address, submission and design round below is invented on the reserved
 * `example.test` TLD. No address below contains the `mailfail` substring: every
 * send in this slice is meant to succeed, because a payload is only recorded
 * when one is attempted.
 */

// ── the pinned routes ───────────────────────────────────────────────────────

/** Contract § "Route surface (pinned)". */
const OUTBOX = "/outbox"

/** Contract § "Triggering the drain in the sealed suite". */
const DRAIN = "/__scheduled"

/**
 * The dev-only read surface for #51's recording fake — see the ⚠ block above.
 * Probed in order; the first that answers 2xx with a JSON array of records wins
 * and is reused for the rest of the run. `/__outbound` is this slice's
 * recommendation and the one a contract amendment should pin.
 */
const RECORDINGS_PATHS = ["/__outbound", "/__outbox", "/__mail", "/__emails", "/__sent"]

const DRAIN_UNAVAILABLE =
  `ms-3 issue #83 cannot be observed at all: \`GET ${DRAIN}\` did not answer 2xx. ` +
  "A provider payload only exists once the drain has actually handed an email to the provider, " +
  "so this slice is downstream of #50's trigger. Contract § \"Triggering the drain in the " +
  "sealed suite\" pins that path and requires `--test-scheduled` on both `serve:acceptance` " +
  "and `serve:test`. Fix that first — nothing in #83 is gateable until it answers."

const RECORDINGS_UNAVAILABLE =
  "ms-3 issue #83 has no way to read what was handed to the mail provider. None of " +
  `${RECORDINGS_PATHS.join(", ")} answered 2xx with a JSON list of recorded emails.\n\n` +
  "This is the contract gap #83 exists to close, not a behaviour failure. #53 declares the " +
  "milestone's observable surface to be the provider call \"made against a fake that records " +
  "its payload\", and #51's Scope asks for \"a fake… that records the payloads it was handed, " +
  "so a sealed test can assert *what would have been sent* without sending it\" — but " +
  "contract.md § \"The provider seam\" pins no route that exposes them, which is precisely why " +
  "every CTA assertion in this milestone landed on `/outbox` instead and every real email went " +
  "out linkless.\n\n" +
  "What to do: expose the recording fake's captured payloads on a dev-only JSON route, " +
  "recommended `GET /__outbound` — same `__` convention and same \"local dev / acceptance " +
  "only, never in production\" rule contract § \"Route surface\" already applies to " +
  "`/__scheduled`; available when `env.MAIL_PROVIDER === \"fake\"`, absent otherwise. Shape is " +
  "deliberately loose: either a top-level JSON array, or an object with one array property " +
  "(`emails`, `records`, `sent`, `payloads`, …). This slice reads only the STRING VALUES inside " +
  "each record and never a specific field name, so the recorded object can keep whatever shape " +
  "`OutboundEmail` has. If you ship a different path, amend contract.md and say so in the PR."

// ── delivery vocabulary (contract § "Delivery state vocabulary") ────────────

const SENT = "sent"

// ── bridge transport (the instrument, not the subject) ──────────────────────

/**
 * TODO(test-author): identical to the note in `ms-3/50-drain.spec.ts` and
 * `ms-1/14-notifications.spec.ts` — ms-1's contract pins the two header names
 * but not how a Worker booted by `npm run serve:acceptance` learns which pair is
 * valid, and ms-3's contract does not reopen the question. Same escape hatch,
 * same defaults, so every slice agrees.
 */
const SERVICE_TOKEN = {
  "CF-Access-Client-Id":
    process.env.COORD_BRIDGE_CLIENT_ID ?? "9f2c17b4a8de40518c6b3ad0e75f1c62.access",
  "CF-Access-Client-Secret":
    process.env.COORD_BRIDGE_CLIENT_SECRET ??
    "4d1e9c07b35a2f68e4c81079ba6d35f2c9017e4ab8d562309fc71ea48b0d63a5",
}

interface PushResult {
  submission_id: string
  outcome: string
  reason?: string
}

async function pushFields(
  request: APIRequestContext,
  submissionId: string,
  revision: number,
  fields: Record<string, unknown>,
): Promise<PushResult> {
  const res = await request.post("/api/bridge/push", {
    data: { updates: [{ submission_id: submissionId, revision, fields }] },
    headers: SERVICE_TOKEN,
  })
  expect(res.status(), "a push with a valid service token is 200").toBe(200)
  const body = (await res.json()) as { results: PushResult[] }
  expect(body.results, "one result per update").toHaveLength(1)
  return body.results[0]
}

// ── synthetic material ──────────────────────────────────────────────────────

const SEEDS = [
  {
    outcome: "A printable watering rota for the community greenhouse.",
    audience: "our Saturday volunteers",
    doneDefinition: "Anyone on shift can see which beds are due without asking.",
  },
  {
    outcome: "A shared list of which raised beds are free to claim.",
    audience: "new plot holders",
    doneDefinition: "A new plot holder can pick a free bed unaided.",
  },
  {
    outcome: "A monthly note listing tools that were never returned.",
    audience: "the workshop steward",
    doneDefinition: "A steward gets one list on the first of the month.",
  },
  {
    outcome: "A board showing which seed trays are ready to plant out.",
    audience: "the propagation team",
    doneDefinition: "Anyone can see at a glance what is ready this week.",
  },
]

const ROUND = {
  round: 1,
  outcome: "Volunteers can see a watering rota for the greenhouse on their phone.",
  decomposition: [
    "A rota page showing who waters which beds this week",
    "A way for a volunteer to swap a shift with someone else",
  ],
  mockBundleUrl: "https://mocks.example.test/rota/round-1/",
}

/**
 * One inbox per test — the acceptance database is wiped per *run*, not per
 * *test*, so isolation comes from each test owning a distinct recipient. None
 * of these may ever contain contract § "The provider seam"'s `mailfail`
 * substring: a row that fails is never handed to the provider successfully and
 * records nothing useful for this slice.
 */
const INBOX = {
  carried: "rota-link-carried@example.test",
  textonly: "rota-link-textonly@example.test",
  html: "rota-link-html@example.test",
  wellformed: "rota-link-wellformed@example.test",
}

const REFERENCE = /^SUB-[A-Z0-9]{6}$/

// ── seeding and reading, through the pinned customer surface ────────────────

/** The verified-identity mechanism ms-1's screens assume is in front of them. */
function asCustomer(page: Page, email: string) {
  return page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": email })
}

/** Author one submission through ms-1's pinned intake form (#9's surface). */
async function seedSubmission(page: Page, n: number): Promise<string> {
  const seed = SEEDS[n % SEEDS.length]
  await page.goto("/intake")
  await page.getByTestId("field-outcome").fill(seed.outcome)
  await page.getByTestId("field-audience").fill(seed.audience)
  await page.getByTestId("field-done-definition").fill(seed.doneDefinition)
  await page.getByTestId("submit-intake").click()
  await expect(page.getByTestId("intake-receipt")).toBeVisible()

  const shown = (await page.getByTestId("submission-reference").innerText()).trim()
  const reference = shown.replace(/^Reference\s+/, "")
  expect(reference, "the receipt shows a SUB-XXXXXX reference").toMatch(REFERENCE)
  return reference
}

/**
 * The three fields that make a submission ready for sign-off, in one push.
 * This is the exact email #83 was found on: "Your design is ready for sign-off …
 * Take a look and either approve it or tell us what to change."
 */
function signoffFields() {
  return {
    status: "awaiting-signoff",
    design_round: {
      round: ROUND.round,
      outcome_definition: ROUND.outcome,
      mock_bundle_url: ROUND.mockBundleUrl,
    },
    decomposition: ROUND.decomposition,
  }
}

function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface OutboxRow {
  status: string | null
  /** ms-1's pinned `email-cta` hook — the link the portal DECIDED to send. */
  ctaHref: string | null
  subject: string | null
}

async function readRow(preview: Locator): Promise<OutboxRow> {
  const cta = preview.getByTestId("email-cta")
  const subject = preview.getByTestId("email-subject")
  return {
    status: await preview.getAttribute("data-status"),
    ctaHref: (await cta.count()) > 0 ? await cta.first().getAttribute("href") : null,
    subject: (await subject.count()) > 0 ? flat(await subject.first().innerText()) : null,
  }
}

/** Every row on the caller's own `/outbox`, in DOM order, filtered by recipient. */
async function readOutbox(page: Page, to: string): Promise<OutboxRow[]> {
  const response = await page.goto(OUTBOX)
  expect(response?.ok(), `contract § Route surface pins \`GET ${OUTBOX}\``).toBe(true)

  const previews = page.getByTestId("email-preview")
  const rows: OutboxRow[] = []
  for (let i = 0; i < (await previews.count()); i++) {
    const preview = previews.nth(i)
    const recipient = preview.getByTestId("email-to")
    if ((await recipient.count()) > 0 && !flat(await recipient.first().innerText()).includes(to)) {
      continue
    }
    rows.push(await readRow(preview))
  }
  return rows
}

async function awaitOutbox(page: Page, to: string, expected: number): Promise<OutboxRow[]> {
  let rows: OutboxRow[] = []
  await expect
    .poll(
      async () => {
        rows = await readOutbox(page, to)
        return rows.length
      },
      { message: `${to} must have exactly ${expected} outbox row(s)`, timeout: 30_000 },
    )
    .toBe(expected)
  return rows
}

// ── the drain (an instrument — #50's slice owns its behaviour) ──────────────

async function runDrain(request: APIRequestContext): Promise<void> {
  const res = await request.get(DRAIN)
  expect(res.ok(), `${DRAIN_UNAVAILABLE} (got HTTP ${res.status()})`).toBe(true)
}

/**
 * Fire the drain, with the short pauses contract § "Retry/backoff budget"
 * bounds, until the caller's single row is `sent` — i.e. until the provider has
 * actually been handed something to record.
 */
async function drainUntilSent(
  page: Page,
  request: APIRequestContext,
  to: string,
  budgetMs = 60_000,
): Promise<OutboxRow> {
  const deadline = Date.now() + budgetMs
  let rows = await readOutbox(page, to)
  let ticks = 0

  while (Date.now() < deadline) {
    await runDrain(request)
    ticks++
    await sleep(1_000)
    rows = await readOutbox(page, to)
    if (rows.length === 1 && rows[0].status === SENT) return rows[0]
  }

  throw new Error(
    `${to}'s queued row never reached \`sent\` within the contract's 60s budget after ${ticks} ` +
      `\`GET ${DRAIN}\` calls (contract § "Retry/backoff budget"). Last seen: ` +
      `${rows.map((r) => r.status ?? "<no data-status>").join("; ") || "<no outbox rows>"}. ` +
      "This slice needs a SUCCESSFUL send — no address here contains `mailfail`, so a row that " +
      "will not send means #50 or #51 is broken, not #83.",
  )
}

// ── the recorded provider payload ───────────────────────────────────────────

/** Remembered across tests so the probe cost is paid once per run. */
let recordingsPath: string | null = null

/**
 * Pull the fake's recorded payloads, probing `RECORDINGS_PATHS` in order. Every
 * record is returned as an opaque object — this slice never names a field.
 */
async function readRecordings(request: APIRequestContext): Promise<unknown[]> {
  const paths = recordingsPath ? [recordingsPath] : RECORDINGS_PATHS
  const tried: string[] = []

  for (const path of paths) {
    let parsed: unknown
    try {
      const res = await request.get(path)
      if (!res.ok()) {
        tried.push(`${path} → HTTP ${res.status()}`)
        continue
      }
      parsed = await res.json()
    } catch (err) {
      tried.push(`${path} → ${(err as Error).message}`)
      continue
    }

    const records = asRecordList(parsed)
    if (records === null) {
      tried.push(`${path} → 2xx, but no JSON array of records in the body`)
      continue
    }
    recordingsPath = path
    return records
  }

  throw new Error(`${RECORDINGS_UNAVAILABLE}\n\nProbed: ${tried.join("; ")}`)
}

/** A top-level array, or the first array-valued property of a top-level object. */
function asRecordList(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed
  if (parsed && typeof parsed === "object") {
    for (const value of Object.values(parsed as Record<string, unknown>)) {
      if (Array.isArray(value)) return value
    }
  }
  return null
}

/** Every string anywhere inside a record, at any depth. No field name assumed. */
function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value)
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, out)
  else if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) stringsIn(item, out)
  }
  return out
}

/**
 * The records addressed to one synthetic recipient. Matched on the address
 * appearing anywhere in the record rather than on a `to` field, for the same
 * reason nothing else here names a field: `OutboundEmail`'s shape is the
 * implementer's, not this slice's.
 */
async function recordsFor(request: APIRequestContext, to: string): Promise<string[][]> {
  const all = await readRecordings(request)
  return all
    .map((record) => stringsIn(record))
    .filter((strings) => strings.some((s) => s.includes(to)))
}

/** Exactly one record is expected per recipient here — one submission, one email. */
async function oneRecordFor(request: APIRequestContext, to: string): Promise<string[]> {
  let found: string[][] = []
  await expect
    .poll(async () => (found = await recordsFor(request, to)).length, {
      message:
        `the provider was never handed an email addressed to ${to}, even though that row is ` +
        "`sent` on `/outbox`. A row cannot reach `sent` without a provider call succeeding — " +
        "if the recording surface is answering but empty, it is not recording what the drain " +
        "actually sends.",
      timeout: 15_000,
    })
    .toBeGreaterThan(0)

  expect(
    found.length,
    `${to} authored exactly one submission and received exactly one notification, so the ` +
      "provider should have been handed exactly one email for it",
  ).toBe(1)
  return found[0]
}

/** Absolute, followable URLs — a scheme and a host — found in a string. */
function absoluteUrlsIn(text: string): URL[] {
  const found: URL[] = []
  for (const raw of text.match(/https?:\/\/[^\s"'<>()\[\]]+/gi) ?? []) {
    // Trailing sentence punctuation is not part of the URL a client would follow.
    const trimmed = raw.replace(/[.,;:!?]+$/, "")
    try {
      const url = new URL(trimmed)
      if (url.hostname.length > 0) found.push(url)
    } catch {
      // not a URL after all — ignore
    }
  }
  return found
}

/**
 * The path the portal itself decided to link to, read off ms-1's `email-cta`
 * hook. Using the portal's own value rather than a hardcoded `/submissions/…`
 * shape means this slice pins no id format and no route template of its own:
 * whatever the CTA points at, the email must point at the same thing.
 *
 * Tolerates the href being absolute already — #83 leaves open where the base URL
 * is applied, and an implementer who resolves it at render time as well as at
 * send time is not violating anything.
 */
function ctaPathOf(row: OutboxRow, baseURL: string | undefined, to: string): string {
  expect(
    row.ctaHref,
    `${to}'s outbox row renders no \`email-cta\` href. Contract § "\`data-testid\` hooks" keeps ` +
      "ms-1's `email-cta` present on every row, and #83's whole premise is that the CTA exists " +
      "here and is lost later — if it is missing HERE, the defect is a different one.",
  ).toBeTruthy()
  const href = row.ctaHref as string
  const resolved = new URL(href, baseURL ?? "http://127.0.0.1:8789")
  expect(
    resolved.pathname.length,
    "the CTA must point somewhere with a path — this is what the sent email has to reach",
  ).toBeGreaterThan(1)
  return resolved.pathname
}

/** Does any string in the record carry a followable URL for exactly this path? */
function urlsForPath(strings: string[], path: string): URL[] {
  return strings.flatMap((s) => absoluteUrlsIn(s)).filter((u) => samePath(u.pathname, path))
}

/**
 * Does a URL's path point at the submission the CTA points at? Equality, plus a
 * suffix allowance so that a base URL carrying a path prefix
 * (`https://portal.example.test/app` + `/submissions/sub_x`) still counts. The
 * CTA path contains the submission's own id, so a suffix match is still
 * submission-specific and cannot be satisfied by a link to some other row.
 */
function samePath(urlPath: string, ctaPath: string): boolean {
  const norm = (p: string) => (p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p)
  const [a, b] = [norm(urlPath), norm(ctaPath)]
  return a === b || a.endsWith(b)
}

/** A rough, deliberately generous "this string is markup" test. */
function looksLikeHtml(text: string): boolean {
  return /<\s*(a|p|div|body|html|br|table|span|td|h[1-6])\b[^>]*>/i.test(text)
}

// ── the slice ───────────────────────────────────────────────────────────────

test.describe("ms-3 issue 83 the link in the sent email", () => {
  test("the email handed to the provider carries a link to the submission it is about", async ({
    page,
    request,
    baseURL,
  }) => {
    // #83's headline, and its Scope item 4: "the sent email contains an absolute
    // URL for *this* submission." Everything else in this slice is a refinement
    // of this one assertion; if this is red, the customer has been "asked to act
    // and given no way to act."
    test.setTimeout(150_000)
    await asCustomer(page, INBOX.carried)
    const reference = await seedSubmission(page, 0)

    expect(
      (await pushFields(request, reference, 8300, signoffFields())).outcome,
      "a design round is entirely coord-owned",
    ).toBe("applied")

    const [queued] = await awaitOutbox(page, INBOX.carried, 1)
    const wanted = ctaPathOf(queued, baseURL, INBOX.carried)
    expect(
      queued.status,
      "positive control: the row starts `queued`, so the payload below is one the drain made",
    ).toBe("queued")

    await drainUntilSent(page, request, INBOX.carried)

    const strings = await oneRecordFor(request, INBOX.carried)
    const matches = urlsForPath(strings, wanted)

    expect(
      matches.length,
      "The email the provider was handed contains no followable link to the submission it is " +
        `about. The portal decided to link to \`${wanted}\` (that is what \`email-cta\` renders ` +
        "on `/outbox`), and #83 Scope item 4 requires the SENT email to carry an absolute URL " +
        "for the same submission — scheme and host included, because \"a mail client has no " +
        "origin to resolve it against, so even once carried it would be dead\".\n\n" +
        "What the provider was actually handed:\n" +
        preview(strings),
    ).toBeGreaterThan(0)

    // "for *this* submission" — a link to the dashboard, or to somebody else's
    // row, is not the fix. The path came off this row's own CTA, so equality is
    // the whole check; this second assertion just makes the failure legible if
    // the payload carries several links.
    expect(
      matches.map((u) => u.pathname),
      "every link this slice matched should be the submission's own path",
    ).toContain(wanted)
  })

  test("the link survives for a mail client that renders no HTML", async ({
    page,
    request,
    baseURL,
  }) => {
    // #83 Scope item 3, verbatim: "The text part must still carry the URL in
    // full, visibly — a text-only client, and every 'view original' reader, must
    // be able to reach the submission. A bare `<a>` with the URL hidden behind
    // link text fails that."
    //
    // Black-box form: at least one string in the recorded payload that is NOT
    // markup must contain the whole absolute URL. That holds whether the plain
    // part is a rendered text body or a bare href field carried alongside it —
    // this slice does not care which, only that a reader with no HTML renderer
    // can see the URL.
    test.setTimeout(150_000)
    await asCustomer(page, INBOX.textonly)
    const reference = await seedSubmission(page, 1)

    expect(
      (await pushFields(request, reference, 8310, signoffFields())).outcome,
      "a design round is entirely coord-owned",
    ).toBe("applied")

    const [queued] = await awaitOutbox(page, INBOX.textonly, 1)
    const wanted = ctaPathOf(queued, baseURL, INBOX.textonly)
    await drainUntilSent(page, request, INBOX.textonly)

    const strings = await oneRecordFor(request, INBOX.textonly)
    const plain = strings.filter((s) => !looksLikeHtml(s))
    const visible = urlsForPath(plain, wanted)

    expect(
      visible.length,
      "The submission's URL appears nowhere a text-only mail client could read it. #83 Scope " +
        "item 3: the text part \"must still carry the URL in full, visibly… A bare `<a>` with " +
        `the URL hidden behind link text fails that." Expected an absolute URL for \`${wanted}\` ` +
        "in a non-markup part of the payload.\n\n" +
        "Non-markup strings the provider was handed:\n" +
        preview(plain),
    ).toBeGreaterThan(0)
  })

  test("the provider is handed an HTML body alongside the text one", async ({
    page,
    request,
    baseURL,
  }) => {
    // #83 Scope item 3's first sentence: "Send an HTML body alongside the text.
    // Resend takes `html` and `text` together" — today `ResendMailProvider.send()`
    // posts "`text` only, no `html`", which is why the CTA has nowhere to be a
    // clickable link even once it is carried.
    //
    // TODO(test-author): contract.md is silent on this — it predates #83 — and
    // #83 does not say at which layer the HTML is composed. This slice asserts
    // it at the RECORDED PAYLOAD, because that is the only surface #83 Scope
    // item 4 gives the sealed suite and because item 1 requires the CTA to reach
    // "both the fake and the Resend implementation". An implementer who renders
    // HTML privately inside `ResendMailProvider` leaves this ungateable and the
    // defect free to recur behind a green suite; the remedy is to compose the
    // two bodies before the provider boundary (or record them on the fake), not
    // to relax this test.
    test.setTimeout(150_000)
    await asCustomer(page, INBOX.html)
    const reference = await seedSubmission(page, 2)

    expect(
      (await pushFields(request, reference, 8320, signoffFields())).outcome,
      "a design round is entirely coord-owned",
    ).toBe("applied")

    const [queued] = await awaitOutbox(page, INBOX.html, 1)
    const wanted = ctaPathOf(queued, baseURL, INBOX.html)
    await drainUntilSent(page, request, INBOX.html)

    const strings = await oneRecordFor(request, INBOX.html)
    const markup = strings.filter(looksLikeHtml)

    expect(
      markup.length,
      "Nothing the provider was handed is an HTML body. #83 Scope item 3: \"Send an HTML body " +
        "alongside the text. Resend takes `html` and `text` together\" — and item 1 requires " +
        "the CTA to reach \"both the fake and the Resend implementation\", so the HTML part has " +
        "to exist at the boundary the fake records, not privately inside the Resend adapter.\n\n" +
        "What the provider was actually handed:\n" +
        preview(strings),
    ).toBeGreaterThan(0)

    const linked = markup.filter((html) =>
      anchorHrefsIn(html).some((href) => {
        try {
          return samePath(new URL(href, "http://mail.invalid").pathname, wanted)
        } catch {
          return false
        }
      }),
    )

    expect(
      linked.length,
      `The HTML body carries no anchor pointing at \`${wanted}\`. #83's customer "has been ` +
        "asked to act and given no way to act\" — a clickable link to this submission is the " +
        "act. (#83 Acceptance: \"a clickable absolute link that opens the correct " +
        "`/submissions/:id` after Access sign-in\".)\n\n" +
        "HTML the provider was handed:\n" +
        preview(markup),
    ).toBeGreaterThan(0)
  })

  test("a sent email never carries a broken or unresolved link", async ({ page, request }) => {
    // RATCHET, and the one half of #83's flagged-not-decided base-URL question
    // that holds under every candidate answer: "an unset base URL should leave
    // the email exactly as it is today (no link) rather than emit `undefined/…`
    // or a relative href".
    //
    // So this asserts no positive shape at all — the three tests above do that.
    // It asserts that whatever ends up in the payload is never the failure mode
    // #83 names by example: a stringified `undefined`/`null`/object where a
    // configured base URL should have been, or a URL with no host. That is true
    // of today's linkless email too, and must stay true of every future one;
    // it is here so a base URL wired in from an unset var fails loudly rather
    // than shipping `https://undefined/submissions/sub_x` to a customer.
    test.setTimeout(150_000)
    await asCustomer(page, INBOX.wellformed)
    const reference = await seedSubmission(page, 3)

    expect(
      (await pushFields(request, reference, 8330, signoffFields())).outcome,
      "a design round is entirely coord-owned",
    ).toBe("applied")

    await awaitOutbox(page, INBOX.wellformed, 1)
    await drainUntilSent(page, request, INBOX.wellformed)

    const strings = await oneRecordFor(request, INBOX.wellformed)
    const joined = strings.join("\n")

    const GARBAGE: Array<[RegExp, string]> = [
      [/\bundefined\b/i, "an unset value was interpolated into the email"],
      [/\bnull\b/i, "a null value was interpolated into the email"],
      [/\[object Object\]/i, "an object was interpolated into the email"],
      [/\bNaN\b/, "a numeric conversion failed into the email"],
      [/https?:\/\/(?:undefined|null|\/|\s)/i, "a URL was built on an unset base"],
      [/https?:\/\/[^/\s]*\bundefined\b/i, "a URL was built on an unset base"],
    ]

    for (const [pattern, why] of GARBAGE) {
      expect(
        joined,
        `${why} — #83 requires that a missing base URL "leave the email exactly as it is today ` +
          "(no link) rather than emit `undefined/…` or a relative href, and should be visible " +
          "to an operator\". A customer must never receive this.\n\n" +
          "What the provider was handed:\n" +
          preview(strings),
      ).not.toMatch(pattern)
    }

    // Every followable URL in the payload must actually be followable: a scheme,
    // a host, and nothing hiding a placeholder in the host position.
    for (const url of absoluteUrlsIn(joined)) {
      expect(
        url.hostname,
        `\`${url.href}\` has no usable host — a mail client cannot open it`,
      ).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i)
    }
  })
})

// ── failure-message helpers ─────────────────────────────────────────────────

/** Anchor hrefs in a blob of markup — deliberately forgiving about quoting. */
function anchorHrefsIn(html: string): string[] {
  const hrefs: string[] = []
  for (const match of html.matchAll(/<\s*a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    hrefs.push(match[2] ?? match[3] ?? match[4] ?? "")
  }
  return hrefs.filter(Boolean)
}

/**
 * A bounded, readable dump of what was recorded, so a failure above says what
 * the provider got rather than only what it should have got.
 */
function preview(strings: string[]): string {
  if (strings.length === 0) return "  <nothing — the record held no strings at all>"
  return strings
    .slice(0, 12)
    .map((s, i) => `  [${i}] ${flat(s).slice(0, 300)}${s.length > 300 ? " …" : ""}`)
    .join("\n")
}
