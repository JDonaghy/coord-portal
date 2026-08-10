import { describe, expect, it } from "vitest"
import { clientIp } from "../src/rateLimit"

/**
 * Unit coverage for `clientIp` — the address resolution the per-IP rate
 * limit (issue #32) keys on. `isRateLimited` itself needs a real D1 (batch
 * insert + delete + a sliding-window count), and per this repo's own
 * convention (`test/rounds.test.ts`: "a mocked D1 would only prove the stub
 * does what I wrote it to do") that half is covered black-box — by the
 * sealed acceptance slice's "IP ISOLATION" tests and by this repo's own e2e
 * coverage against real `wrangler dev` + D1 — rather than here.
 *
 * Every address below is invented, drawn from RFC 5737's documentation
 * ranges, never a real one — see CLAUDE.md rule 1.
 */

function request(headers: Record<string, string> = {}): Request {
  return new Request("https://portal.test/start", { method: "POST", headers })
}

describe("clientIp", () => {
  it("reads CF-Connecting-IP when present", () => {
    expect(clientIp(request({ "CF-Connecting-IP": "203.0.113.9" }))).toBe("203.0.113.9")
  })

  it("falls back to the first X-Forwarded-For entry when CF-Connecting-IP is absent", () => {
    expect(
      clientIp(request({ "X-Forwarded-For": "203.0.113.9, 10.0.0.1" })),
    ).toBe("203.0.113.9")
  })

  it("prefers CF-Connecting-IP over X-Forwarded-For when both are present", () => {
    expect(
      clientIp(
        request({ "CF-Connecting-IP": "203.0.113.9", "X-Forwarded-For": "198.51.100.1" }),
      ),
    ).toBe("203.0.113.9")
  })

  it("collapses to one shared bucket, rather than exempting the caller, when neither header is present", () => {
    expect(clientIp(request())).toBe("unknown")
  })

  it("trims whitespace around the resolved address", () => {
    expect(clientIp(request({ "CF-Connecting-IP": "  203.0.113.9  " }))).toBe("203.0.113.9")
    expect(clientIp(request({ "X-Forwarded-For": "  203.0.113.9  , 10.0.0.1" }))).toBe(
      "203.0.113.9",
    )
  })
})
