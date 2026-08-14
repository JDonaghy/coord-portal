import {
  expect,
  test,
  type APIRequestContext,
  type PlaywrightWorkerArgs,
} from "@playwright/test"

/**
 * ms-2 sealed acceptance slice — issue #71
 * "[portal] POST /start returns 500 on a malformed body — the unguarded
 *  formData() parse #46 fixed on one route and missed on the public one"
 *
 * Written from `tests/acceptance/ms-2/contract.md`, the mock that pins the
 * refusal screen (`mocks/03-start-rejected.html`) and issue #71's own
 * Scope/Acceptance/Constraints sections — without sight of any implementation.
 *
 * WHAT THIS SLICE IS ABOUT. `POST /start` is the one route in this repo any
 * stranger on the internet can reach with no Access identity, and a request
 * whose body is not a parseable form makes it throw a raw `TypeError` — a 5xx.
 * The reproduction in the issue is a single line:
 *
 *   curl -X POST .../start -H 'content-type: application/json' -d '{}'   → 500
 *
 * Issue #71's Acceptance pins the fix exactly: that request must return **400**
 * and render the form with the **standard refusal banner** — the same shape a
 * caller who failed Turnstile or tripped the rate limit gets, because the
 * contract's non-disclosure rule ("the response never confirms *which* check a
 * caller tripped") applies to this family too. Not a new message, not a new
 * status, not a new screen.
 *
 * SO THE STATUS CODE *IS* ASSERTED HERE, unlike in #32's slice. #32 deliberately
 * reads only the rendered banner because the contract says the code is not the
 * pinned surface for the bot-gate family. #71 is different: its Acceptance names
 * 400 literally, and "returns 400 instead of 500" is the entire content of the
 * issue. Asserting only the banner would let a 500 that happens to render the
 * refusal page pass, which is the exact bug.
 *
 * SCOPE, from issue #71:
 *   1. `POST /start` never 500s on a malformed body; it answers with the
 *      existing bot-gate/rate-limit refusal shape (banner, redisplayed form) at
 *      400, and creates no lead.
 *   2. `POST` from `/intake` gets the same guard, "returning whatever that
 *      route's own existing malformed-request shape is. Do not invent a new
 *      one." — so that route is asserted ONLY as "not a 5xx", see the test.
 *   3. Hoisting the guard into a shared helper is explicitly optional and is an
 *      implementation choice; nothing here can or should observe it.
 *
 * NOT COVERED HERE, deliberately:
 *   - The rendered surface of a *well-formed* request. #71's constraint is "do
 *     not change the rendered surface of `/start` for any well-formed request",
 *     which is #31's and #32's slices ratcheting it — they must stay green
 *     untouched, and duplicating them here would only add a second place to
 *     update if the contract ever moves.
 *   - The check ORDER ("the rate limit runs first, before the body is read").
 *     TODO(test-author): this constraint is not black-box observable. By the
 *     contract's own design a rate-limit refusal and a malformed-body refusal
 *     render the *same* banner and the same form, precisely so a caller cannot
 *     tell which check fired; the only pinned difference is a suggested 429 for
 *     the rate limit, which the contract explicitly declines to pin ("the
 *     pinned, testable surface is the rendered banner text and the fact that no
 *     lead exists afterward, not the status code"). A test that distinguished
 *     the two would be asserting the very disclosure #32 forbids. Flagged for
 *     the coordinator rather than guessed at: the ordering constraint is
 *     enforceable only by review, not by this suite.
 *
 * IP ISOLATION. Every request below carries a distinct synthetic client IP
 * (`CF-Connecting-IP` + `X-Forwarded-For`) from RFC 5737's TEST-NET-3 range, so
 * this slice neither eats nor is refused by the per-IP rate-limit budget of
 * another slice's caller — the same convention #32's slice established, and the
 * same caveat applies (see its TODO on how the Worker identifies a client IP).
 *
 * SYNTHETIC DATA: every email, IP and phrase below is invented, per CLAUDE.md
 * and the contract's "Synthetic data" section.
 */

/**
 * Contract, pinned hooks for `03`: `lead-error` (`role="alert"`), this exact
 * sentence — and issue #71 names it again as `REJECTION_BANNER`, "We couldn't
 * send that — please try again.". ASCII apostrophe, em dash (U+2014), matching
 * `contract.md` and `mocks/03-start-rejected.html` byte for byte.
 */
const REJECTION_BANNER = "We couldn't send that — please try again."

/** Contract: `lead-reference` text pattern `Reference LEAD-XXXXXX`. */
const LEAD_REFERENCE = /LEAD-[A-Z0-9]{6}/

/**
 * The refusal "explains nothing" (#32, extended by the contract to every
 * refusal family — and #71 puts the malformed-body case in exactly that family,
 * "a caller who sent an unparseable body learns exactly what a caller who
 * failed Turnstile learns").
 *
 * Asserted against the VISIBLE text, exactly as #32's slice does and for the
 * same reason: the markup legitimately carries Turnstile's own name (the
 * `turnstile-widget` hook, the Cloudflare script URL) and the shared
 * `/tokens.css` link, neither of which a person reads.
 */
const DISCLOSING_VOCABULARY: Array<[string, RegExp]> = [
  ["turnstile", /turnstile/i],
  ["captcha", /captcha/i],
  ["token", /\btokens?\b/i],
  ["bot/robot", /\bbots?\b|\brobots?\b|are you human/i],
  ["rate limit", /rate[\s-]?limit/i],
  ["too many", /too many|too often|slow down/i],
  ["the parse itself", /form ?data|multipart|boundary|content[\s-]?type|malformed|unparse|parse/i],
  ["an internal error", /internal server error|something went wrong|unexpected error/i],
]

/**
 * A leaked `TypeError` is the loudest possible violation, and it does not arrive
 * as visible copy — a Worker exception page, an HTML comment or a JSON error
 * envelope all render as nothing. So this family is swept over the RAW bytes.
 */
const LEAKED_EXCEPTION = /\bTypeError\b|\bSyntaxError\b|\bat async\b|\bstack trace\b/i

/** Visible copy only: no scripts, no styles, no attributes. */
function visibleText(body: string): string {
  return body
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#39;|&apos;|&rsquo;|&#8217;/g, "'")
    .replace(/&mdash;|&#8212;/g, "—")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Distinct synthetic client IPs from RFC 5737's TEST-NET-3 — one per REQUEST,
 * not merely one per test.
 *
 * A per-test IP is not enough here. Issue #71's own constraint says "the rate
 * limit runs first, before the body is read, and must keep doing so", so every
 * malformed POST below consumes rate-limit budget for its address. Neither the
 * issue nor the contract pins the threshold (#32's slice records only that a
 * burst of 20 must be cut off), so a loop of eight malformed shapes down one
 * address could silently start measuring the rate limit instead of the parse
 * guard — and, because both refusals render identically by design, the swap
 * would be invisible. One address per request removes the question.
 */
const IP_BLOCK = {
  repro: 171,
  shapes: 180,
  noLead: 200,
  intake: 220,
} as const

function ipFor(block: keyof typeof IP_BLOCK, offset = 0): string {
  return `203.0.113.${IP_BLOCK[block] + offset}`
}

/**
 * The operator identity, for the definitive "creates no lead" probe.
 * TODO(test-author): kept byte-identical to #33's slice, including its escape
 * hatch, because the contract pins only the allowlist BEHAVIOUR and not the env
 * var that configures it. If the acceptance environment names a different
 * operator, export `COORD_PORTAL_OPERATOR_EMAIL` for the run.
 */
const OPERATOR_EMAIL = process.env.COORD_PORTAL_OPERATOR_EMAIL ?? "ops@example.test"

/** A synthetic customer, for the `/intake` half of Scope 2. */
const CUSTOMER_EMAIL = "mira-71@example.test"

function ipHeaders(ip: string): Record<string, string> {
  return { "CF-Connecting-IP": ip, "X-Forwarded-For": ip }
}

async function callerFrom(
  playwright: PlaywrightWorkerArgs["playwright"],
  baseURL: string | undefined,
  ip: string,
  extra: Record<string, string> = {},
): Promise<APIRequestContext> {
  return playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: { ...ipHeaders(ip), ...extra },
  })
}

interface Result {
  status: number
  body: string
}

/**
 * POST a RAW body — a string, with a content-type of our choosing — rather than
 * Playwright's `form:` helper. That is the whole point of this slice: the bytes
 * on the wire must not be a parseable form.
 */
async function postRaw(
  caller: APIRequestContext,
  path: string,
  contentType: string,
  body: string,
): Promise<Result> {
  const response = await caller.post(path, {
    headers: { "content-type": contentType },
    data: body,
    maxRedirects: 0,
    failOnStatusCode: false,
  })
  return { status: response.status(), body: await response.text() }
}

/** Pull the `lead-error` element's text out of a raw response body. */
function bannerOf(body: string): string | null {
  const match = body.match(/<([a-z]+)[^>]*data-testid="lead-error"[^>]*>([\s\S]*?)<\/\1>/i)
  if (!match) return null
  return match[2]
    .replace(/<[^>]*>/g, "")
    .replace(/&#39;|&apos;|&rsquo;|&#8217;/g, "'")
    .replace(/&mdash;|&#8212;/g, "—")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Everything issue #71's Acceptance pins about the response to a malformed
 * `POST /start`, read off the raw response — status, banner, redisplayed form,
 * and nothing written.
 *
 * Note the 5xx assertion comes FIRST and separately: a run where the route
 * still throws should say "it 500ed", not "the banner was missing".
 */
function expectMalformedRefusal(result: Result, why: string): void {
  expect(
    result.status,
    `${why}: a malformed body is a malformed REQUEST, not a server error — this is issue #71's entire subject (got ${result.status})`,
  ).toBeLessThan(500)

  // Issue #71 Acceptance: "returns 400 and renders the form with the standard
  // refusal banner". Not 415, not 422, not 429 — "not a new message and not a
  // distinct status", the same 400 the contract suggests for every
  // Turnstile-shaped refusal.
  expect(result.status, `${why}: issue #71 pins 400 for this family`).toBe(400)

  const banner = bannerOf(result.body)
  expect(
    banner,
    `${why}: the pinned generic refusal banner must be rendered in a lead-error element`,
  ).toBe(REJECTION_BANNER)

  // "The correct response is the existing bot-gate/rate-limit refusal shape" —
  // which per the contract's `03` is the form, redisplayed and resubmittable.
  expect(result.body, `${why}: the form is redisplayed so the person can retry`).toContain(
    'data-testid="lead-form"',
  )
  expect(result.body, `${why}: the redisplay carries a widget to retry with`).toContain(
    'data-testid="turnstile-widget"',
  )

  // "Nothing leaks and no lead is created — the failure is upstream of every
  // write." What a stranger can see of that: no receipt, no quotable reference.
  expect(result.body, `${why}: a refused POST must not render a receipt`).not.toContain(
    'data-testid="lead-receipt"',
  )
  expect(result.body, `${why}: a refused POST mints no reference`).not.toMatch(LEAD_REFERENCE)

  // "A caller who sent an unparseable body learns exactly what a caller who
  // failed Turnstile learns."
  const copy = visibleText(result.body)
  for (const [label, pattern] of DISCLOSING_VOCABULARY) {
    expect(
      copy,
      `${why}: the refusal must disclose nothing about which check fired ("${label}")`,
    ).not.toMatch(pattern)
  }
  expect(
    result.body,
    `${why}: the raw parser exception must never reach the caller, in copy or in markup`,
  ).not.toMatch(LEAKED_EXCEPTION)
}

/**
 * The unparseable bodies issue #71 names, one per row:
 *   - "no `Content-Type`" → not drivable from here, see the TODO below;
 *   - "one that cannot be parsed as a form" → JSON, text, binary;
 *   - "a `multipart/form-data` header with a missing or malformed `boundary=`".
 *
 * TODO(test-author): a request carrying NO `Content-Type` at all is named by the
 * issue and is NOT exercised below. Playwright's `APIRequestContext` always
 * sends one (`application/octet-stream` when `data` is a string and no header
 * is set), and forcing the header empty is undefined behaviour in the transport
 * rather than a documented way to omit it. The `application/octet-stream` row is
 * the closest drivable equivalent — it reaches the identical `formData()` call
 * with something it cannot parse. Flagged rather than faked.
 */
const MALFORMED_BODIES: Array<[string, string, string]> = [
  // The literal reproduction from the issue.
  ["a JSON body", "application/json", "{}"],
  ["a JSON object with the form's own field names", "application/json", '{"summary":"x","email":"a@example.test"}'],
  ["a plain-text body", "text/plain", "hello"],
  ["an opaque binary body", "application/octet-stream", " "],
  ["an empty body with a JSON content-type", "application/json", ""],
  // The multipart rows: same header family the browser really uses, but with the
  // boundary missing or unusable — the shape a broken client or a replayed
  // redirect actually produces.
  ["multipart with no boundary= at all", "multipart/form-data", "--x\r\nnot a part\r\n--x--"],
  ["multipart with an empty boundary=", "multipart/form-data; boundary=", "--\r\n--\r\n"],
  [
    "multipart with a boundary= the body never uses",
    "multipart/form-data; boundary=----absent",
    "this body contains no part delimiters at all",
  ],
]

test.describe("ms-2 issue 71 malformed request bodies", () => {
  test("the public form answers the issue's own reproduction with 400, not 500", async ({
    playwright,
    baseURL,
  }) => {
    // Issue #71, measured against production 2026-08-13:
    //   curl -X POST /start -H 'content-type: application/json' -d '{}'  → 500
    // The whole issue is that this line returns a 5xx on the least-protected
    // surface in the repo, "produced by a one-line request any scanner will
    // send within a day of finding the form".
    const caller = await callerFrom(playwright, baseURL, ipFor("repro"))
    const result = await postRaw(caller, "/start", "application/json", "{}")
    await caller.dispose()

    expectMalformedRefusal(result, "POST /start with a JSON body (the issue's repro)")
  })

  test("every unparseable body shape lands on the same refusal, not a 5xx", async ({
    playwright,
    baseURL,
  }) => {
    // Issue #71 names three families for the same unguarded call: no
    // `Content-Type`, one that cannot be parsed as a form, and a
    // `multipart/form-data` header with a missing or malformed `boundary=`. All
    // of them reach `request.formData()`, so all of them must land on the one
    // pinned refusal — "a caller who sent an unparseable body learns exactly
    // what a caller who failed Turnstile learns".
    const seen: Record<string, string> = {}
    for (const [index, [label, contentType, body]] of MALFORMED_BODIES.entries()) {
      // A fresh address per shape — see the note on `IP_BLOCK`.
      const caller = await callerFrom(playwright, baseURL, ipFor("shapes", index))
      const result = await postRaw(caller, "/start", contentType, body)
      await caller.dispose()
      expectMalformedRefusal(result, `POST /start with ${label}`)
      seen[label] = `${result.status} ${bannerOf(result.body)}`
    }

    // ...and identically so: one status, one banner, for every shape. The
    // contract's non-disclosure rule is about the response never confirming
    // which check a caller tripped, and a per-shape difference here would
    // confirm exactly that.
    const distinct = new Set(Object.values(seen))
    expect(
      [...distinct],
      `every malformed body must produce one indistinguishable refusal; got ${JSON.stringify(seen, null, 2)}`,
    ).toHaveLength(1)
  })

  test("a malformed body creates no lead", async ({ playwright, browser, baseURL }) => {
    // Issue #71: "Nothing leaks and no lead is created — the failure is upstream
    // of every write." The contract authorises exactly this probe: "A test may
    // create N leads via valid submissions, attempt a rejected one, and assert
    // the lead count is still N."
    //
    // TODO(test-author): the only definitive lead count is the operator's
    // `GET /leads`, which is issue #33's surface — so this test necessarily
    // depends on #33 having landed as well as #71. #32's slice avoided that
    // coupling by asserting only what a stranger can see; #71's Acceptance says
    // "and creates no lead" in as many words, so the definitive probe is made
    // here, in its own test, leaving the two tests above independent of #33.
    const asOperator = await browser.newContext({
      baseURL,
      extraHTTPHeaders: { "Cf-Access-Authenticated-User-Email": OPERATOR_EMAIL },
    })
    const inbox = await asOperator.newPage()

    const countLeads = async (): Promise<number> => {
      const response = await inbox.goto("/leads")
      // Guarded so this test can never pass by finding nothing on a page that
      // does not exist: an unreachable inbox is a failure, not a count of zero.
      expect(
        response?.status(),
        `the operator inbox must be reachable as ${OPERATOR_EMAIL} for a lead count to mean anything`,
      ).toBe(200)
      return inbox.getByTestId("lead-row").count()
    }

    const before = await countLeads()

    for (const [index, [, contentType, body]] of MALFORMED_BODIES.entries()) {
      const caller = await callerFrom(playwright, baseURL, ipFor("noLead", index))
      const result = await postRaw(caller, "/start", contentType, body)
      await caller.dispose()
      expect(
        result.status,
        "a malformed body must not be a server error while we are counting leads",
      ).toBeLessThan(500)
    }

    const after = await countLeads()
    expect(
      after,
      `${MALFORMED_BODIES.length} malformed submissions must write nothing — the guard sits upstream of every write`,
    ).toBe(before)

    await asOperator.close()
  })

  test("the authenticated intake route no longer 500s on a malformed body either", async ({
    playwright,
    baseURL,
  }) => {
    // Issue #71 Scope 2: the identical unguarded parse on the intake route "gets
    // the same guard, returning whatever that route's own existing
    // malformed-request shape is. Do not invent a new one."
    //
    // TODO(test-author): so this test asserts ONLY the part that is derivable —
    // that the response is a client error and not a 5xx. Neither ms-1's contract
    // nor ms-2's pins a malformed-request shape for that route (ms-1's contract
    // writes the route as "*(from `/intake`)*" and pins no error body for it),
    // and issue #71 explicitly forbids inventing one, so no banner, no copy and
    // no exact status is asserted here. If a future contract pins that shape,
    // this is the test to tighten.
    const caller = await callerFrom(playwright, baseURL, ipFor("intake"), {
      "Cf-Access-Authenticated-User-Email": CUSTOMER_EMAIL,
    })

    // Find the POST target the way a browser does — from the form itself —
    // rather than hard-coding a path neither contract pins. This doubles as the
    // precondition that keeps the assertion below non-vacuous: a 404 from a
    // route that does not exist is "not a 5xx" too.
    const form = await caller.get("/intake", { failOnStatusCode: false })
    expect(
      form.status(),
      "a signed-in customer reaches the intake form (ms-1, already built)",
    ).toBe(200)
    const html = await form.text()
    expect(html, "ms-1 pins the intake-form hook").toContain('data-testid="intake-form"')
    const action =
      html
        .match(/<form\b[^>]*data-testid="intake-form"[^>]*>/i)?.[0]
        ?.match(/\baction\s*=\s*["']([^"']*)["']/i)?.[1] || "/intake"

    for (const [label, contentType, body] of MALFORMED_BODIES) {
      const result = await postRaw(caller, action, contentType, body)
      expect(
        result.status,
        `POST ${action} with ${label}: a body the Worker cannot parse is a malformed request, not a server error (got ${result.status})`,
      ).toBeLessThan(500)
      expect(
        result.status,
        `POST ${action} with ${label}: the caller is told they sent something wrong`,
      ).toBeGreaterThanOrEqual(400)
      // Whatever shape the route already uses, it must not hand a stranger the
      // parser's own words.
      expect(
        result.body,
        `POST ${action} with ${label}: a raw parser error must never reach the caller`,
      ).not.toMatch(LEAKED_EXCEPTION)
    }

    await caller.dispose()
  })
})
