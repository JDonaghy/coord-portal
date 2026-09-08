import { describe, expect, it } from "vitest"

import type { CoordOutboundDraft } from "../src/coordOutboundDrafts"
import {
  applyRequestsFilter,
  draftConsequence,
  matchRequestsPath,
  NO_CLIENT_EMAIL_KEY,
  resolveRequestsFilter,
  surveyBadge,
  titleFromOutcome,
  type RequestRow,
} from "../src/routes/requests"

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

/**
 * Unit coverage for issue #323's client/project filter — the pure
 * derivations `resolveRequestsFilter` and `applyRequestsFilter`
 * (`src/routes/requests.ts`), which take and return plain `RequestRow[]` so
 * this file can fabricate rows directly rather than exercising
 * `listAllRequestRows`'s D1 query. Black-box coverage that the `<select>`s
 * actually render, submit and round-trip through a reload lives in
 * `e2e/requests.spec.ts`, per this repo's testing tiers — this file pins
 * only the filtering and option-building decisions themselves, the same
 * split `titleFromOutcome`'s own coverage above already draws.
 *
 * Every address and project id below is invented, on the reserved
 * `example.test` TLD (CLAUDE.md rule 1) — this file has no D1 to seed
 * against, but the convention is worth keeping regardless.
 */
function row(overrides: Partial<RequestRow> & Pick<RequestRow, "id" | "reference" | "title">): RequestRow {
  return {
    customerEmail: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    display: "describing",
    round: null,
    projectId: null,
    survey: null,
    ...overrides,
  }
}

describe("resolveRequestsFilter — issue #323's client and project options", () => {
  it("defaults to 'All clients'/'All projects' when nothing is on the query string", () => {
    const rows = [
      row({ id: "1", reference: "SUB-000001", title: "A", customerEmail: "alice@example.test" }),
      row({ id: "2", reference: "SUB-000002", title: "B", customerEmail: "bob@example.test" }),
    ]
    const filter = resolveRequestsFilter(rows, null, null)
    expect(filter.client).toBeNull()
    expect(filter.project).toBeNull()
  })

  it("lists every client with at least one submission, sorted by label, 'All clients' still separate", () => {
    const rows = [
      row({ id: "1", reference: "SUB-000001", title: "A", customerEmail: "Carol@example.test" }),
      row({ id: "2", reference: "SUB-000002", title: "B", customerEmail: "alice@example.test" }),
      // A repeat customer contributes no second option.
      row({ id: "3", reference: "SUB-000003", title: "C", customerEmail: "alice@example.test" }),
      row({ id: "4", reference: "SUB-000004", title: "D", customerEmail: "Bob@example.test" }),
    ]
    const filter = resolveRequestsFilter(rows, null, null)
    expect(filter.clientOptions.map((option) => option.label)).toEqual([
      "alice@example.test",
      "Bob@example.test",
      "Carol@example.test",
    ])
  })

  it("gives a row with no customer_email its own 'no email on file' client option", () => {
    const rows = [
      row({ id: "1", reference: "SUB-000001", title: "A", customerEmail: null }),
      row({ id: "2", reference: "SUB-000002", title: "B", customerEmail: "alice@example.test" }),
    ]
    const filter = resolveRequestsFilter(rows, null, null)
    expect(filter.clientOptions).toContainEqual({ value: NO_CLIENT_EMAIL_KEY, label: "no email on file" })

    const selected = resolveRequestsFilter(rows, NO_CLIENT_EMAIL_KEY, null)
    expect(selected.client).toBe(NO_CLIENT_EMAIL_KEY)
    expect(applyRequestsFilter(rows, selected).map((r) => r.id)).toEqual(["1"])
  })

  it("with 'All clients' chosen, lists every project across every client", () => {
    const rows = [
      row({ id: "1", reference: "SUB-000001", title: "Alpha", customerEmail: "alice@example.test", projectId: "proj_a" }),
      row({ id: "2", reference: "SUB-000002", title: "Beta", customerEmail: "bob@example.test", projectId: "proj_b" }),
    ]
    const filter = resolveRequestsFilter(rows, null, null)
    expect(filter.projectOptions.map((option) => option.value).sort()).toEqual(["proj_a", "proj_b"])
  })

  it("picking a client narrows the project list to that client's own projects", () => {
    const rows = [
      row({ id: "1", reference: "SUB-000001", title: "Alpha", customerEmail: "alice@example.test", projectId: "proj_a" }),
      row({ id: "2", reference: "SUB-000002", title: "Beta", customerEmail: "bob@example.test", projectId: "proj_b" }),
    ]
    const filter = resolveRequestsFilter(rows, "alice@example.test", null)
    expect(filter.projectOptions).toEqual([{ value: "proj_a", label: "Alpha" }])
  })

  it("labels a project option with its newest submission's title, for an unnamed project's several members", () => {
    // rows are newest-created-first, the same order listAllRequestRows's own
    // `ORDER BY created_at DESC` produces — the first sighting of a project
    // id is therefore always its newest submission.
    const rows = [
      row({ id: "2", reference: "SUB-000002", title: "Newest outcome line", customerEmail: "alice@example.test", projectId: "proj_a" }),
      row({ id: "1", reference: "SUB-000001", title: "Older outcome line", customerEmail: "alice@example.test", projectId: "proj_a" }),
    ]
    const filter = resolveRequestsFilter(rows, null, null)
    expect(filter.projectOptions).toEqual([{ value: "proj_a", label: "Newest outcome line" }])
  })

  it("honours an unrecognised client verbatim rather than silently discarding the filter", () => {
    // Deliberately not reset to "All clients": issue #323's empty-result
    // sentence ("No requests for …") needs a real, honoured filter value to
    // name — see `resolveRequestsFilter`'s own doc comment for why this is
    // the one field that is not validated against its own option list.
    const rows = [row({ id: "1", reference: "SUB-000001", title: "A", customerEmail: "alice@example.test" })]
    const filter = resolveRequestsFilter(rows, "stranger@example.test", null)
    expect(filter.client).toBe("stranger@example.test")
    expect(applyRequestsFilter(rows, filter)).toEqual([])
  })

  it("resets a now-impossible client/project pair rather than leaving it selected", () => {
    const rows = [
      row({ id: "1", reference: "SUB-000001", title: "Alpha", customerEmail: "alice@example.test", projectId: "proj_a" }),
      row({ id: "2", reference: "SUB-000002", title: "Beta", customerEmail: "bob@example.test", projectId: "proj_b" }),
    ]
    // proj_b belongs to bob, not alice — switching the client filter to
    // alice while a stale ?project=proj_b survives on the query string (the
    // single <form> resubmits both selects together) must not silently
    // filter to zero rows.
    const filter = resolveRequestsFilter(rows, "alice@example.test", "proj_b")
    expect(filter.client).toBe("alice@example.test")
    expect(filter.project).toBeNull()
  })

  it("hides down to a single project option once a client is picked whose rows share one project", () => {
    const rows = [
      row({ id: "1", reference: "SUB-000001", title: "Alpha", customerEmail: "alice@example.test", projectId: "proj_a" }),
      row({ id: "2", reference: "SUB-000002", title: "Alpha follow-up", customerEmail: "alice@example.test", projectId: "proj_a" }),
    ]
    const filter = resolveRequestsFilter(rows, "alice@example.test", null)
    // requestsFilterForm only renders the <select> once this exceeds 1 — see
    // that function's own doc comment.
    expect(filter.projectOptions).toHaveLength(1)
  })

  it("contributes no project option for a client whose submissions have no project at all", () => {
    const rows = [row({ id: "1", reference: "SUB-000001", title: "A", customerEmail: "alice@example.test", projectId: null })]
    const filter = resolveRequestsFilter(rows, "alice@example.test", null)
    expect(filter.projectOptions).toEqual([])
  })
})

/**
 * Unit coverage for issue #329's "the rating on the request row" —
 * `surveyBadge` (`src/routes/requests.ts`), the pure derivation behind that
 * badge. Black-box coverage that it actually renders in the right place on a
 * real page lives in `e2e/requests.spec.ts`; this file pins only the
 * decision itself, the same split every other pure derivation in this file
 * already draws.
 *
 * The issue's own emphasis — "the point of the view is knowing which
 * customers were unhappy *and* which never said" — is exactly what these
 * three cases pin: nothing before shipped, an explicit "Not answered" once
 * shipped with no response, and the actual rating once one exists. Losing
 * any of those three to one shared fallback is the bug the issue describes.
 */
describe("surveyBadge — issue #329", () => {
  it("renders nothing for a submission that has not shipped yet", () => {
    const notShipped = row({
      id: "1",
      reference: "SUB-000001",
      title: "A",
      display: "in-progress",
      survey: null,
    })
    expect(surveyBadge(notShipped)).toBe("")
  })

  it("says plainly when a shipped submission has no response, rather than rendering nothing", () => {
    const unanswered = row({
      id: "1",
      reference: "SUB-000001",
      title: "A",
      display: "shipped",
      survey: null,
    })
    const markup = surveyBadge(unanswered)
    expect(markup).toContain('data-testid="request-survey"')
    expect(markup).toContain('data-answered="false"')
    expect(markup).toContain("Not answered")
  })

  it("renders the customer's actual rating once shipped and answered", () => {
    const answered = row({
      id: "1",
      reference: "SUB-000001",
      title: "A",
      display: "shipped",
      survey: { rating: 5, comment: "Exactly what we needed.", createdAt: "2026-02-01T00:00:00.000Z" },
    })
    const markup = surveyBadge(answered)
    expect(markup).toContain('data-testid="request-survey"')
    expect(markup).toContain('data-answered="true"')
    expect(markup).toContain('data-rating="5"')
    expect(markup).not.toContain("Not answered")
  })
})

describe("applyRequestsFilter — issue #323", () => {
  const rows = [
    row({ id: "1", reference: "SUB-000001", title: "Alpha", customerEmail: "alice@example.test", projectId: "proj_a" }),
    row({ id: "2", reference: "SUB-000002", title: "Loose", customerEmail: "alice@example.test", projectId: null }),
    row({ id: "3", reference: "SUB-000003", title: "Beta", customerEmail: "bob@example.test", projectId: "proj_b" }),
  ]

  it("returns every row unchanged for 'All clients' + 'All projects' — today's behaviour, exactly", () => {
    const filter = resolveRequestsFilter(rows, null, null)
    expect(applyRequestsFilter(rows, filter)).toEqual(rows)
  })

  it("narrows to one client's rows, project-less rows included", () => {
    const filter = resolveRequestsFilter(rows, "alice@example.test", null)
    expect(applyRequestsFilter(rows, filter).map((r) => r.id)).toEqual(["1", "2"])
  })

  it("narrows to one project's rows, excluding that client's project-less rows", () => {
    const filter = resolveRequestsFilter(rows, "alice@example.test", "proj_a")
    expect(applyRequestsFilter(rows, filter).map((r) => r.id)).toEqual(["1"])
  })

  it("narrows to one project across 'All clients' too", () => {
    const filter = resolveRequestsFilter(rows, null, "proj_b")
    expect(applyRequestsFilter(rows, filter).map((r) => r.id)).toEqual(["3"])
  })
})
