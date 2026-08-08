import { expect, test } from "@playwright/test"

/**
 * The core smoke set. Small on purpose, and it should stay small: these run on
 * every change, so they cover the few things whose breakage means "the site is
 * down", not the details of any one screen.
 */

test("the landing page renders and reports a healthy stack", async ({ page }) => {
  await page.goto("/")

  await expect(page.getByRole("heading", { name: "coord-portal" })).toBeVisible()

  // This assertion is the whole reason the readout exists: it is only green if
  // the Worker booted, D1 answered with an applied migration, and R2 answered.
  await expect(page.locator("#overall")).toHaveText("all systems ok")
  await expect(page.locator("#d1")).toHaveText(/schema 0001/)
  await expect(page.locator("#r2")).toHaveText("ok")
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
