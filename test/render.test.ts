import { describe, expect, it } from "vitest"

import { operatorTopbar, page, publicHeader, topbar } from "../src/render"

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
 * Nothing in `e2e/` asserts "the document does not overflow sideways", so
 * deleting `flex-wrap` here would go green everywhere except a real phone and
 * the mobile CI project. These four declarations are the fix; this test is the
 * tripwire on them.
 */
const TOPBAR_INVARIANTS: Array<[string, RegExp]> = [
  ["the header itself wraps", /header\.topbar\s*\{[^}]*flex-wrap:\s*wrap/],
  ["the nav wraps", /header\.topbar nav\s*\{[^}]*flex-wrap:\s*wrap/],
  // A flex item's automatic minimum size is its min-content size, which for an
  // unbreakable token is the whole token — `min-width: 0` is what lets the
  // identity shrink at all, and `overflow-wrap: anywhere` is what gives it a
  // break opportunity inside an email address (which contains no space).
  ["the identity may shrink", /header\.topbar \.identity\s*\{[^}]*min-width:\s*0/],
  [
    "the identity may break mid-token",
    /header\.topbar \.identity\s*\{[^}]*overflow-wrap:\s*anywhere/,
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

  it("never lets the topbar be a nowrap row again", () => {
    expect(shell).not.toMatch(/header\.topbar\s*\{[^}]*flex-wrap:\s*nowrap/)
  })

  it("escapes the document title", () => {
    expect(page('a "quoted" <title>', "")).toContain(
      "<title>a &quot;quoted&quot; &lt;title&gt;</title>",
    )
  })
})

describe("topbar", () => {
  it("carries the four navigation hooks, outbox included", () => {
    const rendered = topbar("someone@example.test", "dashboard")
    for (const hook of ["brand-home", "nav-dashboard", "nav-new", "nav-outbox", "identity-email"]) {
      expect(rendered).toContain(`data-testid="${hook}"`)
    }
  })

  it("marks exactly the current screen, including the outbox", () => {
    for (const [current, testid] of [
      ["dashboard", "nav-dashboard"],
      ["new", "nav-new"],
      ["outbox", "nav-outbox"],
    ] as const) {
      const rendered = topbar("someone@example.test", current)
      expect(rendered).toContain(`data-testid="${testid}" aria-current="page"`)
      expect(rendered.match(/aria-current="page"/g)).toHaveLength(1)
    }
    expect(topbar("someone@example.test", "none")).not.toContain('aria-current="page"')
  })

  it("escapes the identity and names an absent one rather than rendering nothing", () => {
    expect(topbar('a<script>@example.test', "none")).toContain(
      "signed in as a&lt;script&gt;@example.test",
    )
    expect(topbar(null, "none")).toContain("signed in as unknown")
  })
})

describe("the other two headers", () => {
  it("share header.topbar, so they inherit the same wrapping rules", () => {
    expect(publicHeader()).toContain('<header class="topbar">')
    expect(operatorTopbar("operator@example.test", "leads")).toContain('<header class="topbar">')
  })

  it("keeps the public header free of nav and identity", () => {
    const rendered = publicHeader()
    expect(rendered).toContain('data-testid="brand-home"')
    expect(rendered).not.toContain("data-testid=\"identity-email\"")
    expect(rendered).not.toContain("<nav")
  })
})
