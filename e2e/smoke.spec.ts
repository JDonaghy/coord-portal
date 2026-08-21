import { readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { expect, test } from "@playwright/test"

/**
 * The core smoke set. Small on purpose, and it should stay small: these run on
 * every change, so they cover the few things whose breakage means "the site is
 * down", not the details of any one screen.
 */

/**
 * The highest-numbered file in `migrations/`, e.g. `"0016"`.
 *
 * `/api/health` reports the `schema_version` row the last applied migration
 * wrote, and the point of checking it is to catch a migration that silently
 * failed to apply: that shows up as a version behind head, here, rather than
 * as a confusing 500 three screens later.
 *
 * This used to be a literal (`/schema 0015/`) that every migration commit was
 * expected to bump by hand. #128 added `0016_clients.sql` and did not bump it,
 * which surfaced as a red `e2e smoke` leg on a PR whose entire subject was
 * that migration — a self-inflicted failure that says nothing about the
 * schema. Deriving head from the directory keeps exactly the property the
 * literal existed for and strengthens it: a migration that forgets to write
 * `schema_meta` at all now fails here too, which the literal could not see.
 */
function migrationHead(): string {
  const dir = fileURLToPath(new URL("../migrations", import.meta.url))
  const versions = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => name.slice(0, name.indexOf("_")))
    .filter((version) => /^\d+$/.test(version))
    .sort()

  const head = versions.at(-1)
  // A migrations directory this cannot read is a broken checkout, not a
  // passing smoke test — say so here rather than silently asserting nothing.
  expect(head, `no numbered .sql migrations found in ${dir}`).toBeDefined()
  return head as string
}

test("the bare domain greets a stranger rather than a status readout", async ({ page }) => {
  // Issue #84: `/` used to be a static placeholder with a live health readout
  // ("Nothing is built yet ... this page exists to prove the stack is
  // wired"). It is now the customer front door — see `src/routes/home.ts`.
  // The stack-health assertion that readout used to carry now lives in the
  // next test, against `/api/health` directly.
  await page.goto("/")

  await expect(page.getByRole("heading", { name: "coord-portal" })).toHaveCount(0)
  await expect(page.getByTestId("front-door-start")).toBeVisible()
  await expect(page.locator("a[href='/api/health']")).toHaveCount(0)
  await expect(page.locator("a[href*='github.com']")).toHaveCount(0)
})

test("the static site and the API share one origin", async ({ page }) => {
  const response = await page.request.get("/api/health")
  expect(response.status()).toBe(200)

  const body = await response.json()
  expect(body.ok).toBe(true)
  expect(body.service).toBe("coord-portal")
  expect(body.checks.d1.ok).toBe(true)
  expect(body.checks.r2.ok).toBe(true)
})

test("the applied schema is at the head of migrations/", async ({ page }) => {
  // Split out of the stack-wiring test above so a schema behind head names
  // itself in the report, instead of reading as "the whole stack is down".
  const response = await page.request.get("/api/health")
  expect(response.status()).toBe(200)

  const body = await response.json()
  expect(body.checks.d1.detail).toBe(`schema ${migrationHead()}`)
})

test("an unknown API path returns JSON, not the landing page", async ({ page }) => {
  const response = await page.request.get("/api/does-not-exist")
  expect(response.status()).toBe(404)
  expect(response.headers()["content-type"]).toContain("application/json")
  expect(await response.json()).toMatchObject({ error: "not_found" })
})

test("whoami reports nobody when Access is not in front of the Worker", async ({ page }) => {
  // Local `wrangler dev` has no Access in front of it, which is exactly the
  // condition under which a spoofed header must still not read as verified.
  const response = await page.request.get("/api/whoami", {
    headers: { "Cf-Access-Authenticated-User-Email": "spoofed@example.test" },
  })
  const body = await response.json()
  expect(body.verified).toBe(false)
})
