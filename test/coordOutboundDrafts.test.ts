import { describe, expect, it } from "vitest"

import {
  COORD_OUTBOUND_DRAFT_KINDS,
  MAX_OUTBOUND_DRAFTS_PUSH,
  isCoordOutboundDraftKind,
} from "../src/coordOutboundDrafts"

/**
 * Unit coverage for the pure, decidable parts of issue #318's coord-drafts
 * mirror (`src/coordOutboundDrafts.ts`). Everything that needs a real
 * database — the upsert guard that refuses to resurrect a decided draft, the
 * approve/reject race, the whole push-then-render-then-decide round trip — is
 * covered black-box in `e2e/outbound-drafts.spec.ts` against `wrangler dev`
 * with real D1, for the same reason `test/bridge.test.ts` gives for its own
 * split: a mocked D1 would only prove a stub does what it was written to do.
 */
describe("isCoordOutboundDraftKind", () => {
  it("accepts every kind coord may push", () => {
    for (const kind of COORD_OUTBOUND_DRAFT_KINDS) {
      expect(isCoordOutboundDraftKind(kind)).toBe(true)
    }
  })

  it("refuses a kind nobody pinned, or the wrong type entirely", () => {
    for (const value of ["draft", "DESIGN_ROUND", "design-round", "", null, undefined, 1, {}]) {
      expect(isCoordOutboundDraftKind(value)).toBe(false)
    }
  })
})

describe("MAX_OUTBOUND_DRAFTS_PUSH", () => {
  it("mirrors the bridge push ceiling — a Worker limit made visible, not a contract term", () => {
    expect(MAX_OUTBOUND_DRAFTS_PUSH).toBe(50)
  })
})
