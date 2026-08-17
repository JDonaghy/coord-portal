import { describe, expect, it } from "vitest"

import { PREVIEW_VERDICTS, derivedQualityCheckStatus } from "../src/previewReviews"

/**
 * Unit coverage for the decidable part of issue #107's pre-merge preview
 * gate: `derivedQualityCheckStatus`, the pure derivation `src/routes/submission.ts`
 * uses to decide what a `quality-check` submission actually shows.
 *
 * A verdict actually landing in `preview_reviews`, surviving a replayed
 * submit, and emitting exactly one `preview.approved` / `preview.changes_requested`
 * bridge event are covered black-box against real D1 in `e2e/preview-review.spec.ts`
 * — the same split `test/rounds.test.ts` draws for the design-round loop's
 * `recordSignoff`, and for the same reason: a mocked D1 here would only prove
 * the stub does what this file told it to do.
 */

describe("derivedQualityCheckStatus", () => {
  it("passes every stored status but quality-check straight through", () => {
    expect(derivedQualityCheckStatus("in-progress", null)).toBe("in-progress")
    expect(derivedQualityCheckStatus("shipped", { verdict: "approved" })).toBe("shipped")
  })

  it("stays at quality-check while nobody has reviewed the current preview yet", () => {
    expect(derivedQualityCheckStatus("quality-check", null)).toBe("quality-check")
  })

  it("stays at quality-check on approval — the operator's merge is a separate, manual step", () => {
    expect(derivedQualityCheckStatus("quality-check", { verdict: "approved" })).toBe("quality-check")
  })

  it("returns to In progress when changes were requested", () => {
    expect(derivedQualityCheckStatus("quality-check", { verdict: "changes-requested" })).toBe(
      "in-progress",
    )
  })
})

describe("the pinned preview verdict vocabulary", () => {
  it("is exactly approved / changes-requested — the same two the sign-off loop uses", () => {
    expect([...PREVIEW_VERDICTS]).toEqual(["approved", "changes-requested"])
  })
})
