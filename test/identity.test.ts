import { describe, expect, it } from "vitest"

import { readAccessIdentity } from "../src/identity"
import worker from "../src/index"
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
  // come back as verified — the JWKS check is #1981 and until it lands nothing
  // may treat this identity as trusted.
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
