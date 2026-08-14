import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { clearAccessJwksCache, verifyAccessIdentity } from "../src/identity"
import { accessSigner, epoch, unsignedToken, type AccessSigner } from "./accessToken"

/**
 * `verifyAccessIdentity` (#70) — the check that makes `verified` mean something.
 *
 * The interesting assertions here are all **refusals**. A verifier that returns
 * an identity for everything passes a happy-path suite perfectly, so the happy
 * path is one test and the other dozen are the ways a token must fail: no
 * signature, someone else's signature, someone else's team, someone else's
 * application, expired, unknown key, and a JWKS endpoint that is down.
 *
 * Every credential, team domain and AUD tag below is invented.
 */

const TEAM = "example-team.cloudflareaccess.com"
const ISSUER = `https://${TEAM}`
const CERTS_URL = `${ISSUER}/cdn-cgi/access/certs`
const BRIDGE_AUD = "1111111111111111111111111111111111111111111111111111111111111111"
const SITE_AUD = "2222222222222222222222222222222222222222222222222222222222222222"
const CLIENT_ID = "a1b2c3d4e5f60718293a4b5c6d7e8f90.access"

const OPTIONS = { teamDomain: TEAM, audience: BRIDGE_AUD }

let signer: AccessSigner
let fetchMock: ReturnType<typeof vi.fn>

/** Claims as Access is expected to mint them for a service token. */
function serviceTokenClaims(overrides: Record<string, unknown> = {}) {
  return {
    iss: ISSUER,
    aud: [BRIDGE_AUD],
    exp: epoch(600),
    iat: epoch(-10),
    sub: "",
    common_name: CLIENT_ID,
    type: "app",
    ...overrides,
  }
}

function request(token?: string): Request {
  return new Request("https://intake.heurontech.com/api/bridge/pull", {
    headers: token ? { "Cf-Access-Jwt-Assertion": token } : {},
  })
}

/** Serves this signer's JWKS at the certs URL and 404s everything else. */
function serveJwks(from: AccessSigner = signer) {
  fetchMock.mockImplementation(async (input: unknown) => {
    const url = typeof input === "string" ? input : String((input as Request).url)
    if (url !== CERTS_URL) return new Response("no", { status: 404 })
    return new Response(JSON.stringify(await from.jwks()), {
      headers: { "content-type": "application/json" },
    })
  })
}

beforeEach(async () => {
  clearAccessJwksCache()
  signer = await accessSigner()
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
  serveJwks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("verifyAccessIdentity — what it accepts", () => {
  it("verifies a service-token assertion and surfaces its common_name", async () => {
    const identity = await verifyAccessIdentity(
      request(await signer.sign(serviceTokenClaims())),
      OPTIONS,
    )

    expect(identity).not.toBeNull()
    expect(identity?.verified).toBe(true)
    expect(identity?.commonName).toBe(CLIENT_ID)
    // A service token is not a person. Nothing may treat it as one.
    expect(identity?.email).toBeNull()
    expect(identity?.claims["type"]).toBe("app")
  })

  it("verifies a human assertion, which carries an email and no common_name", async () => {
    const identity = await verifyAccessIdentity(
      request(
        await signer.sign(
          serviceTokenClaims({ common_name: undefined, email: "operator@example.test" }),
        ),
      ),
      OPTIONS,
    )

    expect(identity?.email).toBe("operator@example.test")
    expect(identity?.commonName).toBeNull()
  })

  it("accepts a scalar aud as well as an array", async () => {
    const identity = await verifyAccessIdentity(
      request(await signer.sign(serviceTokenClaims({ aud: BRIDGE_AUD }))),
      OPTIONS,
    )
    expect(identity?.commonName).toBe(CLIENT_ID)
  })

  it("accepts the team domain with or without a scheme or trailing slash", async () => {
    const token = await signer.sign(serviceTokenClaims())
    for (const teamDomain of [TEAM, ISSUER, `${ISSUER}/`, `${TEAM}/`]) {
      const identity = await verifyAccessIdentity(request(token), { ...OPTIONS, teamDomain })
      expect(identity?.commonName, teamDomain).toBe(CLIENT_ID)
    }
  })
})

describe("verifyAccessIdentity — what it refuses", () => {
  it("refuses a request with no assertion at all", async () => {
    expect(await verifyAccessIdentity(request(), OPTIONS)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("refuses a self-minted alg:none token — the #1981 hole, closed", async () => {
    const forged = unsignedToken(serviceTokenClaims(), signer.kid)
    expect(await verifyAccessIdentity(request(forged), OPTIONS)).toBeNull()
  })

  it("refuses a token signed by a key that is not the team's", async () => {
    const attacker = await accessSigner(signer.kid)
    const token = await attacker.sign(serviceTokenClaims())
    // The JWKS still serves the *real* key under the same kid.
    expect(await verifyAccessIdentity(request(token), OPTIONS)).toBeNull()
  })

  it("refuses a token whose signature has been swapped for another's", async () => {
    const real = await signer.sign(serviceTokenClaims())
    const other = await signer.sign(serviceTokenClaims({ common_name: "someone-else.access" }))
    const [header, payload] = real.split(".")
    const stitched = `${header}.${payload}.${other.split(".")[2]}`
    expect(await verifyAccessIdentity(request(stitched), OPTIONS)).toBeNull()
  })

  it("refuses another Access application's token — aud is pinned", async () => {
    const token = await signer.sign(serviceTokenClaims({ aud: [SITE_AUD] }))
    expect(await verifyAccessIdentity(request(token), OPTIONS)).toBeNull()
  })

  it("refuses another team's issuer even when the signature checks out", async () => {
    const token = await signer.sign(serviceTokenClaims({ iss: "https://other.cloudflareaccess.com" }))
    expect(await verifyAccessIdentity(request(token), OPTIONS)).toBeNull()
  })

  it("refuses an expired token, with no leeway", async () => {
    for (const exp of [epoch(-1), epoch(-3600), epoch(0)]) {
      const token = await signer.sign(serviceTokenClaims({ exp }))
      expect(await verifyAccessIdentity(request(token), OPTIONS), String(exp)).toBeNull()
    }
  })

  it("refuses a token with no exp, or a non-numeric one", async () => {
    for (const exp of [undefined, "later", null]) {
      const token = await signer.sign(serviceTokenClaims({ exp }))
      expect(await verifyAccessIdentity(request(token), OPTIONS), String(exp)).toBeNull()
    }
  })

  it("refuses a token that is not valid yet", async () => {
    const token = await signer.sign(serviceTokenClaims({ nbf: epoch(3600) }))
    expect(await verifyAccessIdentity(request(token), OPTIONS)).toBeNull()
  })

  it("refuses a kid the JWKS does not contain", async () => {
    const token = await signer.sign(serviceTokenClaims(), { kid: "some-other-key" })
    expect(await verifyAccessIdentity(request(token), OPTIONS)).toBeNull()
  })

  it("refuses when the team domain or audience is not configured", async () => {
    const token = await signer.sign(serviceTokenClaims())
    for (const options of [
      { teamDomain: undefined, audience: BRIDGE_AUD },
      { teamDomain: TEAM, audience: undefined },
      { teamDomain: "   ", audience: BRIDGE_AUD },
      { teamDomain: TEAM, audience: "  " },
      { teamDomain: undefined, audience: undefined },
    ]) {
      expect(await verifyAccessIdentity(request(token), options)).toBeNull()
    }
    // Unconfigured must not even reach out — it is a refusal, not a lookup.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("refuses a non-https team domain", async () => {
    const token = await signer.sign(serviceTokenClaims())
    expect(
      await verifyAccessIdentity(request(token), { ...OPTIONS, teamDomain: "http://evil.test" }),
    ).toBeNull()
  })

  it.each([
    ["not-a-jwt"],
    ["only.two"],
    ["a.!!!not-base64!!!.c"],
    ["..."],
    [""],
  ])("refuses the malformed token %s rather than throwing", async (token) => {
    expect(await verifyAccessIdentity(request(token), OPTIONS)).toBeNull()
  })
})

describe("verifyAccessIdentity — the JWKS it verifies against", () => {
  it("refuses when the JWKS endpoint is unreachable", async () => {
    const token = await signer.sign(serviceTokenClaims())
    fetchMock.mockRejectedValue(new Error("network down"))
    expect(await verifyAccessIdentity(request(token), OPTIONS)).toBeNull()
  })

  it("refuses when the JWKS endpoint answers with an error status", async () => {
    const token = await signer.sign(serviceTokenClaims())
    fetchMock.mockResolvedValue(new Response("nope", { status: 503 }))
    expect(await verifyAccessIdentity(request(token), OPTIONS)).toBeNull()
  })

  it("refuses when the JWKS is not JSON, or carries no usable key", async () => {
    const token = await signer.sign(serviceTokenClaims())
    for (const body of ["<html>not json</html>", "{}", '{"keys":[]}', '{"keys":"nope"}']) {
      clearAccessJwksCache()
      fetchMock.mockResolvedValue(new Response(body))
      expect(await verifyAccessIdentity(request(token), OPTIONS), body).toBeNull()
    }
  })

  it("does not fail open after a JWKS failure — a later good fetch still verifies", async () => {
    const token = await signer.sign(serviceTokenClaims())
    fetchMock.mockRejectedValueOnce(new Error("network down"))
    expect(await verifyAccessIdentity(request(token), OPTIONS)).toBeNull()

    serveJwks()
    expect((await verifyAccessIdentity(request(token), OPTIONS))?.commonName).toBe(CLIENT_ID)
  })

  it("fetches the JWKS once and reuses it", async () => {
    const token = await signer.sign(serviceTokenClaims())
    for (let i = 0; i < 5; i++) {
      expect((await verifyAccessIdentity(request(token), OPTIONS))?.verified).toBe(true)
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(CERTS_URL)
  })

  it("does not re-fetch on every unknown kid — an attacker is not a rotation", async () => {
    await verifyAccessIdentity(request(await signer.sign(serviceTokenClaims())), OPTIONS)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    for (let i = 0; i < 10; i++) {
      const token = await signer.sign(serviceTokenClaims(), { kid: `made-up-${i}` })
      expect(await verifyAccessIdentity(request(token), OPTIONS)).toBeNull()
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("stops trusting a cached key once its key set is stale", async () => {
    // A key that has been revoked at Cloudflare must stop working here without
    // a redeploy, so the TTL is checked before the cache hit — not after it.
    const token = await signer.sign(serviceTokenClaims({ exp: epoch(7200) }))
    expect((await verifyAccessIdentity(request(token), OPTIONS))?.verified).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(Date.now() + 11 * 60 * 1000))
      expect((await verifyAccessIdentity(request(token), OPTIONS))?.verified).toBe(true)
      expect(fetchMock).toHaveBeenCalledTimes(2)

      // …and if the endpoint is down when the set goes stale, it refuses
      // rather than serving the key it happens to still be holding.
      fetchMock.mockRejectedValue(new Error("network down"))
      vi.setSystemTime(new Date(Date.now() + 11 * 60 * 1000))
      expect(await verifyAccessIdentity(request(token), OPTIONS)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it("shares one in-flight fetch across concurrent verifications", async () => {
    const token = await signer.sign(serviceTokenClaims())
    const results = await Promise.all(
      Array.from({ length: 8 }, () => verifyAccessIdentity(request(token), OPTIONS)),
    )
    expect(results.every((identity) => identity?.verified === true)).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
