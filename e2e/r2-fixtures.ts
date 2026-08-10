import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Seeds objects into the local R2 bucket that `wrangler dev` (`serve:test`,
 * see `playwright.config.ts`) is already serving, so `e2e/design-rounds.spec.ts`
 * can drive `routes/mocks.ts`'s `mockBundle` route against a real object
 * instead of only unit-testing `resolveBundleKey` in isolation.
 *
 * There is no upload route on this side to seed through (`routes/mocks.ts`'s
 * own docstring: "There is no upload half. The bucket is populated
 * coord-side"), and `test/fixtures.ts`'s fake `ARTIFACTS` only implements
 * `.head()`. So this shells out to the same CLI that populates the real
 * bucket in production: `wrangler r2 object put --local`.
 *
 * `--local` with no `--persist-to` writes to the same default
 * `.wrangler/state/v3` directory `wrangler dev` reads from — both processes
 * run from the repo root (`serve:test`'s `wrangler dev` via Playwright's
 * `webServer`, this via the test file), so they agree on where that is
 * without either side naming it. Measured directly: a `put` while `wrangler
 * dev` is already running and serving traffic lands and is immediately
 * readable through a running route — see the commit that added this file.
 */
const WRANGLER_BIN = join(process.cwd(), "node_modules", ".bin", "wrangler")
const BUCKET = "coord-portal-artifacts"

export function seedR2Object(key: string, body: string, contentType: string): void {
  const dir = mkdtempSync(join(tmpdir(), "coord-portal-r2-"))
  try {
    const file = join(dir, "object")
    writeFileSync(file, body)
    execFileSync(
      WRANGLER_BIN,
      ["r2", "object", "put", `${BUCKET}/${key}`, "--local", "--file", file, "--content-type", contentType],
      { cwd: process.cwd(), stdio: "pipe" },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
