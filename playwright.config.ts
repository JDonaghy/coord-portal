import { defineConfig, devices } from "@playwright/test"

const PORT = 8788
const BASE_URL = `http://127.0.0.1:${PORT}`

/**
 * Black-box acceptance: drives the real Worker under `wrangler dev` with real
 * local D1 and R2 (miniflare), through a real browser. No mocked bindings —
 * that is the point, and it is what the unit tests in test/ cannot tell you.
 *
 * The webServer command applies migrations first, so a run starts from a known
 * schema rather than whatever the last run left behind.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 1 : 0,
  workers: process.env["CI"] ? 1 : undefined,
  reporter: process.env["CI"] ? [["github"], ["html", { open: "never" }]] : [["list"]],

  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },

  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // The customer surface is opened on a phone more often than not.
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],

  webServer: {
    command: "npm run serve:test",
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: !process.env["CI"],
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
})
