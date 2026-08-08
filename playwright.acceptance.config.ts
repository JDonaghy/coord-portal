import { defineConfig, devices } from "@playwright/test"

/**
 * Playwright config for the SEALED oracle-loop acceptance suite.
 *
 * A sibling of `playwright.config.ts` (the `e2e/` smoke net), never an edit of
 * it — the two have different jobs and different failure modes:
 *
 * 1. `playwright.config.ts` has `testDir: './e2e'`, which is invisible to
 *    anything under `tests/acceptance/ms-NN/`. A path filter pointing outside
 *    `testDir` matches zero files and Playwright exits **0 with 0 tests** — a
 *    silent, confidently-wrong green. This config's `testDir` points at the
 *    sealed tree so a slice is actually discovered.
 * 2. The acceptance run needs a machine-readable reporter, not the smoke
 *    suite's CI-conditional `'github'`. The `web-playwright` driver appends
 *    `--reporter=json` itself, but this file still picks an explicit,
 *    non-CI-conditional default so a human running it directly gets readable
 *    output instead of inheriting whatever `CI` implies.
 *
 * Invoked by `acceptance.drivers.coord-portal` in coordinator.yml as:
 *   npm run test:acceptance -- {ms}
 * `{ms}` (here `ms-1`, from the milestone number) is substituted by
 * `render_run_command` and passed as Playwright's positional filter, which
 * matches by SUBSTRING against each spec's resolved path.
 *
 * ⚠ Substring matching means `ms-1` would also match `ms-10`…`ms-19`. Harmless
 * today — this repo has exactly one milestone — but if it ever reaches ten,
 * a slice run will silently over-select. There is no way to tighten it from
 * here; the token is chosen by `coord.acceptance.ms_dirname`.
 *
 * DETERMINISM: `serve:acceptance` deletes `.wrangler/state` before applying
 * migrations, so every run starts from an empty database at schema head. That
 * is the whole reason this repo can host a sealed oracle without the fixture
 * server the coord webapp is still waiting on — `wrangler dev` over a
 * freshly-migrated local D1 *is* a deterministic backend. Without the wipe,
 * rows written by one run would be visible to the next and the suite would
 * pass or fail depending on what ran before it.
 */

const PORT = 8789 // deliberately not e2e's 8788, so both can run at once
const BASE_URL = `http://127.0.0.1:${PORT}`

export default defineConfig({
  testDir: "./tests/acceptance",
  fullyParallel: false, // a shared D1 — parallel writers would race
  forbidOnly: true, // a sealed suite must never ship a .only
  retries: 0, // an oracle that retries is measuring flakiness, not behaviour
  workers: 1,
  reporter: [["list"]],

  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  webServer: {
    command: "npm run serve:acceptance",
    url: `${BASE_URL}/api/health`,
    // NEVER reuse: a surviving server from an earlier run still holds that
    // run's database, which is exactly the contamination the wipe prevents.
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
})
