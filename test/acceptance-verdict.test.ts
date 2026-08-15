import { describe, expect, it } from "vitest"

import { buildVerdict, loadExpectedRed, parsePlaywrightReport, VerdictError } from "../scripts/acceptance-verdict.mjs"

// Issue #87: CI had no concept of `expected_red`, so every JIT test-author
// slice — deliberately red against unimplemented work, by design — was an
// unmergeable PR. These tests pin the verdict script's four-way semantics
// (mirrored from `coord.acceptance.apply_expected_red` in
// claude-coordinator) directly, without going through a real Playwright run
// or GitHub Actions.

const FILE = "ms-1/84-front-door.spec.ts"

function playwrightReport(specs: unknown[], opts: { errors?: unknown[] } = {}) {
  return JSON.stringify({
    suites: [
      {
        // Playwright's outer, per-file suite: title === file exactly (see
        // _playwright_specs' is_file_suite check) — that's what makes the
        // reader skip it from the id's describe path, since the file is
        // already carried separately.
        title: FILE,
        file: FILE,
        specs: [],
        suites: [
          {
            title: "ms-1 issue 84 front door",
            file: FILE,
            specs,
          },
        ],
      },
    ],
    ...(opts.errors ? { errors: opts.errors } : {}),
  })
}

function spec(title: string, status: "expected" | "unexpected" | "flaky" | "skipped") {
  return {
    title,
    file: FILE,
    tests: [{ projectName: "chromium", status, results: [] }],
  }
}

describe("parsePlaywrightReport", () => {
  it("builds ids matching the manifest's `[project] file › describe › title` shape", () => {
    const tests = parsePlaywrightReport(playwrightReport([spec("passes", "expected")]))
    expect(tests).toEqual([
      {
        id: "[chromium] ms-1/84-front-door.spec.ts › ms-1 issue 84 front door › passes",
        status: "pass",
      },
    ])
  })

  it("maps unexpected -> fail, flaky -> pass, skipped -> skip", () => {
    const tests = parsePlaywrightReport(
      playwrightReport([spec("a", "unexpected"), spec("b", "flaky"), spec("c", "skipped")]),
    )
    expect(tests.map((t) => t.status)).toEqual(["fail", "pass", "skip"])
  })

  it("throws on an empty report — a run that crashed before writing anything", () => {
    expect(() => parsePlaywrightReport("")).toThrow(VerdictError)
  })

  it("throws on unparseable JSON — a truncated or corrupted write", () => {
    expect(() => parsePlaywrightReport("{not json")).toThrow(VerdictError)
  })

  it("throws on a report missing the suites list entirely", () => {
    expect(() => parsePlaywrightReport(JSON.stringify({ config: {} }))).toThrow(VerdictError)
  })

  it("throws on zero tests with a top-level error — a path filter or globalSetup crash, not an empty-but-fine run", () => {
    expect(() =>
      parsePlaywrightReport(playwrightReport([], { errors: [{ message: "browserType.launch failed" }] })),
    ).toThrow(VerdictError)
  })

  it("does not throw on zero tests with no top-level error (Playwright's own --pass-with-no-tests case)", () => {
    expect(parsePlaywrightReport(playwrightReport([]))).toEqual([])
  })
})

describe("loadExpectedRed", () => {
  it("reads the issues -> [ids] shape into a flat id -> issue map", () => {
    const yaml = `
expected_red:
  84:
    - "id-a"
    - "id-b"
`
    const map = loadExpectedRed(yaml, "manifest.yml")
    expect(map.get("id-a")).toBe(84)
    expect(map.get("id-b")).toBe(84)
    expect(map.size).toBe(2)
  })

  it("returns an empty map when there is no expected_red block at all", () => {
    expect(loadExpectedRed("issues:\n  9:\n    - \"id-a\"\n", "manifest.yml").size).toBe(0)
  })

  it("ignores an issue entry whose value isn't a list, rather than raising", () => {
    const map = loadExpectedRed("expected_red:\n  84: \"not-a-list\"\n", "manifest.yml")
    expect(map.size).toBe(0)
  })

  it("ignores a non-integer issue key, rather than raising", () => {
    const map = loadExpectedRed('expected_red:\n  not-a-number:\n    - "id-a"\n', "manifest.yml")
    expect(map.size).toBe(0)
  })

  it("throws on a manifest that isn't valid YAML at all", () => {
    expect(() => loadExpectedRed("issues:\n  9: [\n", "manifest.yml")).toThrow(VerdictError)
  })
})

describe("buildVerdict", () => {
  const registered = new Map([
    ["red-1", 84],
    ["red-2", 84],
  ])

  it("is green when every failure is registered and nothing else is wrong (PR #85's shape)", () => {
    const v = buildVerdict(
      [
        { id: "red-1", status: "fail" },
        { id: "red-2", status: "fail" },
        { id: "control", status: "pass" },
      ],
      registered,
    )
    expect(v.ciGreen).toBe(true)
    expect(v.realFailures).toEqual([])
  })

  it("fails on a failure that is NOT registered — the property that must not regress", () => {
    const v = buildVerdict([{ id: "surprise", status: "fail" }], registered)
    expect(v.ciGreen).toBe(false)
    expect(v.realFailures.map((t) => t.id)).toEqual(["surprise"])
  })

  it("fails when a registered id unexpectedly PASSES — stale registration or vacuous assertion", () => {
    const v = buildVerdict(
      [
        { id: "red-1", status: "pass" },
        { id: "red-2", status: "fail" },
      ],
      registered,
    )
    expect(v.ciGreen).toBe(false)
    expect(v.unexpectedGreen).toEqual(["red-1"])
  })

  it("fails when a registered id never appears in the run — renamed or deleted test draining the registry", () => {
    const v = buildVerdict([{ id: "red-1", status: "fail" }], registered)
    expect(v.ciGreen).toBe(false)
    expect(v.missingExpectedRedIds).toEqual(["red-2"])
  })

  it("is not green on zero tests even with an empty registry — no silent pass on nothing run", () => {
    const v = buildVerdict([], new Map())
    expect(v.ciGreen).toBe(false)
  })

  it("is green on an all-pass run with no registry at all — the ordinary, non-JIT-slice case", () => {
    const v = buildVerdict([{ id: "a", status: "pass" }], new Map())
    expect(v.ciGreen).toBe(true)
  })

  // Issue #92: unexpected-green fails the fix PR itself, since a JIT slice's
  // clauses passing is exactly what its own fix PR succeeding looks like.
  // `strict` is the caller-supplied context switch for that one arm — every
  // other arm (real failures, missing expected_red) must keep failing the
  // verdict regardless.
  describe("strict option (issue #92)", () => {
    it("defaults to strict when no options are passed at all — the bare call must keep today's behavior", () => {
      const v = buildVerdict([{ id: "red-1", status: "pass" }], registered)
      expect(v.ciGreen).toBe(false)
      expect(v.unexpectedGreen).toEqual(["red-1"])
    })

    it("strict: true fails on unexpected-green, same as the default (the default-branch case)", () => {
      const v = buildVerdict([{ id: "red-1", status: "pass" }], registered, { strict: true })
      expect(v.ciGreen).toBe(false)
    })

    it("strict: false does not fail on unexpected-green, but still reports the ids (the pull-request case)", () => {
      // red-2 must still show up (registered but not yet fixed) so this
      // exercises exactly the unexpected-green arm, with nothing missing.
      const v = buildVerdict(
        [
          { id: "red-1", status: "pass" },
          { id: "red-2", status: "fail" },
        ],
        registered,
        { strict: false },
      )
      expect(v.ciGreen).toBe(true)
      expect(v.unexpectedGreen).toEqual(["red-1"])
    })

    it("strict: false still fails on a real (unregistered) failure — only the unexpected-green arm bends", () => {
      const v = buildVerdict(
        [
          { id: "red-1", status: "pass" },
          { id: "red-2", status: "fail" },
          { id: "surprise", status: "fail" },
        ],
        registered,
        { strict: false },
      )
      expect(v.ciGreen).toBe(false)
      expect(v.realFailures.map((t) => t.id)).toEqual(["surprise"])
    })

    it("strict: false still fails when an expected_red id is missing from the run entirely", () => {
      const v = buildVerdict([{ id: "red-1", status: "pass" }], registered, { strict: false })
      expect(v.ciGreen).toBe(false) // red-1 unexpectedly green (fine, lenient) but red-2 is missing entirely
      expect(v.missingExpectedRedIds).toEqual(["red-2"])
    })

    it("strict: false is still not green on zero tests — leniency never masks an empty run", () => {
      const v = buildVerdict([], new Map(), { strict: false })
      expect(v.ciGreen).toBe(false)
    })
  })
})
