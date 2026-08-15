#!/usr/bin/env node
// The sealed acceptance job's real gate (issue #87).
//
// A JIT `test-author` slice is *deliberately* red against work that hasn't
// been done yet — that's the entire point of a slice, and it registers
// exactly which ids it measured red in its manifest's `expected_red:` block
// (see tests/acceptance/README.md and the header comment of any
// `tests/acceptance/ms-N/manifest.yml`). Until this script existed, nothing
// in this repo's CI read that block: `npm run test:acceptance` is Playwright
// directly, Playwright exits 1 on any failure, and the PR was unmergeable —
// by construction, on every slice, forever. scripts/assert-acceptance-ran.mjs
// (issue #77) already guards the OTHER false-green (a path filter matching
// zero specs); this is its opposite-direction sibling: a false RED for ids
// the manifest says are expected to fail right now.
//
// This is deliberately the same input assert-acceptance-ran.mjs already
// reads (the `json` reporter's acceptance-results.json — see
// .github/workflows/ci.yml) and it must be run on EVERY matrix leg, same as
// that guard: Playwright's own exit code stops being authoritative the
// moment this script exists, so if this script is ever accidentally
// skipped, a genuinely broken suite goes green again. See the workflow
// comment on the "Run sealed acceptance suite" step for how the two compose
// (`continue-on-error` on Playwright, this script as the real gate).
//
// Mirrors `coord.acceptance.apply_expected_red` in claude-coordinator
// (coord/acceptance.py, #2164) test-for-test, with one deliberate scoping
// difference: `coord acceptance run --all --ci` runs the WHOLE suite
// unsharded, so it merges every ms-N manifest's `expected_red:` block into
// one flat mapping. This repo's CI shards by milestone (issue #81 — one
// `wrangler dev` per milestone instead of one 4.4-minute run), so each
// matrix leg's Playwright process only ever sees ITS OWN milestone's specs.
// Merging every manifest here would make another milestone's expected_red
// ids look "missing" on every leg that isn't theirs — a false failure this
// script exists to avoid, not cause. So this script is scoped to the one
// manifest matching the milestone it's given, and the CI verdict is
// equivalent to `coord acceptance run --all --ci`'s scoped to that
// milestone's own tests. Everything else — the four-way verdict below — is
// unchanged from coord's semantics.
//
// The verdict, precisely, for one matrix leg's `id -> status` results
// against its milestone's `expected_red` registry:
//
//   failing id NOT in expected_red     -> job fails (a real regression —
//                                          this must not regress, #87)
//   failing id IN expected_red         -> fine; this is the whole point
//   passing id IN expected_red         -> job fails (the registration is
//                                          stale, or the assertion never
//                                          exercised the bug at all — the
//                                          #1965 vacuous-assertion case)
//   expected_red id absent from the
//   run entirely                       -> job fails (a renamed or deleted
//                                          test must not silently drain the
//                                          registry)
//
// Fails closed on a missing, empty, or unparseable results file, or one
// whose top-level `errors` fired before any test ran (a thrown
// `globalSetup`, a `--grep`/path filter matching nothing at the Playwright
// level) — exactly the posture scripts/assert-acceptance-ran.mjs already
// takes for the zero-test case, deliberately duplicated rather than shared:
// this script must be correct standing alone, since it is the one whose
// exit code the job now actually depends on.
import { existsSync, readFileSync } from "node:fs"
import { parse as parseYaml } from "yaml"

// -- Playwright json-report -> normalized {id, status} -----------------
//
// Ports `coord.acceptance_drivers.parse_playwright_json_report` /
// `_playwright_specs` / `_playwright_spec_entries` (claude-coordinator,
// coord/acceptance_drivers.py) closely enough that the two produce
// identical ids for identical reports — verified against this repo's own
// `tests/acceptance/*/manifest.yml`, whose ids were authored against that
// Python driver's output. This port only needs pass/fail/skip for the gate
// decision, so it drops the message-text extraction the Python driver keeps
// for `coord acceptance run`'s human-facing output.

const PLAYWRIGHT_STATUS = {
  expected: "pass",
  flaky: "pass",
  unexpected: "fail",
  skipped: "skip",
}

export class VerdictError extends Error {}

/** One {id, status} entry per (spec, project) pair in the report, walking
 * every suite depth-first. Throws VerdictError on a report shape this
 * reader doesn't recognize, or on a well-formed, zero-test report whose
 * top-level `errors` fired (a crashed run must never read as "nothing to
 * check"). */
export function parsePlaywrightReport(reportText) {
  const text = (reportText ?? "").trim()
  if (!text) {
    throw new VerdictError(
      "acceptance-results.json is empty — the run crashed before writing a report",
    )
  }

  let report
  try {
    report = JSON.parse(text)
  } catch (e) {
    throw new VerdictError(`acceptance-results.json is not valid JSON (truncated or corrupted run?): ${e.message}`)
  }

  if (!report || typeof report !== "object" || !Array.isArray(report.suites)) {
    throw new VerdictError("acceptance-results.json has an unrecognized shape (missing a 'suites' list)")
  }

  const tests = []
  for (const suite of report.suites) {
    if (suite && typeof suite === "object") tests.push(...specsFromSuite(suite, []))
  }

  if (tests.length === 0 && report.errors && (!Array.isArray(report.errors) || report.errors.length > 0)) {
    const first = Array.isArray(report.errors) ? report.errors[0] : report.errors
    const detail = first && typeof first === "object" ? (first.message ?? "") : String(first)
    throw new VerdictError(
      `acceptance run produced zero tests and reported a top-level error (bad config, browser launch failure, or a run matching no tests): ${detail}`,
    )
  }

  return tests
}

function specsFromSuite(suite, ancestors) {
  const title = suite.title ?? ""
  const isFileSuite = Boolean(suite.file) && title === suite.file
  const path = isFileSuite ? ancestors : [...ancestors, title]

  const tests = []
  for (const spec of suite.specs ?? []) {
    if (spec && typeof spec === "object") tests.push(...specEntries(spec, path))
  }
  for (const sub of suite.suites ?? []) {
    if (sub && typeof sub === "object") tests.push(...specsFromSuite(sub, path))
  }
  return tests
}

function specEntries(spec, ancestors) {
  const specTitle = spec.title ?? ""
  const titlePath = specTitle ? [...ancestors, specTitle].join(" › ") : ancestors.join(" › ")
  const file = spec.file ?? ""

  const entries = []
  for (const t of spec.tests ?? []) {
    if (!t || typeof t !== "object") continue
    const project = t.projectName ?? ""
    const id = project ? `[${project}] ${file} › ${titlePath}` : `${file} › ${titlePath}`
    const status = PLAYWRIGHT_STATUS[t.status] ?? "fail"
    entries.push({ id, status })
  }
  return entries
}

// -- manifest's `expected_red:` block -> id -> issue number -------------
//
// Ports the `expected_red` half of `coord.acceptance.parse_manifest_text`.
// A malformed `expected_red:` block (not a mapping, an issue whose value
// isn't a list, an unparseable issue number) degrades that ONE entry to
// "not expected-red" rather than raising — same "fail toward the stricter,
// ordinary-CI behavior" rule the Python parser documents, because an
// authoring slip in the registry must never widen what CI accepts.

/** Returns a Map<id, issueNumber> from *manifestText*'s `expected_red:`
 * block. Throws VerdictError if the manifest doesn't parse as YAML at all
 * (a genuinely broken manifest is a hard stop, not silent degradation). */
export function loadExpectedRed(manifestText, source) {
  let raw
  try {
    raw = parseYaml(manifestText)
  } catch (e) {
    throw new VerdictError(`failed to parse manifest ${source}: ${e.message}`)
  }

  const expectedRed = new Map()
  const block = raw?.expected_red
  if (!block || typeof block !== "object" || Array.isArray(block)) return expectedRed

  for (const [issue, ids] of Object.entries(block)) {
    if (!Array.isArray(ids)) continue
    const issueNum = Number(issue)
    if (!Number.isInteger(issueNum)) continue
    for (const id of ids) expectedRed.set(String(id), issueNum)
  }
  return expectedRed
}

// -- the verdict itself ---------------------------------------------------

/** Applies the four-way expected_red verdict (see file header) to *tests*
 * (`[{id, status}]`, `status` one of "pass"/"fail"/"skip") against
 * *expectedRed* (`Map<id, issueNumber>`). */
export function buildVerdict(tests, expectedRed) {
  const seen = new Set(tests.map((t) => t.id))
  const unexpectedGreen = []
  const expectedRedStillRed = []
  const realFailures = []

  for (const t of tests) {
    const isExpectedRed = expectedRed.has(t.id)
    if (t.status === "pass" && isExpectedRed) unexpectedGreen.push(t.id)
    if (t.status === "fail" && isExpectedRed) expectedRedStillRed.push(t.id)
    if (t.status === "fail" && !isExpectedRed) realFailures.push(t)
  }

  const missingExpectedRedIds = [...expectedRed.keys()].filter((id) => !seen.has(id)).sort()
  unexpectedGreen.sort()
  expectedRedStillRed.sort()

  const ciGreen =
    tests.length > 0 && realFailures.length === 0 && unexpectedGreen.length === 0 && missingExpectedRedIds.length === 0

  return { total: tests.length, realFailures, unexpectedGreen, expectedRedStillRed, missingExpectedRedIds, ciGreen }
}

// -- CLI ------------------------------------------------------------------

function manifestPathFor(acceptanceRoot, milestone) {
  for (const ext of ["yml", "yaml", "json"]) {
    const candidate = `${acceptanceRoot}/${milestone}/manifest.${ext}`
    if (existsSync(candidate)) return candidate
  }
  return null
}

function main(argv) {
  const reportPath = argv[2] ?? "acceptance-results.json"
  const milestone = argv[3]
  const acceptanceRoot = argv[4] ?? "tests/acceptance"

  if (!milestone) {
    console.error("usage: node scripts/acceptance-verdict.mjs <results.json> <milestone> [acceptance-root]")
    process.exit(1)
  }

  if (!existsSync(reportPath)) {
    console.error(`${reportPath} is missing — the sealed suite produced no report at all.`)
    process.exit(1)
  }

  let tests
  try {
    tests = parsePlaywrightReport(readFileSync(reportPath, "utf8"))
  } catch (e) {
    if (e instanceof VerdictError) {
      console.error(e.message)
      process.exit(1)
    }
    throw e
  }

  const manifestPath = manifestPathFor(acceptanceRoot, milestone)
  let expectedRed = new Map()
  if (manifestPath) {
    try {
      expectedRed = loadExpectedRed(readFileSync(manifestPath, "utf8"), manifestPath)
    } catch (e) {
      if (e instanceof VerdictError) {
        console.error(e.message)
        process.exit(1)
      }
      throw e
    }
  } else {
    console.log(`no manifest found for ${milestone} under ${acceptanceRoot} — treating expected_red as empty.`)
  }

  const verdict = buildVerdict(tests, expectedRed)

  console.log(
    `${milestone}: ${verdict.total} test(s), ${verdict.realFailures.length} real failure(s), ` +
      `${verdict.expectedRedStillRed.length} expected-red still red, ` +
      `${verdict.unexpectedGreen.length} unexpected-green, ${verdict.missingExpectedRedIds.length} missing expected-red`,
  )

  if (verdict.realFailures.length > 0) {
    console.error(`\n${verdict.realFailures.length} failure(s) not registered in ${manifestPath ?? "(no manifest)"}'s expected_red:`)
    for (const t of verdict.realFailures) console.error(`  - ${t.id}`)
  }
  if (verdict.unexpectedGreen.length > 0) {
    console.error(
      `\n${verdict.unexpectedGreen.length} expected_red id(s) PASSED — the registration is stale (the fix landed, ` +
        "clear the manifest entry) or the assertion never exercised the bug (issue #1965 in claude-coordinator). " +
        "Either way, a human has to look:",
    )
    for (const id of verdict.unexpectedGreen) console.error(`  - ${id}`)
  }
  if (verdict.missingExpectedRedIds.length > 0) {
    console.error(
      `\n${verdict.missingExpectedRedIds.length} expected_red id(s) did not appear in this run at all ` +
        "(renamed or deleted test silently draining the registry):",
    )
    for (const id of verdict.missingExpectedRedIds) console.error(`  - ${id}`)
  }

  if (!verdict.ciGreen) {
    console.error("\nsealed acceptance verdict: FAIL")
    process.exit(1)
  }

  console.log("sealed acceptance verdict: PASS (all failures accounted for by expected_red)")
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv)
}
