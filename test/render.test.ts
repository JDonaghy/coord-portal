import { describe, expect, it } from "vitest"

import { operatorTopbar, page, publicHeader, publicPage, topbar } from "../src/render"

/**
 * Regression cover for the topbar's NARROW-VIEWPORT behaviour.
 *
 * This is a CSS assertion in a unit test, which normally would not be worth
 * writing — but the rule it pins is not cosmetic and its failure mode is
 * invisible from the outside. Issue #14 added a third nav link (`nav-outbox`)
 * to a header that was a nowrap flex row with no horizontal padding budget of
 * its own. On the e2e suite's Pixel 7 project (412 CSS px wide) that pushed
 * `document.scrollWidth` to 452 against a 412 `clientWidth`. Mobile Chrome
 * answers a document wider than device-width by scaling the whole page down,
 * and once page scale is not 1, the CSS-pixel coordinates a test computes for
 * a control and the screen coordinates its click actually lands on drift
 * apart: a click aimed at `submit-intake` landed ~70px high, on
 * `label[for=projectScope]`, so intake was never submitted and every
 * `[mobile]` spec that posts the intake form timed out.
 *
 * Amendment 1 (2026-09-02) changed the fix's shape, not its goal. Before the
 * amendment, `header.topbar` itself had to wrap because the identity span sat
 * in-flow, next to the nav links, and a long email plus a full link row could
 * not both fit un-wrapped on a phone. After the amendment, `identity-email`
 * lives inside `account-menu`'s panel, which is `position: absolute` — out of
 * `header.topbar`'s flow entirely while closed, contributing nothing to the
 * row's width. So the row itself no longer needs to wrap; what still has to
 * (and does) is the *nav*, whose own link count is exactly what varies
 * between a 9-link customer screen and a 5-link operator one — and the
 * identity span still needs to shrink and break mid-token once the panel
 * opens, the same load-bearing reason as before.
 *
 * Nothing in `e2e/` asserts "the document does not overflow sideways", so
 * deleting these declarations would go green everywhere except a real phone
 * and the mobile CI project. These are the fix; this test is the tripwire on
 * them.
 */
const TOPBAR_INVARIANTS: Array<[string, RegExp]> = [
  ["the nav wraps", /header\.topbar nav\s*\{[^}]*flex-wrap:\s*wrap/],
  // The account-menu panel must stay out of the header row's flow — this is
  // what lets `header.topbar` itself skip `flex-wrap` entirely now.
  [
    "the account-menu panel is taken out of flow",
    /header\.topbar \.account-menu \.account-menu-panel\s*\{[^}]*position:\s*absolute/,
  ],
  // A flex item's automatic minimum size is its min-content size, which for an
  // unbreakable token is the whole token — `min-width: 0` is what lets the
  // identity shrink at all, and `overflow-wrap: anywhere` is what gives it a
  // break opportunity inside an email address (which contains no space).
  [
    "the identity may shrink",
    /header\.topbar \.account-menu \.identity\s*\{[^}]*min-width:\s*0/,
  ],
  [
    "the identity may break mid-token",
    /header\.topbar \.account-menu \.identity\s*\{[^}]*overflow-wrap:\s*anywhere/,
  ],
]

describe("the shared page shell", () => {
  const shell = page("Any title", "<main></main>")

  it.each(TOPBAR_INVARIANTS)(
    "keeps the topbar inside a 412px viewport: %s",
    (_label, pattern) => {
      expect(shell).toMatch(pattern)
    },
  )

  it("never pins header.topbar itself to a literal nowrap — the row relies on the nav wrapping and the account-menu panel being out of flow instead", () => {
    expect(shell).not.toMatch(/header\.topbar\s*\{[^}]*flex-wrap:\s*nowrap/)
  })

  it("escapes the document title", () => {
    expect(page('a "quoted" <title>', "")).toContain(
      "<title>a &quot;quoted&quot; &lt;title&gt;</title>",
    )
  })
})

describe("topbar", () => {
  it("carries the five navigation hooks, outbox and account included", () => {
    const rendered = topbar("someone@example.test", "dashboard", false)
    for (const hook of [
      "brand-home",
      "nav-dashboard",
      "nav-new",
      "nav-outbox",
      "nav-account",
      "identity-email",
    ]) {
      expect(rendered).toContain(`data-testid="${hook}"`)
    }
  })

  it("marks exactly the current screen, including the outbox and account", () => {
    for (const [current, testid] of [
      ["dashboard", "nav-dashboard"],
      ["new", "nav-new"],
      ["outbox", "nav-outbox"],
      ["account", "nav-account"],
    ] as const) {
      const rendered = topbar("someone@example.test", current, false)
      expect(rendered).toContain(`data-testid="${testid}" aria-current="page"`)
      expect(rendered.match(/aria-current="page"/g)).toHaveLength(1)
    }
    expect(topbar("someone@example.test", "none", false)).not.toContain('aria-current="page"')
  })

  it("escapes the identity and names an absent one rather than rendering nothing", () => {
    expect(topbar("a<script>@example.test", "none", false)).toContain(
      "signed in as a&lt;script&gt;@example.test",
    )
    expect(topbar(null, "none", false)).toContain("signed in as unknown")
  })

  /**
   * Issue #103: sign-out reaches Cloudflare Access's own logout path, on
   * every screen this function renders — not conditioned on `isOperator` or
   * `current`, because there is no authenticated screen where "how do I stop
   * being signed in" should be unreachable.
   */
  it("always carries a sign-out link to Cloudflare Access's own logout path", () => {
    for (const isOperator of [false, true]) {
      const rendered = topbar("someone@example.test", "dashboard", isOperator)
      expect(rendered).toContain('data-testid="signout-link"')
      expect(rendered).toContain('href="/cdn-cgi/access/logout"')
    }
  })

  /**
   * Issue #103's merge: the customer links (My requests, New request, Sent
   * emails, My profile) render unconditionally, and the operator section
   * (Leads, Deliveries) is appended only when the caller says the viewer is
   * an operator — the one thing the issue calls "worth a test": a
   * non-operator customer must see no operator link at all, so the nav never
   * becomes a directory of surfaces a customer cannot open.
   */
  describe("the operator section", () => {
    it("is entirely absent for a non-operator", () => {
      const rendered = topbar("customer@example.test", "dashboard", false)
      expect(rendered).not.toContain('data-testid="nav-leads"')
      expect(rendered).not.toContain('data-testid="nav-deliveries"')
      expect(rendered).not.toContain(">Leads<")
      expect(rendered).not.toContain(">Deliveries<")
    })

    it("appends Leads and Deliveries, alongside the customer links, for an operator", () => {
      const rendered = topbar("operator@example.test", "leads", true)
      for (const hook of ["nav-dashboard", "nav-new", "nav-outbox", "nav-account", "nav-leads", "nav-deliveries"]) {
        expect(rendered).toContain(`data-testid="${hook}"`)
      }
    })

    it("marks the current operator screen, exclusive of every other nav entry", () => {
      const leads = topbar("operator@example.test", "leads", true)
      expect(leads).toContain('data-testid="nav-leads" aria-current="page"')
      expect(leads.match(/aria-current="page"/g)).toHaveLength(1)

      const deliveries = topbar("operator@example.test", "deliveries", true)
      expect(deliveries).toContain('data-testid="nav-deliveries" aria-current="page"')
      expect(deliveries.match(/aria-current="page"/g)).toHaveLength(1)
    })

    /**
     * Amendment 1 item 5: on the customer topbar the operator links append
     * to a nav that already carries customer links, so — unlike the
     * operator-only screens below — there really is something on the other
     * side of the divider here.
     */
    it("groups the appended operator links behind a divider and an 'Operator' label", () => {
      const rendered = topbar("operator@example.test", "dashboard", true)
      expect(rendered).toContain('data-testid="nav-group-divider"')
      expect(rendered).toContain('data-testid="nav-group-operator-label"')
      expect(rendered).toContain(">Operator<")

      const nonOperator = topbar("customer@example.test", "dashboard", false)
      expect(nonOperator).not.toContain('data-testid="nav-group-divider"')
      expect(nonOperator).not.toContain('data-testid="nav-group-operator-label"')
    })
  })
})

/**
 * Amendment 1 (2026-09-02) — the account menu that replaces the flat
 * `nav-account` / `identity-email` / `signout-link` on every authenticated
 * screen. `tests/acceptance/ms-4/contract.md` § "Account menu" is the
 * authority; these are the fast, unit-level tripwires next to the sealed
 * black-box slice.
 */
describe("account-menu (Amendment 1)", () => {
  it("shows initials — the first two characters of the email's local-part, uppercased", () => {
    for (const [email, initials] of [
      ["dana@example.test", "DA"],
      ["ops@example.test", "OP"],
      ["nadia.nav.131@example.test", "NA"],
    ] as const) {
      const rendered = topbar(email, "none", false)
      expect(rendered).toContain(`data-testid="account-menu"`)
      expect(rendered).toMatch(
        new RegExp(`data-testid="account-menu"[^>]*>${initials}</summary>`),
      )
    }
  })

  it("carries the accessible name and a static, closed-by-default aria-expanded", () => {
    const rendered = topbar("dana@example.test", "none", false)
    expect(rendered).toContain('aria-label="Account menu (dana@example.test)"')
    expect(rendered).toContain('aria-expanded="false"')
    expect(rendered).not.toContain("<details class=\"account-menu\" open>")
  })

  it("is a script-free <details>/<summary> disclosure — no <script> tag anywhere", () => {
    expect(topbar("dana@example.test", "none", false)).not.toContain("<script")
    expect(operatorTopbar("ops@example.test", "leads")).not.toContain("<script")
  })

  it("orders the customer panel identity-email, then nav-account, then signout-link", () => {
    const rendered = topbar("dana@example.test", "account", false)
    const panel = rendered.slice(rendered.indexOf('class="account-menu-panel"'))
    const identityAt = panel.indexOf('data-testid="identity-email"')
    const accountAt = panel.indexOf('data-testid="nav-account"')
    const signoutAt = panel.indexOf('data-testid="signout-link"')
    expect(identityAt).toBeGreaterThan(-1)
    expect(accountAt).toBeGreaterThan(identityAt)
    expect(signoutAt).toBeGreaterThan(accountAt)
  })

  it("omits nav-account from the operator panel — /account is a customer-gated route", () => {
    const rendered = operatorTopbar("ops@example.test", "leads")
    const panel = rendered.slice(rendered.indexOf('class="account-menu-panel"'))
    expect(panel).not.toContain('data-testid="nav-account"')
    expect(panel).toContain('data-testid="identity-email"')
    expect(panel).toContain('data-testid="signout-link"')
  })

  it("falls back to a placeholder for an unresolved identity rather than throwing", () => {
    const rendered = topbar(null, "none", false)
    expect(rendered).toContain('aria-label="Account menu (unknown)"')
  })
})

/**
 * `/leads` and `/deliveries` keep their own, unmerged header — see the long
 * comment on `topbar()` in `src/render.ts`. A first attempt at folding this
 * into `topbar()` broke the sealed acceptance oracles for ms-2 issue #33 and
 * ms-3 issue #55 (`expectOperatorTopbar` in each spec asserts, via
 * `toHaveCount(0)`, that these two screens carry none of the customer
 * topbar's hooks). The tests below pin exactly that absence at the unit
 * level, so a regression here is caught in under a second rather than only
 * once the sealed suite runs.
 */
describe("operatorTopbar", () => {
  it("carries the operator nav hooks, brand and identity", () => {
    const rendered = operatorTopbar("ops@example.test", "leads")
    for (const hook of ["brand-home", "nav-leads", "nav-deliveries", "identity-email"]) {
      expect(rendered).toContain(`data-testid="${hook}"`)
    }
  })

  it("carries none of the customer topbar's hooks — ms-2 #33 / ms-3 #55's sealed pin", () => {
    const rendered = operatorTopbar("ops@example.test", "leads")
    for (const hook of ["nav-dashboard", "nav-new", "nav-outbox", "nav-account"]) {
      expect(rendered).not.toContain(`data-testid="${hook}"`)
    }
  })

  it("marks exactly the current operator screen", () => {
    const leads = operatorTopbar("ops@example.test", "leads")
    expect(leads).toContain('data-testid="nav-leads" aria-current="page"')
    expect(leads.match(/aria-current="page"/g)).toHaveLength(1)

    const deliveries = operatorTopbar("ops@example.test", "deliveries")
    expect(deliveries).toContain('data-testid="nav-deliveries" aria-current="page"')
    expect(deliveries.match(/aria-current="page"/g)).toHaveLength(1)
  })

  it("still carries sign-out (issue #103) — the sealed oracles never assert its absence", () => {
    const rendered = operatorTopbar("ops@example.test", "deliveries")
    expect(rendered).toContain('data-testid="signout-link"')
    expect(rendered).toContain('href="/cdn-cgi/access/logout"')
  })

  /**
   * Amendment 1 item 5: every operator-only screen groups its five links
   * behind a divider and an "Operator" label, even though — per the
   * contract's own admission — there is nothing on the other side of the
   * divider on this unmerged header today.
   */
  it("groups the five operator links behind a divider and an 'Operator' label", () => {
    const rendered = operatorTopbar("ops@example.test", "leads")
    expect(rendered).toContain('data-testid="nav-group-divider"')
    expect(rendered).toContain('data-testid="nav-group-operator-label"')
    expect(rendered).toContain(">Operator<")
  })

  it("shares header.topbar, so it inherits the same wrapping rules", () => {
    expect(operatorTopbar("operator@example.test", "leads")).toContain('<header class="topbar">')
  })
})

describe("publicHeader", () => {
  it("shares header.topbar, so it inherits the same wrapping rules", () => {
    expect(publicHeader()).toContain('<header class="topbar">')
  })

  it("keeps the public header free of nav, identity and sign-out — issue #31/#41", () => {
    const rendered = publicHeader()
    expect(rendered).toContain('data-testid="brand-home"')
    expect(rendered).not.toContain('data-testid="identity-email"')
    expect(rendered).not.toContain('data-testid="signout-link"')
    expect(rendered).not.toContain("<nav")
  })
})

/**
 * Issue #41: `/start` used to be rendered with `page()`, which inlines the
 * WHOLE authenticated application's stylesheet — comments naming issues and
 * mock filenames included — because none of it renders and #31's DOM-level
 * acceptance slice reads `innerText()`, which cannot see a `<style>` block at
 * all. The fix is `publicPage()`: a second document shell wired to its own,
 * hand-picked sheet.
 *
 * The real oracle for "no engineer-side identifier reaches a stranger" is the
 * sealed black-box slice (`tests/acceptance/ms-2/41-public-body-hygiene.spec.ts`),
 * which asserts on the actual bytes `GET`/`POST /start` put on the wire behind
 * a running Worker. This is a cheap, fast tripwire next to it: a unit test
 * that fails in under a second if `publicPage()` is ever pointed back at
 * `page()`'s sheet, without paying for `wrangler dev` + Playwright to find
 * that out.
 */
describe("publicPage", () => {
  const shell = publicPage("Get in touch — coord-portal", "<main></main>")

  it("still links the shared token stylesheet", () => {
    expect(shell).toContain('<link rel="stylesheet" href="/tokens.css">')
  })

  it("never inlines a selector or comment naming an authenticated or operator screen", () => {
    const AUTHENTICATED_ONLY = [
      "ul.submission-list",
      "submission-detail",
      "lead-detail",
      ".lead-row",
      "leads-list",
      ".round-card",
      "access-seat-reminder",
      "delivery-pill",
      "outbox-list",
      "status-pill",
      "verdict-pill",
      "issue #13",
      "issue #33",
      "mocks/",
      ".html",
    ]
    for (const needle of AUTHENTICATED_ONLY) {
      expect(shell, `publicPage() must not ship "${needle}"`).not.toContain(needle)
    }
  })

  it("still carries every rule the public form and receipt actually use", () => {
    for (const selector of [
      "header.topbar",
      "form.lead",
      ".field",
      ".optional-tag",
      "button.primary",
      ".async-note",
      ".lead-error",
      ".receipt",
      "a.button",
    ]) {
      expect(shell, `publicPage() must still style ${selector}`).toContain(selector)
    }
  })

  it("escapes the document title, same as page()", () => {
    expect(publicPage('a "quoted" <title>', "")).toContain(
      "<title>a &quot;quoted&quot; &lt;title&gt;</title>",
    )
  })
})
