import { describe, expect, it } from "vitest"

import type { CoordOutboundDraft } from "../src/coordOutboundDrafts"
import { draftConsequence, matchRequestsPath, titleFromOutcome } from "../src/routes/requests"

/**
 * Unit coverage for issue #316's fix to `titleFromOutcome`
 * (`src/routes/requests.ts`) — the pure derivation behind `/requests`'s row
 * title. Before this fix it took the outcome's first line unconditionally,
 * so every email-intake submission (whose `outcome` is the customer's raw
 * message) titled its row with the salutation: a real submission
 * (`SUB-1BCFC3`) rendered as exactly `"Hi,"`.
 *
 * Black-box coverage of the row itself — that a real title renders, and is a
 * link — lives in `e2e/requests.spec.ts` per this repo's testing tiers; this
 * file pins the derivation's actual decision (which line, or fallback, wins)
 * the way `test/rounds.test.ts` pins `VERDICT_TEXT`'s own pure mappings.
 */
describe("titleFromOutcome", () => {
  it("skips a bare 'Hi,' greeting and titles the row with the real content", () => {
    const outcome =
      "Hi,\nYour name came up when I was asking around about getting something small built."
    expect(titleFromOutcome(outcome)).toBe(
      "Your name came up when I was asking around about getting something small built.",
    )
  })

  it("skips 'Hello,' the same way", () => {
    expect(titleFromOutcome("Hello,\nWe need a landing page refreshed before launch.")).toBe(
      "We need a landing page refreshed before launch.",
    )
  })

  it("skips a 'Hi there,' greeting with a name in it", () => {
    expect(titleFromOutcome("Hi there,\nCould you help us redesign our onboarding flow?")).toBe(
      "Could you help us redesign our onboarding flow?",
    )
  })

  it("skips a 'Dear <name>,' salutation", () => {
    expect(titleFromOutcome("Dear team,\nWe would like a quote for a new dashboard.")).toBe(
      "We would like a quote for a new dashboard.",
    )
  })

  it("falls back to a longer excerpt when every line reads as a greeting", () => {
    expect(titleFromOutcome("Hi,\nHello,")).toBe("Hi, Hello,")
  })

  it("falls back to a longer excerpt for an outcome that is only a greeting", () => {
    expect(titleFromOutcome("Hi,")).toBe("Hi,")
  })

  it("does not treat a real first line as a greeting just because it starts with a greeting word", () => {
    // Not a bare salutation: this line carries real content and ends in a
    // sentence-ending period, so it stays the title as-is.
    const outcome = "Hi, I run a small bakery and need a site that takes online orders."
    expect(titleFromOutcome(outcome)).toBe(outcome)
  })

  it("leaves a form-style outcome (no greeting) titled by its first line, unchanged", () => {
    const outcome = "A redesigned checkout flow for our storefront.\nMore detail on the next line."
    expect(titleFromOutcome(outcome)).toBe("A redesigned checkout flow for our storefront.")
  })

  it("truncates a long content line to 80 characters with an ellipsis", () => {
    const longLine = "A".repeat(120)
    expect(titleFromOutcome(`Hi,\n${longLine}`)).toBe(`${"A".repeat(79)}…`)
  })
})

/**
 * Unit coverage for issue #318's two new `/requests…` actions — "Approve &
 * send" / "Reject" on a coord-owned draft. Black-box coverage that a draft
 * actually renders and the round trip actually reaches coord lives in
 * `e2e/outbound-drafts.spec.ts` per this repo's testing tiers; this file
 * pins only the pure routing decision, the same way it already pins
 * `titleFromOutcome`'s.
 */
describe("matchRequestsPath — issue #318's draft actions", () => {
  it("extracts both the submission id and the draft id for approve", () => {
    expect(matchRequestsPath("/requests/sub_abc123/drafts/draft_xyz/approve")).toEqual({
      kind: "draft-approve",
      id: "sub_abc123",
      draftId: "draft_xyz",
    })
  })

  it("extracts both ids for reject", () => {
    expect(matchRequestsPath("/requests/sub_abc123/drafts/draft_xyz/reject")).toEqual({
      kind: "draft-reject",
      id: "sub_abc123",
      draftId: "draft_xyz",
    })
  })

  it("does not confuse a draft action with plain detail, reassign or rounds", () => {
    expect(matchRequestsPath("/requests/sub_abc123")).toEqual({ kind: "detail", id: "sub_abc123" })
    expect(matchRequestsPath("/requests/sub_abc123/reassign")).toEqual({
      kind: "reassign",
      id: "sub_abc123",
    })
    expect(matchRequestsPath("/requests/sub_abc123/rounds")).toEqual({
      kind: "rounds",
      id: "sub_abc123",
    })
  })

  it("refuses a drafts path with no action, or an unrecognised one", () => {
    for (const pathname of [
      "/requests/sub_abc123/drafts/draft_xyz",
      "/requests/sub_abc123/drafts/draft_xyz/",
      "/requests/sub_abc123/drafts//approve",
      "/requests/sub_abc123/drafts/draft_xyz/discard",
    ]) {
      expect(matchRequestsPath(pathname), pathname).toBeNull()
    }
  })
})

/**
 * Regression coverage for a review finding on issue #318:
 * `draftConsequence` used to key its "emails the customer" text off
 * `kind === "status"` alone, which is wrong for 5 of the 9 possible `status`
 * values — `src/notifications.ts`'s own `TYPE_FOR_STATUS` map sends an email
 * only for `awaiting-signoff`, `needs-input`, `shipped` and `quality-check`.
 * A `status` draft queued with e.g. `in-progress` would have rendered "this
 * emails the customer" even though approving it sends nothing — backwards
 * from issue #318's own stated goal of letting an operator tell "this
 * reaches her inbox" from "this only changes what the portal shows". This
 * pins the fix: the text now follows `sendTypeForStatus`, not the kind alone.
 */
function draft(kind: CoordOutboundDraft["kind"], fields: Record<string, string>): CoordOutboundDraft {
  return {
    id: "draft_xyz",
    submissionReference: "SUB-000000",
    kind,
    fields,
    queuedAt: "2026-01-01T00:00:00.000Z",
  }
}

describe("draftConsequence — issue #318's on-screen consequence text", () => {
  it("says a status draft emails the customer when the status value actually sends", () => {
    for (const status of ["awaiting-signoff", "needs-input", "shipped", "quality-check"]) {
      expect(draftConsequence(draft("status", { status }))).toBe(
        "Approving this emails the customer — the only kind of coord message that does.",
      )
    }
  })

  it("says a status draft does not email the customer for a non-sending status value", () => {
    for (const status of ["describing", "in-design", "planned", "in-progress", "on-hold"]) {
      expect(draftConsequence(draft("status", { status }))).toBe(
        "Approving this only changes what the portal shows. No email is sent.",
      )
    }
  })

  it("says no email is sent for every non-status kind, regardless of fields", () => {
    expect(draftConsequence(draft("design_round", { outcome_definition: "x" }))).toBe(
      "Approving this only changes what the portal shows. No email is sent.",
    )
    expect(draftConsequence(draft("question", { question: "x" }))).toBe(
      "Approving this only changes what the portal shows. No email is sent.",
    )
    expect(draftConsequence(draft("relayed_answer", { answer: "x" }))).toBe(
      "Approving this only changes what the portal shows. No email is sent.",
    )
    expect(draftConsequence(draft("preview", { preview_url: "https://example.test/preview" }))).toBe(
      "Approving this only changes what the portal shows. No email is sent.",
    )
  })

  it("treats a status draft with no status field as not sending, rather than throwing", () => {
    expect(draftConsequence(draft("status", {}))).toBe(
      "Approving this only changes what the portal shows. No email is sent.",
    )
  })
})
