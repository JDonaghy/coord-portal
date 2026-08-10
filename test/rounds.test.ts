import { describe, expect, it } from "vitest"

import { resolveBundleKey } from "../src/routes/mocks"
import {
  ROUND_VERDICTS,
  VERDICT_TEXT,
  asBundle,
  asItems,
  derivedStatus,
  readRoundPatch,
  scrubEngineerIdentifiers,
} from "../src/rounds"

/**
 * Unit coverage for the decidable parts of the design-round loop (issue #13):
 * the wall that keeps engineer-side identifiers off a customer screen, the
 * liberal reader for coord's unpinned `design_round` payload, the status
 * derivation that lets the loop return to `In design` without the portal ever
 * writing a coord-owned field, and the R2 key resolver.
 *
 * The parts that need a real database — a round materialising from a bridge
 * push, a verdict landing exactly once, round N staying untouched while N+1
 * opens — are covered black-box in `e2e/design-rounds.spec.ts` against
 * `wrangler dev` with real D1, because a mocked D1 would only prove the stub
 * does what I wrote it to do.
 *
 * Every string below is invented — see CLAUDE.md rule 1.
 */

describe("scrubEngineerIdentifiers", () => {
  it("leaves plain customer-facing language exactly as it is", () => {
    const item = "A CSV upload step with a preview before anything is saved"
    expect(scrubEngineerIdentifiers(item)).toBe(item)
  })

  it("removes issue and PR cross-references", () => {
    expect(scrubEngineerIdentifiers("Column mapping for headers (#412)")).toBe(
      "Column mapping for headers",
    )
    expect(scrubEngineerIdentifiers("Blocked on issue 88 for now")).toBe("Blocked on for now")
    expect(scrubEngineerIdentifiers("See owner/repo#77 for context")).toBe("See for context")
  })

  it("removes branch names and agent identifiers", () => {
    expect(scrubEngineerIdentifiers("Ship on feat/csv-import")).toBe("Ship on")
    expect(scrubEngineerIdentifiers("Landed from issue-13-design-rounds")).toBe("Landed from")
    expect(scrubEngineerIdentifiers("Handed to agent-carla for the second pass")).toBe(
      "Handed to for the second pass",
    )
  })

  it("removes a link straight into the engineer's world", () => {
    expect(
      scrubEngineerIdentifiers("Details at https://github.com/example/repo/pull/9 if needed"),
    ).toBe("Details at if needed")
  })

  it("leaves no orphaned brackets or doubled spaces behind", () => {
    expect(scrubEngineerIdentifiers("A results screen (#901) listing failures")).not.toMatch(
      /\(\s*\)|\s{2}/,
    )
  })
})

describe("asItems", () => {
  it("reads an array of strings", () => {
    expect(asItems(["One step", "Another step"])).toEqual(["One step", "Another step"])
  })

  it("reads an array of objects by any of the usual title keys", () => {
    expect(asItems([{ title: "Upload step" }, { name: "Mapping step" }, { text: "Report step" }])).toEqual(
      ["Upload step", "Mapping step", "Report step"],
    )
  })

  it("reads a newline-separated string, bullets and all", () => {
    expect(asItems("- Upload step\n* Mapping step\n1. Report step")).toEqual([
      "Upload step",
      "Mapping step",
      "Report step",
    ])
  })

  it("scrubs each item, and drops one that was nothing but an identifier", () => {
    expect(asItems(["Upload step (#12)", "#99"])).toEqual(["Upload step"])
  })

  it("distinguishes 'coord said nothing' from 'coord said none'", () => {
    expect(asItems(undefined)).toBeNull()
    expect(asItems(null)).toBeNull()
    expect(asItems([])).toEqual([])
  })
})

describe("asBundle", () => {
  it("reads a bare string, an object and an array", () => {
    expect(asBundle("rounds/SUB-000001/2/index.html")).toBe("rounds/SUB-000001/2/index.html")
    expect(asBundle({ url: "https://mocks.example.test/two" })).toBe("https://mocks.example.test/two")
    expect(asBundle([{ href: "https://mocks.example.test/first" }])).toBe(
      "https://mocks.example.test/first",
    )
  })

  it("is null when there is nothing to link to", () => {
    expect(asBundle(undefined)).toBeNull()
    expect(asBundle("   ")).toBeNull()
    expect(asBundle({ unrelated: 1 })).toBeNull()
  })
})

describe("readRoundPatch", () => {
  it("says nothing about a round when the push does not mention one", () => {
    expect(readRoundPatch({ status: "in-progress" })).toBeNull()
  })

  it("reads a whole round out of one design_round object", () => {
    const patch = readRoundPatch({
      status: "awaiting-signoff",
      design_round: {
        round: 2,
        outcome_definition: "Let an admin import contacts from a CSV.",
        decomposition: ["Upload with a preview", "Column mapping"],
        mock_bundle: "https://mocks.example.test/round-2",
      },
    })
    expect(patch).toEqual({
      round: 2,
      outcomeDefinition: "Let an admin import contacts from a CSV.",
      decomposition: ["Upload with a preview", "Column mapping"],
      mockBundle: "https://mocks.example.test/round-2",
    })
  })

  it("reads a design_round pushed as a bare outcome definition", () => {
    expect(readRoundPatch({ design_round: "Let an admin import contacts." })).toEqual({
      round: null,
      outcomeDefinition: "Let an admin import contacts.",
      decomposition: null,
      mockBundle: null,
    })
  })

  it("lets the sibling coord-owned fields win — they are the more specific statement", () => {
    const patch = readRoundPatch({
      design_round: { outcome_definition: "An outcome.", decomposition: ["from the round object"] },
      decomposition: ["from the decomposition field"],
      artifacts: { url: "https://mocks.example.test/round-1" },
    })
    expect(patch?.decomposition).toEqual(["from the decomposition field"])
    expect(patch?.mockBundle).toBe("https://mocks.example.test/round-1")
  })

  it("reads a decomposition pushed on its own", () => {
    const patch = readRoundPatch({ decomposition: ["A single work item"] })
    expect(patch).not.toBeNull()
    expect(patch?.decomposition).toEqual(["A single work item"])
    expect(patch?.outcomeDefinition).toBeNull()
  })

  it("scrubs engineer-side identifiers before they can reach a round", () => {
    const patch = readRoundPatch({
      design_round: { outcome_definition: "x", decomposition: ["Ship the importer (#412)"] },
    })
    expect(patch?.decomposition).toEqual(["Ship the importer"])
  })
})

describe("derivedStatus", () => {
  it("passes every stored status but awaiting-signoff straight through", () => {
    expect(derivedStatus("in-design", null)).toBe("in-design")
    expect(derivedStatus("shipped", { round: 1, verdict: "approved" })).toBe("shipped")
  })

  it("stays at awaiting-signoff while the round is undecided", () => {
    expect(derivedStatus("awaiting-signoff", null)).toBe("awaiting-signoff")
    expect(derivedStatus("awaiting-signoff", { round: 2, verdict: "pending" })).toBe(
      "awaiting-signoff",
    )
  })

  it("returns to In design when changes were requested", () => {
    expect(derivedStatus("awaiting-signoff", { round: 2, verdict: "changes-requested" })).toBe(
      "in-design",
    )
  })

  it("moves past sign-off toward Planned on approval", () => {
    expect(derivedStatus("awaiting-signoff", { round: 2, verdict: "approved" })).toBe("planned")
  })
})

describe("the pinned verdict vocabulary", () => {
  it("is exactly pending / approved / changes-requested", () => {
    expect([...ROUND_VERDICTS]).toEqual(["pending", "approved", "changes-requested"])
  })

  it("gives every verdict customer-visible text", () => {
    for (const verdict of ROUND_VERDICTS) {
      expect(VERDICT_TEXT[verdict].length).toBeGreaterThan(0)
    }
  })
})

describe("resolveBundleKey", () => {
  it("serves a single-document bundle, and its siblings, from beside it", () => {
    expect(resolveBundleKey("rounds/SUB-000001/2/index.html", "")).toBe(
      "rounds/SUB-000001/2/index.html",
    )
    expect(resolveBundleKey("rounds/SUB-000001/2/index.html", "tokens.css")).toBe(
      "rounds/SUB-000001/2/tokens.css",
    )
  })

  it("treats an extension-less key as a prefix with an index", () => {
    expect(resolveBundleKey("rounds/SUB-000001/2", "")).toBe("rounds/SUB-000001/2/index.html")
    expect(resolveBundleKey("rounds/SUB-000001/2/", "detail.html")).toBe(
      "rounds/SUB-000001/2/detail.html",
    )
  })

  it("refuses to climb out of the bundle rather than normalising the attempt away", () => {
    expect(resolveBundleKey("rounds/SUB-000001/2", "../../other/index.html")).toBeNull()
    expect(resolveBundleKey("../secrets", "")).toBeNull()
    expect(resolveBundleKey("", "")).toBeNull()
  })
})
