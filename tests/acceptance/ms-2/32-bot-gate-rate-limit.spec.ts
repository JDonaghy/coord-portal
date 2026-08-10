import {
  expect,
  test,
  type APIRequestContext,
  type Page,
  type PlaywrightWorkerArgs,
} from "@playwright/test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/**
 * ms-2 sealed acceptance slice — issue #32
 * "[portal] Turnstile bot gate + rate limit on the public lead form"
 *
 * Written from `tests/acceptance/ms-2/contract.md` and the two mocks that pin
 * this surface (`mocks/01-start-form.html` — the widget and its public sitekey;
 * `mocks/03-start-rejected.html` — the one generic rejection banner), without
 * sight of any implementation.
 *
 * SCOPE. Issue #32's Scope section names exactly three things:
 *   1. server-side `siteverify` on `POST /start`, **before anything is written**;
 *   2. a coarse per-IP rate limit on `POST /start`;
 *   3. test-key wiring so both outcomes are drivable black-box.
 * What is black-box observable about that, and what this slice asserts:
 *   - `GET /start` renders a Turnstile widget bound to a **public** sitekey, and
 *     the **secret** appears nowhere a caller — or the repo — can see it.
 *   - A `POST /start` the gate cannot verify (no token, empty token, malformed
 *     token, a token that was never issued) **creates no lead** and redisplays
 *     the form with the pinned generic banner.
 *   - The gate is in the Worker: a caller that never loads the page, never runs
 *     the widget's JavaScript, and simply POSTs the fields is still refused.
 *   - The refusal **explains nothing** — same banner for every reason, no
 *     Turnstile/CAPTCHA/token/rate-limit vocabulary anywhere on the screen.
 *   - A sustained burst of otherwise-valid submissions from one IP is cut off,
 *     and the cutoff is **per-IP**, not a global kill switch.
 *
 * NOT COVERED HERE, deliberately (see the four TODO blocks below for why):
 *   - The always-*fail* test key pair. The suite gets one server, booted by
 *     `playwright.acceptance.config.ts` (outside this sealed directory), with
 *     one Turnstile configuration. A spec cannot swap it, so the failing
 *     outcome is driven with tokens the gate cannot verify instead.
 *   - Reused / already-spent tokens. Genuinely undrivable under the documented
 *     always-pass pair — see TODO(test-author) "REUSED TOKENS" below.
 *   - Fail-closed on an unset secret. Same reason: the secret is set by the
 *     webServer command this slice may not touch.
 *   - Content classification, and CAPTCHA on authenticated routes — issue #32's
 *     own Out of scope.
 *   - The `lead-error` banner on a *validation* failure (missing summary or
 *     email). That family is #31's; the contract does not pin the banner copy
 *     for it, only for the bot-gate/rate-limit family asserted here.
 *
 * STATUS CODES ARE NOT ASSERTED. The contract suggests 400 for a Turnstile-shaped
 * failure and 429 for the rate limit, but is explicit that "the pinned, testable
 * surface is the rendered banner text and the fact that no lead exists
 * afterward, not the status code". So every assertion below reads the rendered
 * page, never the code.
 *
 * IP ISOLATION. Every request in this slice is made through a context carrying a
 * distinct synthetic client IP (`CF-Connecting-IP`, plus `X-Forwarded-For`) from
 * the TEST-NET-3 documentation range, so that this slice's deliberate flooding
 * never eats the rate-limit budget of the shared loopback address and poison
 * later slices (#33, #41) that also write to `POST /start`.
 *   TODO(test-author): the contract does not pin how the Worker identifies a
 *   client IP. `CF-Connecting-IP` is the only IP surface a Cloudflare Worker
 *   has, so it is the assumption here — but if an implementation keys its rate
 *   limit off the raw socket address under `wrangler dev` and ignores the
 *   header, these contexts are not isolated from each other and the per-IP test
 *   below will read as a failure of the implementation when it is really a
 *   disagreement about an unpinned detail.
 *
 * SYNTHETIC DATA. Per CLAUDE.md rule 1 and the contract's "Synthetic data"
 * section, every email, name, IP and phrase below is invented.
 */

/** Contract, "Bot gate + rate limit": the literal token a test sitekey mints. */
const TURNSTILE_DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX"

/**
 * TODO(test-author): the contract pins the test key pair but NOT the request
 * field the token arrives in. `cf-turnstile-response` is Turnstile's own
 * documented convention (the widget injects a hidden input of exactly this
 * name), not something issues #31–#34 name — and #31's slice already assumes
 * it. If an implementation renames it, the "accepted" half of the rate-limit
 * test below cannot mint a lead and this slice fails for a naming reason rather
 * than a behavioural one.
 */
const TURNSTILE_FIELD = "cf-turnstile-response"

/**
 * Contract, "Bot gate + rate limit", verified against Cloudflare's testing docs.
 * Sitekeys are public by design; secrets are `wrangler secret put`-only values
 * that must never reach a rendered page or the repository. `3x...` is
 * Cloudflare's third documented pair ("token already spent") — not pinned by
 * the contract, listed here only so the hygiene assertions catch it too.
 */
const DOCUMENTED_SITEKEYS = [
  "1x00000000000000000000AA", // always passes
  "2x00000000000000000000AB", // always fails
  "3x00000000000000000000FF", // forces an interactive challenge
]
const DOCUMENTED_SECRETS = [
  "1x0000000000000000000000000000000AA", // always passes
  "2x0000000000000000000000000000000AA", // always fails
  "3x0000000000000000000000000000000AA", // "token already spent"
]

/** Contract: `lead-reference` text pattern `Reference LEAD-XXXXXX`. */
const LEAD_REFERENCE = /LEAD-[A-Z0-9]{6}/

/**
 * Contract, pinned hooks for `03`: `lead-error` (`role="alert"`), this exact
 * sentence. The apostrophe is ASCII `'` and the dash is an em dash (U+2014),
 * matching both `contract.md` and `mocks/03-start-rejected.html` byte for byte.
 */
const REJECTION_BANNER = "We couldn't send that — please try again."

/**
 * The rejection "says so plainly without explaining what a valid token would
 * look like" (#32), and the contract extends that non-disclosure to the rate
 * limit. None of this vocabulary may reach the visible page.
 */
const DISCLOSING_VOCABULARY: Array<[string, RegExp]> = [
  ["turnstile", /turnstile/i],
  ["captcha", /captcha/i],
  ["token", /\btokens?\b/i],
  ["bot/robot", /\bbots?\b|\brobots?\b|are you human/i],
  ["challenge", /\bchallenges?\b/i],
  ["verification", /\bverif(y|ied|ication|ication failed)\b/i],
  ["siteverify", /siteverify/i],
  ["rate limit", /rate[\s-]?limit/i],
  ["too many", /too many|too often|slow down/i],
  ["retry-after", /try again in\b|wait \d|\d+\s*(seconds?|minutes?|hours?)\b/i],
  ["spam", /\bspam\b|\bblocked\b|\bblacklist/i],
]

/** ms-1's authenticated-topbar hooks — a leak if they appear on a public screen. */
const AUTHENTICATED_TOPBAR = ["nav-dashboard", "nav-new", "identity-email", "nav-leads"]

interface LeadFields {
  summary: string
  email: string
  name?: string
}

function lead(tag: string): Required<LeadFields> {
  return {
    summary: `A shared shift board for our two shops (${tag.toUpperCase()}-NONCE).`,
    email: `raj-${tag}@example.test`,
    name: "Raj",
  }
}

/** Distinct synthetic client IPs, one per test, from RFC 5737's TEST-NET-3. */
const IP = {
  hygiene: "203.0.113.11",
  noToken: "203.0.113.22",
  unverifiable: "203.0.113.33",
  rendered: "203.0.113.44",
  uniform: "203.0.113.55",
  burst: "203.0.113.66",
  bystander: "203.0.113.77",
} as const

function ipHeaders(ip: string): Record<string, string> {
  return { "CF-Connecting-IP": ip, "X-Forwarded-For": ip }
}

async function callerFrom(
  playwright: PlaywrightWorkerArgs["playwright"],
  baseURL: string | undefined,
  ip: string,
): Promise<APIRequestContext> {
  return playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: ipHeaders(ip),
  })
}

async function postStart(
  caller: APIRequestContext,
  fields: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const response = await caller.post("/start", {
    form: fields,
    maxRedirects: 0,
    failOnStatusCode: false,
  })
  return { status: response.status(), body: await response.text() }
}

/** Pull the `lead-error` element's text out of a raw response body. */
function bannerOf(body: string): string | null {
  const match = body.match(
    /<([a-z]+)[^>]*data-testid="lead-error"[^>]*>([\s\S]*?)<\/\1>/i,
  )
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
 * Everything the contract pins about a bot-gate/rate-limit rejection, read off a
 * raw response body: the generic banner, the redisplayed form, and — the part
 * that actually matters — no reference and no receipt, i.e. nothing was written.
 *
 * TODO(test-author): "creates no lead" is only *definitively* observable on the
 * operator's `GET /leads` (contract: "a test may create N leads ... and assert
 * the lead count is still N"), which is issue #33's surface and is deliberately
 * not reached from this slice. What is asserted here is everything a stranger
 * can see: no receipt, no reference, and (in the no-token test) no ms-1
 * submission for the address that was submitted.
 */
function expectRejected(
  result: { status: number; body: string },
  why: string,
): void {
  const { body } = result
  expect(body, `${why}: a rejected POST must not render a receipt`).not.toContain(
    'data-testid="lead-receipt"',
  )
  expect(body, `${why}: a rejected POST mints no reference`).not.toMatch(LEAD_REFERENCE)
  expect(body, `${why}: the form is redisplayed so the person can retry`).toContain(
    'data-testid="lead-form"',
  )
  expect(
    bannerOf(body),
    `${why}: the pinned generic banner must be rendered in a lead-error element`,
  ).toBe(REJECTION_BANNER)
  const banner = bannerOf(body) ?? ""
  for (const [label, pattern] of DISCLOSING_VOCABULARY) {
    expect(
      banner,
      `${why}: the banner must not disclose "${label}" — #32 forbids explaining what a valid token would look like`,
    ).not.toMatch(pattern)
  }
}

function isReceipt(body: string): boolean {
  return body.includes('data-testid="lead-receipt"') && LEAD_REFERENCE.test(body)
}

/**
 * TODO(test-author): REUSED TOKENS — issue #32 names "a reused token" as a case
 * that must create no lead, and this slice does NOT assert it. This is a real
 * gap, flagged rather than papered over, because the two requirements collide:
 *
 *   - A test sitekey mints one literal, constant string, `XXXX.DUMMY.TOKEN.XXXX`,
 *     on every render. Every submission in an acceptance run therefore carries
 *     the *same* token value.
 *   - Cloudflare's always-pass secret accepts that string every time; replay
 *     rejection (`timeout-or-duplicate`) is a property of production
 *     `siteverify`, not of the documented test pair. Cloudflare ships a third
 *     secret (`3x...AA`) that always reports "already spent", but that one
 *     rejects the *first* use too, so it cannot coexist with the accepted-lead
 *     tests in the same server configuration.
 *   - Conversely, an implementation that enforced single-use *itself* (a
 *     server-side seen-token store) would reject every submission after the
 *     first in the whole run — breaking issue #31's slice, which submits the
 *     form repeatedly.
 *
 * So under the contract's pinned key table, "reuse is refused" is not a
 * black-box-drivable statement, and asserting it either way would be inventing
 * behaviour. Escalated to the coordinator instead: it needs either a third
 * configuration the suite can select, or an explicit contract note that replay
 * protection is delegated to production `siteverify`.
 */

/**
 * TODO(test-author): FAIL CLOSED ON AN UNSET SECRET — the contract says "a test
 * may unset the secret entirely and assert `POST /start` still creates no
 * lead". It cannot, from here: the one server under test is booted by
 * `playwright.acceptance.config.ts`'s `webServer` (`npm run serve:acceptance`),
 * which is outside this sealed directory and which this slice is not permitted
 * to edit. Driving it would need a second server on a second port with the
 * secret unset — a change to the run harness, not to a spec. Not asserted;
 * flagged for the coordinator. The adjacent, drivable half of that requirement
 * (the secret never reaching a caller or the repo) IS asserted below.
 */

test.describe("ms-2 issue 32 bot gate and rate limit", () => {
  test("the widget's sitekey is public and rendered; the secret reaches neither the caller nor the repo", async ({
    playwright,
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({
      baseURL,
      extraHTTPHeaders: ipHeaders(IP.hygiene),
    })
    const page = await context.newPage()
    await page.goto("/start")

    // Contract, pinned hooks for `01`: `turnstile-widget`, "the Cloudflare
    // widget container, carries `data-sitekey`".
    const widget = page.getByTestId("turnstile-widget")
    await expect(widget, "the public form must carry the Turnstile widget").toHaveCount(1)
    const sitekey = (await widget.getAttribute("data-sitekey")) ?? ""
    expect(sitekey.trim(), "the widget must be bound to a sitekey").not.toBe("")

    // "The sitekey is public by design and may appear in rendered HTML." The
    // secret never may — including by being pasted in as the sitekey.
    expect(
      DOCUMENTED_SECRETS,
      "a Turnstile SECRET must never be rendered as the widget's sitekey",
    ).not.toContain(sitekey.trim())

    // TODO(test-author): the contract requires "one public, one secret, both
    // overridable in the local/acceptance environment" but does not pin that
    // the acceptance run uses a *documented test* sitekey — only that the
    // sitekey and secret must be the matching members of one pair. Asserted as
    // a warning-shaped check rather than a hard equality: the acceptance
    // environment must not be pointed at a real production sitekey, because
    // then no test could ever mint a token. `mocks/01` renders the always-pass
    // key, so that is the expectation.
    expect(
      DOCUMENTED_SITEKEYS,
      `the acceptance environment must use a documented Turnstile test sitekey so both outcomes are drivable without a human solving a challenge; got "${sitekey}"`,
    ).toContain(sitekey.trim())

    // TODO(test-author): inferred from Turnstile's documented integration, not
    // pinned by the contract — a widget container with no Cloudflare script
    // behind it mints no token, so the hook would be present but not
    // "functional" in the sense contract note 5 requires.
    const html = await page.content()
    expect(
      html,
      "the widget needs Cloudflare's script to mint a token",
    ).toContain("challenges.cloudflare.com")

    // "Verified server-side in the Worker — not merely rendered client-side."
    // Whatever the page ships, it must not ship the secret.
    for (const secret of DOCUMENTED_SECRETS) {
      expect(html, "a Turnstile secret must never reach the browser").not.toContain(
        secret,
      )
    }
    expect(
      html,
      "no secret-named binding may be interpolated into the public page",
    ).not.toMatch(/turnstile[_-]?secret/i)

    // A receipt and a rejection are rendered by the same Worker; neither may
    // leak it either.
    const caller = await callerFrom(playwright, baseURL, IP.hygiene)
    const rejected = await postStart(caller, {
      summary: "A shift board for our two shops (HYGIENE-NONCE).",
      email: "raj-hygiene@example.test",
    })
    for (const secret of DOCUMENTED_SECRETS) {
      expect(
        rejected.body,
        "a rejected POST /start must not leak the secret",
      ).not.toContain(secret)
    }
    await caller.dispose()

    // "The Turnstile secret is a Worker secret (`wrangler secret put`), never in
    // git, never in `wrangler.toml`, never in a fixture."
    const wranglerToml = readFileSync(
      fileURLToPath(new URL("../../../wrangler.toml", import.meta.url)),
      "utf8",
    )
    for (const secret of DOCUMENTED_SECRETS) {
      expect(
        wranglerToml,
        "wrangler.toml is in git — a Turnstile secret must never be committed there",
      ).not.toContain(secret)
    }
    expect(
      wranglerToml,
      "the secret must be a `wrangler secret put` value, not a wrangler.toml var",
    ).not.toMatch(/^\s*[A-Z0-9_]*TURNSTILE[A-Z0-9_]*SECRET[A-Z0-9_]*\s*=/im)

    await context.close()
  })

  test("a POST carrying no Turnstile token creates no lead — the gate is in the Worker, not the browser", async ({
    playwright,
    browser,
    baseURL,
  }) => {
    // This caller never loads `/start`, never runs the widget's JavaScript, and
    // never sees a challenge — exactly the shape of the traffic #32 exists to
    // stop. "Verified server-side in the Worker — not merely rendered
    // client-side" means this must be refused.
    const caller = await callerFrom(playwright, baseURL, IP.noToken)
    const values = lead("no-token")

    for (const [label, fields] of [
      ["no token field at all", { ...values }],
      ["an empty token", { ...values, [TURNSTILE_FIELD]: "" }],
      ["a whitespace token", { ...values, [TURNSTILE_FIELD]: "   " }],
    ] as Array<[string, Record<string, string>]>) {
      const result = await postStart(caller, fields)
      expectRejected(result, `POST /start with ${label}`)
    }
    await caller.dispose()

    // "Before anything is written": the clearest thing a stranger can check is
    // that the address they submitted acquired nothing on the ms-1 side either.
    // (The definitive lead-count probe is #33's `/leads` — see the note on
    // `expectRejected`.)
    const asLead = await browser.newContext({
      baseURL,
      extraHTTPHeaders: { "Cf-Access-Authenticated-User-Email": values.email },
    })
    const dashboard = await asLead.newPage()
    await dashboard.goto("/submissions")
    const dashboardText = await dashboard.locator("body").innerText()
    expect(
      dashboardText,
      "a refused submission must write nothing anywhere",
    ).not.toContain(values.summary)
    await asLead.close()
  })

  test("a token the Worker cannot verify creates no lead", async ({
    playwright,
    baseURL,
  }) => {
    // Issue #32: "a malformed token, ... or one that fails `siteverify`
    // ... creates no lead". None of these is the string a test sitekey mints,
    // so none of them can be verified against the configured secret.
    const caller = await callerFrom(playwright, baseURL, IP.unverifiable)
    const values = lead("unverifiable")

    for (const [label, token] of [
      ["a malformed token", "not-a-turnstile-token"],
      ["a truncated dummy token", TURNSTILE_DUMMY_TOKEN.slice(0, 8)],
      ["a dummy token with the wrong shape", "XXXX.DUMMY.TOKEN"],
      ["a token that was never issued", "0.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      ["an absurdly long token", `X.${"A".repeat(4096)}.X`],
      ["a token smuggling a null-ish separator", `${TURNSTILE_DUMMY_TOKEN}\n${TURNSTILE_DUMMY_TOKEN}`],
    ] as Array<[string, string]>) {
      const result = await postStart(caller, {
        ...values,
        [TURNSTILE_FIELD]: token,
      })
      expectRejected(result, `POST /start with ${label}`)
    }

    await caller.dispose()
  })

  test("the rejection redisplays the form and says so plainly, explaining nothing", async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({
      baseURL,
      extraHTTPHeaders: ipHeaders(IP.rendered),
    })
    const page = await context.newPage()
    const values = lead("rendered")

    await page.goto("/start")

    // Submit the pinned fields with no token at all, from the page itself. An
    // injected form is used rather than clearing the widget's hidden input
    // because the contract does not pin that input's name — a form we build
    // carries no token regardless of what the widget calls its own field.
    await submitWithoutToken(page, values)

    // Contract, pinned hooks for `03`.
    const banner = page.getByTestId("lead-error")
    await expect(banner, "a refused submission must say so").toBeVisible()
    await expect(banner).toHaveAttribute("role", "alert")
    expect((await banner.innerText()).replace(/\s+/g, " ").trim()).toBe(
      REJECTION_BANNER,
    )

    // "...and the form is intact and resubmittable", with "a fresh
    // `turnstile-widget`". Contract note 5 is explicit that this does not
    // require asserting the token *value* changed — only that the container is
    // present and the form can be sent again.
    await expect(page.getByTestId("lead-form")).toBeVisible()
    await expect(page.getByTestId("lead-form")).toHaveAttribute("action", "/start")
    await expect(page.getByTestId("turnstile-widget")).toHaveCount(1)
    await expect(page.getByTestId("field-lead-summary")).toBeEditable()
    await expect(page.getByTestId("field-lead-email")).toBeEditable()
    await expect(page.getByTestId("submit-lead")).toBeEnabled()
    await expect(page.getByTestId("submit-lead")).toHaveText("Send")

    // Nothing was created: no receipt, no reference to quote.
    await expect(page.getByTestId("lead-receipt")).toHaveCount(0)
    await expect(page.getByTestId("lead-reference")).toHaveCount(0)
    const pageText = await page.locator("body").innerText()
    expect(pageText, "a refused submission mints no reference").not.toMatch(
      LEAD_REFERENCE,
    )

    // "...without explaining what a valid token would look like." Asserted
    // against the visible text, not the HTML: the widget container legitimately
    // carries Turnstile's own name in markup (`data-testid="turnstile-widget"`,
    // the Cloudflare script URL), and the challenge itself renders in a
    // cross-origin iframe that `innerText` does not reach.
    for (const [label, pattern] of DISCLOSING_VOCABULARY) {
      expect(
        pageText,
        `the rejection screen must not explain the gate to a caller ("${label}")`,
      ).not.toMatch(pattern)
    }

    // Still the public screen: `03` shares `01`'s header rule.
    await expect(page.getByTestId("brand-home")).toBeVisible()
    for (const hook of AUTHENTICATED_TOPBAR) {
      await expect(
        page.getByTestId(hook),
        `a public screen must not render the ${hook} hook`,
      ).toHaveCount(0)
    }

    // TODO(test-author): mock-derived, not spelled out in contract.md's prose —
    // `mocks/03-start-rejected.html` redisplays the form with the submitted
    // values still in it (`value="priya@example.test"`, the summary inside the
    // textarea). Read as part of "the form is intact": a person who is refused
    // should not have to retype what they wrote.
    await expect(page.getByTestId("field-lead-summary")).toHaveValue(values.summary)
    await expect(page.getByTestId("field-lead-email")).toHaveValue(values.email)

    await context.close()
  })

  test("every refusal renders the same page — nothing tells a caller which check it tripped", async ({
    playwright,
    baseURL,
  }) => {
    // Contract: "This contract pins one generic message for every one of those
    // reasons ... specifically so the response never confirms *which* check a
    // caller tripped." Two Turnstile-shaped families are compared here; the
    // rate-limit family is compared against the same constant in the burst test
    // below, which is the only place a rate-limit refusal can be produced.
    const caller = await callerFrom(playwright, baseURL, IP.uniform)
    const values = lead("uniform")

    const banners: Record<string, string | null> = {}
    for (const [label, fields] of [
      ["missing token", { ...values }],
      ["empty token", { ...values, [TURNSTILE_FIELD]: "" }],
      ["malformed token", { ...values, [TURNSTILE_FIELD]: "nonsense" }],
      [
        "unissued token",
        { ...values, [TURNSTILE_FIELD]: "0.abcdefghijklmnopqrstuvwxyz123456" },
      ],
    ] as Array<[string, Record<string, string>]>) {
      const { body } = await postStart(caller, fields)
      banners[label] = bannerOf(body)
    }
    await caller.dispose()

    for (const [label, banner] of Object.entries(banners)) {
      expect(
        banner,
        `the "${label}" refusal must render the one pinned generic banner`,
      ).toBe(REJECTION_BANNER)
    }
  })

  test("a burst of submissions from one IP is cut off, and the cutoff is per-IP", async ({
    playwright,
    baseURL,
  }) => {
    // Issue #32: "a coarse per-IP rate limit on `POST /start` ... Neither needs
    // to be clever — this is a contact form, and the honest traffic pattern is
    // one submission per person per week."
    //
    // TODO(test-author): neither the issue nor the contract pins a threshold or
    // a window, so this test cannot assert a specific number. What it asserts
    // is the shape of the requirement: an identical, otherwise-valid submission
    // that succeeds at first must stop succeeding when repeated back to back
    // from the same address. BURST is the point at which this slice gives up
    // and calls it "no rate limit"; a limit looser than this from a single IP
    // within one test run is not a coarse limit on a contact form. If an
    // implementer's threshold is genuinely higher, this number is the thing to
    // renegotiate — not the assertion.
    const BURST = 20

    const flooder = await callerFrom(playwright, baseURL, IP.burst)
    let accepted = 0
    let refusal: { status: number; body: string } | null = null

    for (let i = 0; i < BURST; i += 1) {
      const result = await postStart(flooder, {
        summary: `A shift board for our two shops (BURST-${i}-NONCE).`,
        email: `raj-burst-${i}@example.test`,
        [TURNSTILE_FIELD]: TURNSTILE_DUMMY_TOKEN,
      })
      if (isReceipt(result.body)) {
        accepted += 1
        continue
      }
      refusal = result
      break
    }
    await flooder.dispose()

    // If nothing was ever accepted, the run is not testing a rate limit — it is
    // testing a gate that refuses the documented always-pass token, which would
    // mean the acceptance environment is wired to the wrong member of the pair.
    expect(
      accepted,
      "a valid submission carrying the documented dummy token must be accepted at least once, or the acceptance environment is wired to the always-FAIL pair and no rate limit can be observed",
    ).toBeGreaterThan(0)

    expect(
      refusal,
      `${BURST} back-to-back submissions from one IP must be cut off by the per-IP rate limit (all ${accepted} were accepted)`,
    ).not.toBeNull()

    // The rate limit is refused with the same generic banner as every Turnstile
    // failure — contract's own choice, flagged in its note 2, so it is called
    // out here too.
    // TODO(test-author): contract note 2 concedes that "a worker who ships a
    // distinct, more specific rate-limit message is arguably still compliant
    // with issue #32's letter". This asserts the contract's resolution, which
    // is what a sealed suite is for — but it is the most likely honest
    // disagreement in this slice.
    expectRejected(refusal!, "the rate-limited POST /start")

    // Coarse, but not a global kill switch: a different address is unaffected.
    const bystander = await callerFrom(playwright, baseURL, IP.bystander)
    const theirs = await postStart(bystander, {
      summary: "A shift board for our two shops (BYSTANDER-NONCE).",
      email: "raj-bystander@example.test",
      [TURNSTILE_FIELD]: TURNSTILE_DUMMY_TOKEN,
    })
    await bystander.dispose()
    expect(
      isReceipt(theirs.body),
      "the rate limit is per-IP: one flooder must not lock out everyone else",
    ).toBe(true)
  })
})

/**
 * POST the pinned fields from the page itself with no Turnstile token, by
 * appending a plain form and submitting it. Deferred to a macrotask so the
 * evaluate call returns before the navigation tears its execution context down.
 */
async function submitWithoutToken(page: Page, values: Required<LeadFields>) {
  await page.evaluate((fields) => {
    const form = document.createElement("form")
    form.method = "POST"
    form.action = "/start"
    for (const [name, value] of Object.entries(fields)) {
      const input = document.createElement("input")
      input.type = "hidden"
      input.name = name
      input.value = value
      form.appendChild(input)
    }
    document.body.appendChild(form)
    setTimeout(() => form.submit(), 0)
  }, values as unknown as Record<string, string>)
  // The refusal is a fresh document; waiting on a hook that does not exist on
  // `01` is what makes this wait for the navigation rather than race it.
  await expect(page.getByTestId("lead-error")).toBeVisible({ timeout: 15_000 })
}
