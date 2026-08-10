import { expect, test } from "@playwright/test"

/**
 * Black-box coverage for issue #32 ([portal] Turnstile bot gate + rate limit
 * on the public lead form), driving the real Worker under `wrangler dev` —
 * see `playwright.config.ts`. This is the project's own `e2e/` tier, not the
 * sealed acceptance suite under `tests/acceptance/`; per CLAUDE.md this repo
 * still ships its own coverage for behaviour-changing work. The sealed slice
 * (`tests/acceptance/ms-2/32-bot-gate-rate-limit.spec.ts`) is the acceptance
 * bar for this issue — this file is a lighter smoke pass over the same
 * surface, plus a request-level check the acceptance slice's own comments
 * flag as undrivable there (an unset secret failing closed) that a local
 * `wrangler dev` run *can* reach, since this file is free to boot its own.
 *
 * `wrangler dev` runs away from Cloudflare's edge (no `CF-Ray`), so
 * `src/turnstile.ts` falls back to Cloudflare's documented always-pass test
 * pair with zero setup — see that module for why.
 *
 * IP isolation: every request below carries its own synthetic
 * `CF-Connecting-IP` (RFC 5737 TEST-NET-3), distinct from the unspoofed
 * default (`127.0.0.1`) every other `e2e/*.spec.ts` file's `POST /start`
 * calls share, and distinct from each other — so this file's own rate-limit
 * check never competes with, or is starved by, anything else in this suite.
 *
 * Every string below is invented — see CLAUDE.md rule 1.
 */

const TURNSTILE_FIELD = "cf-turnstile-response"
/** Contract, "Bot gate + rate limit": the literal token a test sitekey mints. */
const TURNSTILE_DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX"
const REJECTION_BANNER = "We couldn't send that — please try again."
const LEAD_REFERENCE = /LEAD-[A-Z0-9]{6}/

function uniqueEmail(local: string): string {
  const tag = Math.random().toString(36).slice(2, 10)
  return `${local}-${tag}@example.test`
}

function ipHeaders(ip: string): Record<string, string> {
  return { "CF-Connecting-IP": ip, "X-Forwarded-For": ip }
}

/** Pull the `lead-error` element's text out of a raw response body, entities decoded. */
function bannerOf(body: string): string | null {
  const match = body.match(/<([a-z]+)[^>]*data-testid="lead-error"[^>]*>([\s\S]*?)<\/\1>/i)
  if (!match) return null
  return match[2]
    .replace(/<[^>]*>/g, "")
    .replace(/&#39;|&apos;|&rsquo;|&#8217;/g, "'")
    .replace(/&mdash;|&#8212;/g, "—")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

test("GET /start renders a Turnstile widget bound to a public sitekey, and Cloudflare's script", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    baseURL,
    extraHTTPHeaders: ipHeaders("203.0.113.201"),
  })
  const page = await context.newPage()
  await page.goto("/start")
  const widget = page.getByTestId("turnstile-widget")
  await expect(widget).toHaveCount(1)
  const sitekey = await widget.getAttribute("data-sitekey")
  expect(sitekey).toBeTruthy()

  const html = await page.content()
  expect(html).toContain("challenges.cloudflare.com")
  // The secret must never reach the page, under any binding name.
  expect(html).not.toMatch(/turnstile[_-]?secret/i)
  await context.close()
})

test("a POST with no Turnstile token creates no lead and redisplays the form", async ({
  request,
}) => {
  const email = uniqueEmail("no-token-e2e")
  const response = await request.post("/start", {
    headers: ipHeaders("203.0.113.202"),
    form: { summary: "A synthetic no-token e2e request.", email },
    maxRedirects: 0,
    failOnStatusCode: false,
  })
  const body = await response.text()
  expect(body).not.toContain('data-testid="lead-receipt"')
  expect(body).not.toMatch(LEAD_REFERENCE)
  expect(body).toContain('data-testid="lead-form"')
  expect(bannerOf(body)).toBe(REJECTION_BANNER)
})

test("a malformed token creates no lead — the gate is real siteverify, not a rubber stamp", async ({
  request,
}) => {
  const email = uniqueEmail("malformed-token-e2e")
  const response = await request.post("/start", {
    headers: ipHeaders("203.0.113.203"),
    form: {
      summary: "A synthetic malformed-token e2e request.",
      email,
      [TURNSTILE_FIELD]: "definitely-not-a-real-turnstile-token",
    },
    maxRedirects: 0,
    failOnStatusCode: false,
  })
  const body = await response.text()
  expect(body).not.toContain('data-testid="lead-receipt"')
  expect(body).not.toMatch(LEAD_REFERENCE)
  expect(bannerOf(body)).toBe(REJECTION_BANNER)
})

test("the documented always-pass dummy token is accepted", async ({ request }) => {
  const email = uniqueEmail("dummy-token-e2e")
  const response = await request.post("/start", {
    headers: ipHeaders("203.0.113.204"),
    form: {
      summary: "A synthetic dummy-token e2e request.",
      email,
      [TURNSTILE_FIELD]: TURNSTILE_DUMMY_TOKEN,
    },
    maxRedirects: 0,
    failOnStatusCode: false,
  })
  const body = await response.text()
  expect(body).toContain('data-testid="lead-receipt"')
  expect(body).toMatch(LEAD_REFERENCE)
})

test("a sustained burst from one IP is eventually cut off, and a different IP is unaffected", async ({
  request,
}) => {
  const burstIp = "203.0.113.205"
  let accepted = 0
  let sawRefusal = false

  for (let i = 0; i < 20; i += 1) {
    const response = await request.post("/start", {
      headers: ipHeaders(burstIp),
      form: {
        summary: `A synthetic burst e2e request (${i}).`,
        email: uniqueEmail(`burst-e2e-${i}`),
        [TURNSTILE_FIELD]: TURNSTILE_DUMMY_TOKEN,
      },
      maxRedirects: 0,
      failOnStatusCode: false,
    })
    const body = await response.text()
    if (body.includes('data-testid="lead-receipt"')) {
      accepted += 1
    } else {
      sawRefusal = true
      break
    }
  }

  expect(accepted, "at least one burst request must succeed").toBeGreaterThan(0)
  expect(sawRefusal, "20 back-to-back requests from one IP must be cut off").toBe(true)

  const bystander = await request.post("/start", {
    headers: ipHeaders("203.0.113.206"),
    form: {
      summary: "A synthetic bystander e2e request.",
      email: uniqueEmail("bystander-e2e"),
      [TURNSTILE_FIELD]: TURNSTILE_DUMMY_TOKEN,
    },
    maxRedirects: 0,
    failOnStatusCode: false,
  })
  const bystanderBody = await bystander.text()
  expect(bystanderBody, "the rate limit is per-IP, not a global kill switch").toContain(
    'data-testid="lead-receipt"',
  )
})
