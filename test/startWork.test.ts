import { describe, expect, it } from "vitest"

import { derivedStartWorkStatus } from "../src/startWork"

/**
 * Unit coverage for the decidable part of issue #132's operator "start work"
 * override: `derivedStartWorkStatus`, the pure derivation
 * `src/routes/submission.ts`, `src/routes/dashboard.ts` and
 * `src/routes/leads.ts` all use to decide what a submission the override has
 * touched actually shows.
 *
 * The override actually being recorded, surviving a doubled or concurrent
 * POST, and publishing exactly one `signoff.approved` bridge event are
 * covered black-box against real D1 in `e2e/start-work.spec.ts` — the same
 * split `test/previewReviews.test.ts` draws for `recordPreviewReview`, and for
 * the same reason: a mocked D1 here would only prove the stub does what this
 * file told it to do.
 */
describe("derivedStartWorkStatus", () => {
  it("passes every stored status but describing straight through", () => {
    expect(derivedStartWorkStatus("in-progress", { startedAt: "2026-08-01T00:00:00.000Z" })).toBe(
      "in-progress",
    )
    expect(derivedStartWorkStatus("shipped", { startedAt: "2026-08-01T00:00:00.000Z" })).toBe(
      "shipped",
    )
    expect(derivedStartWorkStatus("awaiting-signoff", { startedAt: "2026-08-01T00:00:00.000Z" })).toBe(
      "awaiting-signoff",
    )
  })

  it("stays at describing while the override has never been used", () => {
    expect(derivedStartWorkStatus("describing", null)).toBe("describing")
  })

  it("derives planned once the override has been used, while still stored at describing", () => {
    expect(derivedStartWorkStatus("describing", { startedAt: "2026-08-01T00:00:00.000Z" })).toBe(
      "planned",
    )
  })
})
