import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { accessRefused, clearAccessJwksCache, readAccessIdentity, resolveSiteIdentity } from "../src/identity"
import worker from "../src/index"
import { accessSigner, epoch, unsignedToken, type AccessSigner } from "./accessToken"
import { fakeEnv, get } from "./fixtures"

/** Builds an unsigned JWT-shaped string. Signature is garbage on purpose. */
function unsignedJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  return `${b64({ alg: "none" })}.${b64(claims)}.not-a-signature`
}

describe("readAccessIdentity", () => {
  it("prefers the Access email header", () => {
    const id = readAccessIdentity(
      get("/api/whoami", { "Cf-Access-Authenticated-User-Email": "someone@example.test" }),
    )
    expect(id).toEqual({
      email: "someone@example.test",
      verified: false,
      source: "cf-access-header",
    })
  })

  it("falls back to the JWT payload", () => {
    const jwt = unsignedJwt({ email: "jwt-user@example.test" })
    const id = readAccessIdentity(get("/api/whoami", { "Cf-Access-Jwt-Assertion": jwt }))
    expect(id.email).toBe("jwt-user@example.test")
    expect(id.source).toBe("cf-access-jwt")
  })

  it("reports nobody when Access is not in front", () => {
    expect(readAccessIdentity(get("/api/whoami"))).toEqual({
      email: null,
      verified: false,
      source: "none",
    })
  })

  it.each([
    ["not-a-jwt"],
    ["only.two"],
    ["a.!!!not-base64!!!.c"],
    [unsignedJwt({ email: 42 })],
    [unsignedJwt({ email: "not-an-email" })],
  ])("returns null rather than throwing for %s", (jwt) => {
    const id = readAccessIdentity(get("/api/whoami", { "Cf-Access-Jwt-Assertion": jwt }))
    expect(id.email).toBeNull()
  })

  // This is the test that matters. An unsigned, self-minted token must never
  // come back as verified — `readAccessIdentity` checks nothing, by design,
  // forever. `resolveSiteIdentity` below is what a route calls instead when it
  // actually needs proof (#1981).
  it("NEVER reports verified, even for a well-formed token", () => {
    const jwt = unsignedJwt({ email: "attacker@example.test", aud: "anything" })
    const fromJwt = readAccessIdentity(get("/api/whoami", { "Cf-Access-Jwt-Assertion": jwt }))
    const fromHeader = readAccessIdentity(
      get("/api/whoami", { "Cf-Access-Authenticated-User-Email": "attacker@example.test" }),
    )
    expect(fromJwt.verified).toBe(false)
    expect(fromHeader.verified).toBe(false)
  })
})

describe("GET /api/whoami", () => {
  it("echoes the claimed identity and flags it as unverified", async () => {
    const res = await worker.fetch(
      get("/api/whoami", { "Cf-Access-Authenticated-User-Email": "someone@example.test" }),
      fakeEnv(),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { email: string; verified: boolean; note: string }
    expect(body.email).toBe("someone@example.test")
    expect(body.verified).toBe(false)
    expect(body.note).toMatch(/NOT cryptographically verified/)
  })
})

/**
 * `resolveSiteIdentity` (#1981/#108) — what every customer- and
 * operator-facing route now calls instead of `readAccessIdentity` to scope a
 * query or authorize a write.
 *
 * Off the edge this is exactly `readAccessIdentity`'s `.email` — the same
 * unverified reading every off-edge gate in this codebase already relies on.
 * Behind the edge, it is `verifyAccessIdentity` pinned to `SITE_ACCESS_AUD`:
 * the interesting assertions are the refusals, because a forged assertion
 * that resolves to a real address is exactly the vulnerability this closes
 * (issue #108's own measurement: a self-minted `{"alg":"none"}` token, curled
 * directly at the Worker, came back as `attacker@example.test`).
 *
 * Every credential, team domain and AUD tag below is invented.
 */
describe("resolveSiteIdentity", () => {
  const TEAM = "example-team.cloudflareaccess.com"
  const ISSUER = `https://${TEAM}`
  const SITE_AUD = "5555555555555555555555555555555555555555555555555555555555555555"
  const BRIDGE_AUD = "6666666666666666666666666666666666666666666666666666666666666666"

  function edgeRequest(headers: Record<string, string> = {}): Request {
    return get("/submissions", { "CF-Ray": "8f0000000000abcd-LHR", ...headers })
  }

  function siteEnv(overrides: Record<string, string | undefined> = {}) {
    return { ACCESS_TEAM_DOMAIN: TEAM, SITE_ACCESS_AUD: SITE_AUD, ...overrides }
  }

  describe("off the edge", () => {
    it("falls back to the unverified header reading", async () => {
      const email = await resolveSiteIdentity(
        get("/submissions", { "Cf-Access-Authenticated-User-Email": "customer@example.test" }),
        siteEnv(),
      )
      expect(email).toBe("customer@example.test")
    })

    it("returns null for no identity at all", async () => {
      expect(await resolveSiteIdentity(get("/submissions"), siteEnv())).toBeNull()
    })

    it("never verifies — a forged token is honoured, same as readAccessIdentity, because there is no Access here to ask", async () => {
      const forged = unsignedToken({ email: "attacker@example.test" })
      const email = await resolveSiteIdentity(
        get("/submissions", { "Cf-Access-Jwt-Assertion": forged }),
        siteEnv(),
      )
      expect(email).toBe("attacker@example.test")
    })
  })

  describe("behind the edge, on a verified Access assertion", () => {
    let signer: AccessSigner
    let fetchMock: ReturnType<typeof vi.fn>

    function claims(overrides: Record<string, unknown> = {}) {
      return {
        iss: ISSUER,
        aud: [SITE_AUD],
        exp: epoch(600),
        email: "customer@example.test",
        ...overrides,
      }
    }

    beforeEach(async () => {
      clearAccessJwksCache()
      signer = await accessSigner()
      fetchMock = vi.fn(async () => new Response(JSON.stringify(await signer.jwks())))
      vi.stubGlobal("fetch", fetchMock)
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it("returns the verified email for a correctly-audienced assertion", async () => {
      const token = await signer.sign(claims())
      const email = await resolveSiteIdentity(
        edgeRequest({ "Cf-Access-Jwt-Assertion": token }),
        siteEnv(),
      )
      expect(email).toBe("customer@example.test")
    })

    // The exact regression this issue closes: the unverified header claim
    // that used to be trusted outright now resolves to null behind the edge.
    it("refuses an unverified header claim — the vulnerability, closed", async () => {
      const email = await resolveSiteIdentity(
        edgeRequest({ "Cf-Access-Authenticated-User-Email": "attacker@example.test" }),
        siteEnv(),
      )
      expect(email).toBeNull()
    })

    it("refuses the exact self-minted {alg:none} shape measured against the live deployment", async () => {
      const forged = unsignedToken(claims(), signer.kid)
      const email = await resolveSiteIdentity(edgeRequest({ "Cf-Access-Jwt-Assertion": forged }), siteEnv())
      expect(email).toBeNull()
    })

    it("refuses an assertion minted for the bridge application — AUDs are not interchangeable", async () => {
      const token = await signer.sign(claims({ aud: [BRIDGE_AUD] }))
      const email = await resolveSiteIdentity(
        edgeRequest({ "Cf-Access-Jwt-Assertion": token }),
        siteEnv(),
      )
      expect(email).toBeNull()
    })

    it("refuses an expired assertion", async () => {
      const token = await signer.sign(claims({ exp: epoch(-1) }))
      const email = await resolveSiteIdentity(
        edgeRequest({ "Cf-Access-Jwt-Assertion": token }),
        siteEnv(),
      )
      expect(email).toBeNull()
    })

    it("fails closed when SITE_ACCESS_AUD or ACCESS_TEAM_DOMAIN is unset, even with a valid assertion", async () => {
      const token = await signer.sign(claims())
      const request = edgeRequest({ "Cf-Access-Jwt-Assertion": token })
      expect(await resolveSiteIdentity(request, siteEnv({ SITE_ACCESS_AUD: undefined }))).toBeNull()
      expect(await resolveSiteIdentity(request, siteEnv({ ACCESS_TEAM_DOMAIN: undefined }))).toBeNull()
    })

    it("a caller cannot relax the check by forging CF-Ray off the edge — it only gets stricter", async () => {
      // Off the edge, a forged token is honoured (see above). The same
      // request with a forged CF-Ray lands in the strict, verified branch
      // instead — the direction that costs an attacker, never helps them.
      const forged = unsignedToken(claims(), signer.kid)
      const offEdge = await resolveSiteIdentity(
        get("/submissions", { "Cf-Access-Jwt-Assertion": forged }),
        siteEnv(),
      )
      expect(offEdge).toBe("customer@example.test")

      const withForgedRay = await resolveSiteIdentity(
        get("/submissions", { "Cf-Access-Jwt-Assertion": forged, "CF-Ray": "deadbeefdeadbeef-XXX" }),
        siteEnv(),
      )
      expect(withForgedRay).toBeNull()
    })
  })
})

describe("accessRefused", () => {
  it("is an empty, uncached 401 — the same indistinguishable shape bridgeUnauthorized uses", async () => {
    const res = accessRefused()
    expect(res.status).toBe(401)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.text()).toBe("")
  })
})
