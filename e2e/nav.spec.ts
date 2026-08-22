import { expect, test, type Browser, type Page } from "@playwright/test"

/**
 * Black-box coverage for issue #103 ([portal] No way to sign out, and the
 * operator and customer navs cannot reach each other), driving the real
 * Worker under `wrangler dev` — see `playwright.config.ts`. This is the
 * project's own `e2e/` tier, not the sealed acceptance suite under
 * `tests/acceptance/`; per CLAUDE.md this repo still ships its own black-box
 * coverage for behaviour-changing work.
 *
 * SCOPE. Two things, both fixed in `src/render.ts`'s single `topbar()`:
 *
 *   1. Every screen behind Access carries a sign-out link
 *      (`signout-link`, `href="/cdn-cgi/access/logout"`) — Cloudflare Access
 *      owns the session, so this repo cannot black-box-test that following
 *      the link actually ends one (there is no real Access in front of
 *      `wrangler dev`); what this suite CAN and does assert is that the
 *      control exists, everywhere it needs to, with the exact href Access
 *      documents for team-domain logout.
 *   2. The customer nav (My requests, New request, Sent emails, My profile)
 *      and the operator nav (Leads, Deliveries) now share one header: an
 *      operator sees both, without typing a URL, and — "the part worth a
 *      test" per the issue — a non-operator customer sees no operator link
 *      at all.
 *
 * `/start` is deliberately untouched (issue #41) and out of scope here —
 * `e2e/start.spec.ts` already pins that no authenticated-portal hook,
 * `signout-link` included, leaks onto it.
 *
 * Every string below is invented — see CLAUDE.md rule 1.
 *
 * ── WRITTEN FOR A SHARED, ACCUMULATING DATABASE ────────────────────────────
 * `serve:test` does not wipe `.wrangler/state` between runs and the suite is
 * `fullyParallel`, so every assertion below is scoped to a nonce this test
 * minted (a unique customer email) rather than counting rows globally. The
 * one exception is the operator identity itself, `DEV_OPERATOR` — see
 * `DEV_OPERATOR_EMAIL` in `src/operators.ts` — which is shared across every
 * spec in this suite by construction (there is only one local dev fallback);
 * nothing here asserts anything about the *count* of rows an operator screen
 * shows, only about which nav hooks are present.
 */

const ACCESS_HEADER = "Cf-Access-Authenticated-User-Email"

/** The operator identity `wrangler dev` honours when `OPERATOR_EMAILS` is unset. */
const DEV_OPERATOR = "ops@example.test"

const LOGOUT_HREF = "/cdn-cgi/access/logout"

const CUSTOMER_NAV_HOOKS = ["nav-dashboard", "nav-new", "nav-outbox", "nav-account"]
const OPERATOR_NAV_HOOKS = ["nav-leads", "nav-deliveries"]

function nonce(): string {
  return Math.random().toString(36).slice(2, 10)
}

function uniqueEmail(local: string): string {
  return `${local}-${nonce()}@example.test`
}

async function contextFor(browser: Browser, baseURL: string | undefined, email: string) {
  return browser.newContext({ baseURL, extraHTTPHeaders: { [ACCESS_HEADER]: email } })
}

async function expectSignOut(page: Page) {
  const signOut = page.getByTestId("signout-link")
  await expect(signOut).toBeVisible()
  await expect(signOut).toHaveAttribute("href", LOGOUT_HREF)
}

test.describe("a non-operator customer's nav", () => {
  test("carries sign-out and every customer link, but no operator link, on every authenticated screen it owns", async ({
    page,
  }) => {
    const email = uniqueEmail("e2e-nav-customer")
    await page.setExtraHTTPHeaders({ [ACCESS_HEADER]: email })

    for (const path of ["/submissions", "/intake", "/outbox", "/account"]) {
      await page.goto(path)
      await expect(page.getByTestId("identity-email")).toHaveText(`signed in as ${email}`)

      for (const hook of CUSTOMER_NAV_HOOKS) {
        await expect(page.getByTestId(hook)).toHaveCount(1)
      }
      // The part issue #103 calls "worth a test": a non-operator must see no
      // operator link at all — the nav must not become a directory of
      // surfaces this customer cannot open.
      for (const hook of OPERATOR_NAV_HOOKS) {
        await expect(page.getByTestId(hook)).toHaveCount(0)
      }
      await expect(page.getByText("Leads", { exact: true })).toHaveCount(0)
      await expect(page.getByText("Deliveries", { exact: true })).toHaveCount(0)

      await expectSignOut(page)
    }
  })

  test("/leads and /deliveries stay closed to a non-operator, same 404 as before this issue", async ({
    page,
  }) => {
    const email = uniqueEmail("e2e-nav-customer-refused")
    await page.setExtraHTTPHeaders({ [ACCESS_HEADER]: email })

    for (const path of ["/leads", "/deliveries"]) {
      const response = await page.goto(path)
      expect(response?.status()).toBe(404)
    }
  })
})

test.describe("an operator's nav", () => {
  test("reaches every customer and operator surface from any authenticated screen, with sign-out everywhere", async ({
    browser,
    baseURL,
  }) => {
    const context = await contextFor(browser, baseURL, DEV_OPERATOR)
    const page = await context.newPage()

    for (const [path, currentHook] of [
      ["/submissions", "nav-dashboard"],
      ["/intake", "nav-new"],
      ["/outbox", "nav-outbox"],
      ["/account", "nav-account"],
      ["/leads", "nav-leads"],
      ["/deliveries", "nav-deliveries"],
    ] as const) {
      await page.goto(path)
      await expect(page.getByTestId("identity-email")).toHaveText(`signed in as ${DEV_OPERATOR}`)

      // Every customer link AND every operator link, on every one of these
      // screens — including the two operator-only ones, which used to show
      // only Leads/Deliveries before this issue merged the two headers.
      for (const hook of [...CUSTOMER_NAV_HOOKS, ...OPERATOR_NAV_HOOKS]) {
        await expect(page.getByTestId(hook)).toHaveCount(1)
      }
      await expect(page.getByTestId(currentHook)).toHaveAttribute("aria-current", "page")
      // Exactly one nav entry is ever "current".
      await expect(page.locator('[aria-current="page"]')).toHaveCount(1)

      await expectSignOut(page)
    }

    await context.close()
  })

  test("clicking Leads from a customer screen, and My requests from an operator screen, actually navigates — no URL typed", async ({
    browser,
    baseURL,
  }) => {
    const context = await contextFor(browser, baseURL, DEV_OPERATOR)
    const page = await context.newPage()

    await page.goto("/submissions")
    await page.getByTestId("nav-leads").click()
    await expect(page).toHaveURL(/\/leads$/)
    await expect(page.getByTestId("nav-leads")).toHaveAttribute("aria-current", "page")

    await page.getByTestId("nav-dashboard").click()
    await expect(page).toHaveURL(/\/submissions$/)
    await expect(page.getByTestId("nav-dashboard")).toHaveAttribute("aria-current", "page")

    await context.close()
  })
})
