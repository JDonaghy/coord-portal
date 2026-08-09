import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
} from "@playwright/test"

/**
 * ms-1 sealed acceptance slice — issue #12
 * "[portal] Auth — Cloudflare Access in front of Pages + Worker"
 *
 * Written from `tests/acceptance/ms-1/contract.md` and the header markup its
 * mocks pin, without sight of any implementation.
 *
 * SCOPE. Issue #12 puts Cloudflare Access in front of the portal and has the
 * Worker read the verified identity from the injected JWT, with **no
 * authentication code in the application**. Three things in that are black-box
 * observable from the customer side, and they are what this slice asserts:
 *
 *  1. The signed-in identity is *rendered* — the contract pins `identity-email`
 *     with text `signed in as {email}` in the header of **every authenticated
 *     screen**, and pins `GET /api/whoami` as the mechanism for reading it.
 *  2. There is **no self-serve signup**, and no application-level login at all.
 *     The issue calls this "the limit to record explicitly in the code and the
 *     docs"; from the outside it means the portal never renders a login form, a
 *     password field, or a create-an-account affordance, because Access —
 *     not the app — is the front door.
 *  3. "A customer can only ever see their own submissions." Contract note 4
 *     pins this as a black-box behavioural guarantee, explicitly assertable
 *     "via two distinct synthetic identities", and explicitly does *not* pin
 *     the session/query mechanism behind it. Every isolation test below is
 *     therefore written against rendered output, never against an inferred
 *     scoping parameter.
 *
 * NOT COVERED HERE, deliberately:
 *  - **The customer/engineer role split.** Issue #12 says it "also covers the
 *    role split (customer vs engineer)", but the contract pins no engineer
 *    route, no engineer screen, no role `data-testid` and no role vocabulary —
 *    `mocks/` contains customer screens only, and the pinned route surface has
 *    no engineer entry. There is nothing black-box to assert about an engineer
 *    view without inventing it, so this slice asserts only the half the
 *    contract does pin: that a customer identity never widens past its own
 *    submissions. See the TODO on "no query parameter widens the dashboard".
 *  - **The Access service token in front of `/api/bridge`.** That is pinned in
 *    the contract's sync-bridge section and already covered by issue #15's
 *    slice; duplicating it here would double-report one behaviour. The
 *    `/api/health` bypass — which the contract says "must never widen into a
 *    general bypass" — is asserted here, since it is an auth-boundary fact
 *    about the site application rather than about the bridge.
 *  - **Access's own federation (Google / GitHub / email OTP) and its login
 *    page.** Those run in Cloudflare's edge in front of the Worker. Nothing in
 *    this repo serves them and `npm run serve:acceptance` boots a bare
 *    `wrangler dev` with no Access in front of it, so no test here can drive
 *    them. That is the point of the design: the app has no auth code to test.
 *
 * IDENTITY MECHANISM. Local `wrangler dev` has no Cloudflare Access in front of
 * it, so the verified identity is supplied the way Access injects it in
 * production, via `Cf-Access-Authenticated-User-Email`. This is the same
 * position the peer slice `09-intake.spec.ts` already takes, and the contract's
 * screens all "assume a verified identity is already present".
 *
 * SYNTHETIC DATA. Per CLAUDE.md rule 1 and the contract's "Synthetic data"
 * section, every email, outcome and phrase below is invented.
 */

const ACCESS_HEADER = "Cf-Access-Authenticated-User-Email"

/** Contract: `identity-email` text = `signed in as {email}`, per the mocks' header. */
const signedInAs = (email: string) => `signed in as ${email}`

/** Contract: the customer-visible reference minted by the portal. */
const REFERENCE = /SUB-[A-Z0-9]{6}/

/**
 * Every test mints its own pair of synthetic identities, tagged with the test's
 * own slug. `serve:acceptance` wipes the database per *run*, not per test, so
 * distinct identities are what makes "this customer has exactly one submission"
 * a stable assertion rather than one that depends on test order.
 */
function identities(tag: string) {
  return {
    ada: `ada-${tag}@example.test`,
    bo: `bo-${tag}@example.test`,
  }
}

/** A browser context carrying one customer's injected Access identity. */
async function asCustomer(
  browser: Browser,
  baseURL: string | undefined,
  email: string,
): Promise<BrowserContext> {
  return browser.newContext({
    baseURL,
    extraHTTPHeaders: { [ACCESS_HEADER]: email },
  })
}

/** A browser context with no Access identity at all. */
async function asNobody(
  browser: Browser,
  baseURL: string | undefined,
): Promise<BrowserContext> {
  return browser.newContext({ baseURL })
}

interface Submission {
  url: string
  reference: string
  nonce: string
}

/**
 * Create one submission through the pinned intake form (#9's surface — the only
 * way this milestone lets a customer author a fact) and return the handles this
 * slice needs to check for leakage: the detail URL, the minted reference, and a
 * distinctive invented phrase planted in the outcome text.
 */
async function createSubmission(
  context: BrowserContext,
  nonce: string,
): Promise<Submission> {
  const page = await context.newPage()
  await page.goto("/intake")
  await page.getByTestId("field-outcome").fill(
    `A printable seed-swap roster for allotment members (${nonce}).`,
  )
  await page.getByTestId("field-audience").fill("our allotment committee")
  await page
    .getByTestId("field-done-definition")
    .fill("The roster prints on one page with every plot number listed once.")
  await page.getByTestId("submit-intake").click()

  await expect(page.getByTestId("intake-receipt")).toBeVisible()
  const referenceText = await page.getByTestId("submission-reference").innerText()
  const match = referenceText.match(REFERENCE)
  expect(
    match,
    `intake receipt should carry a SUB-XXXXXX reference, got: ${referenceText}`,
  ).not.toBeNull()

  const url = page.url()
  await page.close()
  return { url, reference: match![0], nonce }
}

/** The visible text of a whole screen, for leak assertions. */
async function bodyText(context: BrowserContext, url: string): Promise<string> {
  const page = await context.newPage()
  await page.goto(url)
  const text = await page.locator("body").innerText()
  await page.close()
  return text
}

/** Assert nothing of `owner`'s submission appears in `text`. */
function expectNoLeak(text: string, owner: Submission) {
  expect(text).not.toContain(owner.nonce)
  expect(text).not.toContain(owner.reference)
}

async function fetchText(
  request: APIRequestContext,
  path: string,
  email?: string,
): Promise<{ status: number; body: string }> {
  const response = await request.get(path, {
    headers: email ? { [ACCESS_HEADER]: email } : {},
    failOnStatusCode: false,
  })
  return { status: response.status(), body: await response.text() }
}

test.describe("ms-1 issue 12 access auth", () => {
  test("the signed-in identity comes from Cloudflare Access, not from a portal login", async ({
    browser,
    baseURL,
  }) => {
    const { ada } = identities("front-door")
    const context = await asCustomer(browser, baseURL, ada)
    const page = await context.newPage()
    await page.goto("/intake")

    // The injected identity is what the header renders — the app did not ask
    // for it and has no other way of knowing it.
    await expect(page.getByTestId("identity-email")).toHaveText(signedInAs(ada))

    // "No authentication code in the application" (issue #12; CLAUDE.md: the
    // Worker "does not implement login, sessions, or password handling"). From
    // the outside that is the absence of every login affordance.
    await expect(page.locator('input[type="password"]')).toHaveCount(0)
    await expect(
      page.getByRole("button", { name: /log ?in|sign ?in|sign ?up/i }),
    ).toHaveCount(0)
    await expect(
      page.locator('a[href*="/login"], a[href*="/signin"], a[href*="/sign-in"]'),
    ).toHaveCount(0)

    // The screen is fully usable without anything branching on `verified`,
    // which the contract notes is hard-coded `false` today: "nothing
    // customer-facing may branch on it being `true` yet".
    await expect(page.getByTestId("intake-form")).toBeVisible()
    await expect(page.getByTestId("submit-intake")).toBeEnabled()

    await context.close()
  })

  test("every authenticated screen names the signed-in customer", async ({
    browser,
    baseURL,
  }) => {
    const { ada } = identities("header")
    const context = await asCustomer(browser, baseURL, ada)
    const submission = await createSubmission(context, "ISO-HEADER-4417")

    // Contract: `identity-email` is global, "present in the header on every
    // authenticated screen". The pinned route surface's four authenticated
    // customer screens:
    // TODO(test-author): the contract does not pin what
    // `/submissions/:id/rounds` renders for a submission that has no design
    // round yet (a fresh `Describing` submission is the only state this slice
    // can reach black-box — publishing a round is #13). Only the global header
    // is asserted for that route here, not its body.
    const screens = [
      "/intake",
      "/submissions",
      submission.url,
      `${submission.url}/rounds`,
    ]

    for (const screen of screens) {
      const page = await context.newPage()
      await page.goto(screen)
      await expect(
        page.getByTestId("identity-email"),
        `identity-email should be in the header of ${screen}`,
      ).toHaveText(signedInAs(ada))
      await page.close()
    }

    await context.close()
  })

  test("the portal offers no self-serve signup", async ({
    browser,
    baseURL,
    request,
  }) => {
    // NB: the tag must not itself contain a word this test forbids — the
    // identity is rendered in the header of every screen it reads.
    const { ada } = identities("no-front-door")
    const context = await asCustomer(browser, baseURL, ada)

    // Issue #12: "Access does not do self-serve signup." A customer is
    // provisioned in the Access application, never by registering here.
    const noSignupCopy = [
      /create an account/i,
      /\bsign ?up\b/i,
      /\bregister\b/i,
      /forgot (your )?password/i,
    ]
    // NB: deliberately not a bare /password/ — a customer may legitimately ask
    // for a password feature (`mocks/03-dashboard.html` renders a submission
    // titled "Self-serve password reset"), so the word alone proves nothing.
    // The absence of an actual password *field* is asserted in the front-door
    // test instead.

    for (const screen of ["/intake", "/submissions"]) {
      const text = await bodyText(context, screen)
      for (const pattern of noSignupCopy) {
        expect(text, `${screen} should carry no signup copy`).not.toMatch(pattern)
      }
    }
    await context.close()

    // Nor is there an application-served registration route. The contract's
    // route surface is pinned and contains none of these.
    // TODO(test-author): the contract pins the route table but says nothing
    // about what an *unpinned* path returns — a static Pages site may serve a
    // shell for anything (contract note 5 leaves multi-page vs. client-side
    // routing open). So this asserts only that no signup surface is served
    // there, not a particular status code.
    for (const path of ["/login", "/signup", "/sign-up", "/register"]) {
      const { body } = await fetchText(request, path, ada)
      expect(body, `${path} should serve no password field`).not.toMatch(
        /<input[^>]+type=["']?password/i,
      )
      expect(body, `${path} should serve no signup form`).not.toMatch(
        /create an account|sign ?up now/i,
      )
    }
  })

  test("identity is read per request, with no portal session to hold it", async ({
    request,
  }) => {
    const { ada, bo } = identities("per-request")

    // One APIRequestContext, one cookie jar, two injected identities. Because
    // the app holds no session of its own, the answer must follow the header
    // that arrived — the first request must not "log in" the jar.
    const first = await fetchText(request, "/api/whoami", ada)
    expect(first.status).toBe(200)
    expect(first.body).toContain(ada)

    const second = await fetchText(request, "/api/whoami", bo)
    expect(second.status).toBe(200)
    expect(second.body).toContain(bo)
    expect(second.body).not.toContain(ada)

    // And dropping the identity drops the answer, rather than falling back to
    // whoever was seen last.
    const third = await fetchText(request, "/api/whoami")
    expect(third.body).not.toContain(ada)
    expect(third.body).not.toContain(bo)
  })

  test("whoami reports the same identity the screens render", async ({
    browser,
    baseURL,
    request,
  }) => {
    const { ada } = identities("whoami")

    // Contract: `GET /api/whoami` "is the existing mechanism for reading"
    // the verified identity. After #12 it must report the identity the rest of
    // the portal is scoping by — one source of truth, not two.
    const { status, body } = await fetchText(request, "/api/whoami", ada)
    expect(status).toBe(200)
    expect(body).toContain(ada)

    const context = await asCustomer(browser, baseURL, ada)
    const page = await context.newPage()
    await page.goto("/intake")
    await expect(page.getByTestId("identity-email")).toHaveText(signedInAs(ada))
    await context.close()

    // TODO(test-author): the contract names the `verified` field and records
    // that it is hard-coded `false` "until #1981 lands" (this issue), but it
    // does not pin what `verified` should report under `npm run
    // serve:acceptance`, which boots a bare `wrangler dev` with no Access in
    // front of it and therefore no JWT to verify. Asserting `verified === true`
    // here would be asserting a fact this harness cannot legitimately produce,
    // so it is left unasserted. The contract's live constraint — that nothing
    // customer-facing branches on it — is covered by the "front door" test.
    // The email *field name* in the whoami body is likewise unpinned, so this
    // matches the address anywhere in the response rather than at a key.
  })

  test("the dashboard lists only the caller's own submissions", async ({
    browser,
    baseURL,
  }) => {
    const { ada, bo } = identities("dashboard")
    const adaContext = await asCustomer(browser, baseURL, ada)
    const boContext = await asCustomer(browser, baseURL, bo)

    const adaFirst = await createSubmission(adaContext, "ISO-ADA-9902")
    const adaSecond = await createSubmission(adaContext, "ISO-ADA-9903")
    const boOnly = await createSubmission(boContext, "ISO-BO-3318")

    // Contract, route surface: `GET /submissions` is "the signed-in customer's
    // own submissions, and only their own (issue #12)".
    const boPage = await boContext.newPage()
    await boPage.goto("/submissions")
    await expect(boPage.getByTestId("identity-email")).toHaveText(signedInAs(bo))
    await expect(boPage.getByTestId("submission-row")).toHaveCount(1)

    const boText = await boPage.locator("body").innerText()
    expectNoLeak(boText, adaFirst)
    expectNoLeak(boText, adaSecond)
    // TODO(test-author): the contract pins `submission-row` and its
    // `data-status`, but pins no `data-testid` for the reference *inside* a
    // row; `mocks/03-dashboard.html` nonetheless renders `SUB-XXXXXX` in every
    // row's meta line, so the reference is matched as row text.
    expect(boText).toContain(boOnly.reference)
    await boPage.close()

    const adaPage = await adaContext.newPage()
    await adaPage.goto("/submissions")
    await expect(adaPage.getByTestId("submission-row")).toHaveCount(2)
    const adaText = await adaPage.locator("body").innerText()
    expectNoLeak(adaText, boOnly)
    expect(adaText).toContain(adaFirst.reference)
    expect(adaText).toContain(adaSecond.reference)
    await adaPage.close()

    await adaContext.close()
    await boContext.close()
  })

  test("one customer cannot open another customer's submission by URL", async ({
    browser,
    baseURL,
  }) => {
    const { ada, bo } = identities("detail")
    const adaContext = await asCustomer(browser, baseURL, ada)
    const boContext = await asCustomer(browser, baseURL, bo)

    const adaSubmission = await createSubmission(adaContext, "ISO-DETAIL-5140")

    // Issue #12: "making sure a customer can only ever see their own
    // submissions" — knowing the URL is not authorisation.
    // TODO(test-author): the contract pins neither a status code nor any copy
    // for this refusal (note 4 pins the behaviour only, "without pinning how it
    // is implemented"), so 404-vs-403-vs-redirect is deliberately not asserted.
    // What is asserted is the part that cannot be read two ways: none of the
    // other customer's material renders.
    const text = await bodyText(boContext, adaSubmission.url)
    expectNoLeak(text, adaSubmission)
    expect(text).not.toContain(ada)

    // Ada's own read of the same URL still works — the refusal is scoping, not
    // an outage.
    const ownText = await bodyText(adaContext, adaSubmission.url)
    expect(ownText).toContain(adaSubmission.reference)

    await adaContext.close()
    await boContext.close()
  })

  test("one customer cannot read another customer's round history", async ({
    browser,
    baseURL,
  }) => {
    const { ada, bo } = identities("rounds")
    const adaContext = await asCustomer(browser, baseURL, ada)
    const boContext = await asCustomer(browser, baseURL, bo)

    const adaSubmission = await createSubmission(adaContext, "ISO-ROUNDS-6621")

    // `/submissions/:id/rounds` is a second door onto the same record; the
    // contract's guarantee is about the submission, not about one route.
    const page = await boContext.newPage()
    await page.goto(`${adaSubmission.url}/rounds`)
    await expect(
      page.getByTestId("round-entry"),
      "no round of another customer's submission may render",
    ).toHaveCount(0)
    const text = await page.locator("body").innerText()
    expectNoLeak(text, adaSubmission)
    expect(text).not.toContain(ada)
    await page.close()

    // Positive control, so the assertions above cannot pass merely because the
    // route does not exist: the owner reaches her own round history, and the
    // contract's global header renders there.
    const ownPage = await adaContext.newPage()
    await ownPage.goto(`${adaSubmission.url}/rounds`)
    await expect(ownPage.getByTestId("identity-email")).toHaveText(signedInAs(ada))
    await ownPage.close()

    await adaContext.close()
    await boContext.close()
  })

  test("a request with no Access identity gets no customer data", async ({
    browser,
    baseURL,
    request,
  }) => {
    const { ada } = identities("anonymous")
    const adaContext = await asCustomer(browser, baseURL, ada)
    const adaSubmission = await createSubmission(adaContext, "ISO-ANON-7734")
    await adaContext.close()

    // In production Access refuses these at the edge and the Worker never sees
    // them. Locally there is no Access, so this pins the invariant that
    // survives either way: an unidentified caller is never served a customer's
    // material.
    // TODO(test-author): the contract does not pin what an identity-less
    // request receives (a 302 to the Access login, a 401, or an empty shell are
    // all consistent with it), so no status code is asserted.
    const nobody = await asNobody(browser, baseURL)
    for (const url of ["/submissions", adaSubmission.url]) {
      const text = await bodyText(nobody, url)
      expectNoLeak(text, adaSubmission)
      expect(text).not.toContain(ada)
    }
    await nobody.close()

    // Same at the transport level, in case the screens render client-side.
    for (const path of ["/submissions", new URL(adaSubmission.url).pathname]) {
      const { body } = await fetchText(request, path)
      expect(body).not.toContain(adaSubmission.nonce)
      expect(body).not.toContain(adaSubmission.reference)
      expect(body).not.toContain(ada)
    }
  })

  test("the health check is the only unauthenticated bypass", async ({ request }) => {
    const { ada } = identities("bypass")

    // The contract requires an Access bypass for `/api/health` and warns that
    // "that path must never widen into a general bypass".
    const health = await fetchText(request, "/api/health")
    expect(health.status).toBe(200)
    expect(health.body).not.toMatch(REFERENCE)
    expect(health.body).not.toContain("@example.test")

    // The neighbouring identity route gets no share of that bypass: with no
    // identity it must not report a verified one.
    const whoami = await fetchText(request, "/api/whoami")
    expect(whoami.body).not.toContain(ada)
    expect(whoami.body).not.toMatch(/"verified"\s*:\s*true/)
  })

  test("no query parameter widens the dashboard past the caller", async ({
    browser,
    baseURL,
  }) => {
    const { ada, bo } = identities("widen")
    const adaContext = await asCustomer(browser, baseURL, ada)
    const boContext = await asCustomer(browser, baseURL, bo)

    const adaSubmission = await createSubmission(adaContext, "ISO-WIDEN-8850")
    await createSubmission(boContext, "ISO-BO-WIDEN-8851")

    // The half of issue #12's "role split (customer vs engineer)" that IS
    // black-box assertable: a customer identity must never be able to ask for
    // more than its own scope.
    // TODO(test-author): the contract pins no query parameters at all on
    // `/submissions`, so this cannot enumerate the real ones — it probes the
    // shapes a scoping bug would most plausibly take. Each assertion is
    // negative (nothing of Ada's may render), so an implementation that simply
    // ignores unknown parameters passes.
    const probes = [
      `/submissions?email=${encodeURIComponent(ada)}`,
      `/submissions?customer=${encodeURIComponent(ada)}`,
      `/submissions?user=${encodeURIComponent(ada)}`,
      "/submissions?all=1",
      "/submissions?role=engineer",
      `/submissions?submission=${adaSubmission.reference}`,
    ]

    for (const probe of probes) {
      const page = await boContext.newPage()
      await page.goto(probe)
      await expect(
        page.getByTestId("identity-email"),
        `${probe} must not change who is signed in`,
      ).toHaveText(signedInAs(bo))
      const text = await page.locator("body").innerText()
      expect(text, `${probe} must not widen past the caller`).not.toContain(
        adaSubmission.nonce,
      )
      expect(text, `${probe} must not widen past the caller`).not.toContain(
        adaSubmission.reference,
      )
      await page.close()
    }

    await adaContext.close()
    await boContext.close()
  })
})
