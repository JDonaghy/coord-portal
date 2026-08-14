#!/usr/bin/env node
// Guards the sealed acceptance CI job (see .github/workflows/ci.yml) against
// a silent false-green: Playwright exits 0 when a path filter matches zero
// spec files (see the warning in playwright.acceptance.config.ts), so the
// job's exit code alone is not evidence that the suite actually ran. This
// reads the JSON reporter's summary and fails the job if nothing executed.
//
// Issue #77: a sealed suite that no gate runs verifies nothing, and a gate
// that can pass having run nothing is the same failure wearing a green check.
import { existsSync, readFileSync } from "node:fs"

const reportPath = process.argv[2] ?? "acceptance-results.json"

if (!existsSync(reportPath)) {
  console.error(`${reportPath} is missing — the sealed suite produced no report at all.`)
  process.exit(1)
}

const { stats } = JSON.parse(readFileSync(reportPath, "utf8"))
const total = (stats?.expected ?? 0) + (stats?.unexpected ?? 0) + (stats?.flaky ?? 0)

console.log(`sealed acceptance suite ran ${total} test(s): ${JSON.stringify(stats)}`)

if (total === 0) {
  console.error(
    "Zero acceptance tests executed. A green run with nothing run is exactly " +
      "the silent-pass failure this check exists to catch (issue #77).",
  )
  process.exit(1)
}
