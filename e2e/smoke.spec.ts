import { expect, test } from "@playwright/test"

/**
 * The core smoke set. Small on purpose, and it should stay small: these run on
 * every change, so they cover the few things whose breakage means "the site is
 * down", not the details of any one screen.
 */

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
  // Pinned to the migration head on purpose: it moves in the same commit that
  // adds a migration, so a migration that silently failed to apply shows up
  // here rather than as a confusing 500 three screens later.
  expect(body.checks.d1.detail).toMatch(/schema 0015/)
  expect(body.checks.r2.ok).toBe(true)
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
