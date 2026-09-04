import { describe, expect, it } from "vitest"

import { shippedResultSection } from "../src/routes/submission"
import type { Submission } from "../src/submissions"

/**
 * Unit coverage for `shippedResultSection` (issue #307) — the one pure
 * function on the shipped screen's rendering path, same split
 * `test/messages.test.ts` documents for `messageAuthorLabel`: everything
 * else `shippedDetail` touches (loading lifecycle events, the message
 * thread) needs a real D1 database and is covered black-box in `e2e/`.
 *
 * The bug this guards: `href="#"` was copied verbatim out of the Gate-A
 * mock into the implementation. A static mock's placeholder is not a value
 * a customer-facing template may ever render — see CLAUDE.md and the
 * function's own doc comment.
 *
 * Every string below is invented — see CLAUDE.md rule 1.
 */

function submission(overrides: Partial<Submission> = {}): Submission {
  return {
    id: "sub_000001",
    reference: "SUB-000001",
    status: "shipped",
    customerEmail: "customer@example.test",
    outcome: "A printable watering rota for the community greenhouse.",
    audience: "Saturday volunteers",
    doneDefinition: "Anyone on shift can see which beds are due without asking.",
    constraints: null,
    projectScope: null,
    createdAt: "2026-01-01T00:00:00Z",
    coordRevision: 3,
    projectId: null,
    previewUrl: null,
    ...overrides,
  }
}

describe("shippedResultSection", () => {
  it("links to the known result URL", () => {
    const html = shippedResultSection(
      submission({ previewUrl: "https://rota.example.test/preview/abc123" }),
    )
    expect(html).toContain('data-testid="shipped-link"')
    expect(html).toContain('href="https://rota.example.test/preview/abc123"')
  })

  it("never renders href=\"#\", even with a URL that could be mistaken for one", () => {
    const html = shippedResultSection(submission({ previewUrl: "https://example.test/#" }))
    expect(html).not.toContain('href="#"')
  })

  it("escapes a URL that carries HTML-significant characters", () => {
    const html = shippedResultSection(
      submission({ previewUrl: 'https://example.test/?a=1&b="x"' }),
    )
    expect(html).not.toContain('&b="x"')
    expect(html).toContain("&amp;b=")
  })

  it("renders no button, and no href=\"#\", when there is no known URL", () => {
    const html = shippedResultSection(submission({ previewUrl: null }))
    expect(html).not.toContain("data-testid=\"shipped-link\"")
    expect(html).not.toContain('href="#"')
    expect(html).not.toContain("<a ")
  })

  it("renders explanatory text in place of the missing button", () => {
    const html = shippedResultSection(submission({ previewUrl: null }))
    expect(html).toContain('data-testid="shipped-link-unavailable"')
    expect(html.trim().length).toBeGreaterThan(0)
  })
})
