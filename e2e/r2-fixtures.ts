import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runWrangler } from "./wrangler-cli"

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
 *
 * Miniflare keeps R2 in the same SQLite state directory as D1, so this shares
 * `wrangler dev`'s write lock exactly as `outbox-fixtures.ts` does — hence the
 * shared `wrangler-cli.ts` runner and its busy-lock retry.
 */
const BUCKET = "coord-portal-artifacts"

export function seedR2Object(key: string, body: string, contentType: string): void {
  const dir = mkdtempSync(join(tmpdir(), "coord-portal-r2-"))
  try {
    const file = join(dir, "object")
    writeFileSync(file, body)
    runWrangler([
      "r2",
      "object",
      "put",
      `${BUCKET}/${key}`,
      "--local",
      "--file",
      file,
      "--content-type",
      contentType,
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
