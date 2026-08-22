import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clearAccessJwksCache } from "../src/identity"
import { DEV_OPERATOR_EMAIL, isOperatorEmail, readOperator } from "../src/operators"
import type { Env } from "../src/types"
import { accessSigner, epoch, unsignedToken, type AccessSigner } from "./accessToken"

/**
 * Unit coverage for the operator allowlist (issue #33) — the first check in
 * this repo that asks "is this caller staff" rather than "does this caller own
 * this row".
 *
 * The behaviour that matters here is what happens when nothing is configured,
 * because that is the state a fresh deploy is in: behind Cloudflare's edge it
 * must grant nobody, and only away from the edge (`wrangler dev`, the e2e smoke
 * net, the sealed acceptance run) does the synthetic development operator
 * stand in for a configured list. Every address below is invented.
 *
 * `readOperator` is now async (#1981): behind Cloudflare's edge it resolves
 * the caller's identity through `resolveSiteIdentity`, which proves the
 * `Cf-Access-Jwt-Assertion` against the JWKS rather than trusting an
 * unverified header claim. The "behind the edge, on a verified assertion"
 * block below is what pins that — everything above it stays on the plain
 * unverified header, exactly the off-edge behaviour this file has always
 * covered.
 */

function env(overrides: Partial<Env> = {}): Env {
  return overrides as Env
}

function request(headers: Record<string, string> = {}): Request {
  return new Request("https://portal.test/leads", { headers })
}

function asIdentity(email: string, extra: Record<string, string> = {}): Request {
  return request({ "Cf-Access-Authenticated-User-Email": email, ...extra })
}

/** What Cloudflare's edge adds to every request it forwards. */
const EDGE = { "CF-Ray": "8f0000000000abcd-LHR" }

describe("readOperator", () => {
  it("is nobody without an Access identity", async () => {
    expect(await readOperator(request(), env())).toBeNull()
    expect(await readOperator(request(), env({ OPERATOR_EMAILS: "ops@example.test" }))).toBeNull()
  })

  it("admits an address on the configured list", async () => {
    const configured = env({ OPERATOR_EMAILS: "ops@example.test, second@example.test" })
    expect(await readOperator(asIdentity("ops@example.test"), configured)).toEqual({
      email: "ops@example.test",
    })
    expect(await readOperator(asIdentity("second@example.test"), configured)).toEqual({
      email: "second@example.test",
    })
  })

  it("accepts the singular spelling the Gate-A contract suggests", async () => {
    expect(
      await readOperator(asIdentity("solo@example.test"), env({ OPERATOR_EMAIL: "solo@example.test" })),
    ).toEqual({ email: "solo@example.test" })
  })

  it("splits a list on whitespace as well as commas", async () => {
    const configured = env({ OPERATOR_EMAILS: "one@example.test\ntwo@example.test three@example.test" })
    for (const email of ["one@example.test", "two@example.test", "three@example.test"]) {
      expect(await readOperator(asIdentity(email), configured)).toEqual({ email })
    }
  })

  it("matches case-insensitively but reports the address as presented", async () => {
    // No identity provider treats the local part as case-sensitive in
    // practice, and an operator locked out by capitalisation they did not
    // choose is a bad failure. What the screen shows is still what they typed.
    const operator = await readOperator(
      asIdentity("Ops@Example.Test"),
      env({ OPERATOR_EMAILS: "ops@example.test" }),
    )
    expect(operator).toEqual({ email: "Ops@Example.Test" })
  })

  it("rejects a customer identity that is not on the list", async () => {
    const configured = env({ OPERATOR_EMAILS: "ops@example.test" })
    expect(await readOperator(asIdentity("customer@example.test"), configured)).toBeNull()
    // Not a prefix or suffix match, either.
    expect(await readOperator(asIdentity("ops@example.test.evil.test"), configured)).toBeNull()
    expect(await readOperator(asIdentity("notops@example.test"), configured)).toBeNull()
  })

  it("grants nobody when unset behind Cloudflare's edge", async () => {
    // The fail-closed half: a production deploy that forgets the secret has no
    // operator surface at all, rather than one that answers to whoever Access
    // happens to admit.
    expect(await readOperator(asIdentity(DEV_OPERATOR_EMAIL, EDGE), env())).toBeNull()
    expect(await readOperator(asIdentity("anyone@example.test", EDGE), env())).toBeNull()
  })

  it("honours the synthetic development operator only away from the edge", async () => {
    expect(await readOperator(asIdentity(DEV_OPERATOR_EMAIL), env())).toEqual({
      email: DEV_OPERATOR_EMAIL,
    })
    expect(await readOperator(asIdentity("someone-else@example.test"), env())).toBeNull()
  })

  it("ignores the development fallback the moment a list is configured", async () => {
    const configured = env({ OPERATOR_EMAILS: "ops-real@example.test" })
    expect(await readOperator(asIdentity(DEV_OPERATOR_EMAIL), configured)).toBeNull()
  })

  it("treats a blank or malformed setting as unset", async () => {
    for (const value of ["", "   ", ",,", "not-an-address"]) {
      expect(
        await readOperator(asIdentity(DEV_OPERATOR_EMAIL), env({ OPERATOR_EMAILS: value })),
      ).toEqual({
        email: DEV_OPERATOR_EMAIL,
      })
      expect(
        await readOperator(asIdentity(DEV_OPERATOR_EMAIL, EDGE), env({ OPERATOR_EMAILS: value })),
      ).toBeNull()
    }
  })
})

/**
 * `isOperatorEmail` (issue #103's non-blocking review finding): the same
 * allowlist decision as `readOperator`, but for a caller that has already
 * resolved and verified its own identity this request — a plain, synchronous
 * lookup against the email handed in, no second `resolveSiteIdentity` call
 * and so no second JWT verification. Every case below has a `readOperator`
 * counterpart above; what's pinned here is that the two agree, given the
 * same already-resolved email, on every input that matters to the allowlist
 * itself (the JWT-verification cases above are specific to `readOperator`,
 * which resolves identity itself — `isOperatorEmail` takes identity as a
 * given).
 */
describe("isOperatorEmail", () => {
  it("is false with no email", () => {
    expect(isOperatorEmail(null, request(), env())).toBe(false)
    expect(isOperatorEmail(null, request(), env({ OPERATOR_EMAILS: "ops@example.test" }))).toBe(
      false,
    )
  })

  it("admits an address on the configured list", () => {
    const configured = env({ OPERATOR_EMAILS: "ops@example.test, second@example.test" })
    expect(isOperatorEmail("ops@example.test", request(), configured)).toBe(true)
    expect(isOperatorEmail("second@example.test", request(), configured)).toBe(true)
  })

  it("matches case-insensitively", () => {
    expect(
      isOperatorEmail("Ops@Example.Test", request(), env({ OPERATOR_EMAILS: "ops@example.test" })),
    ).toBe(true)
  })

  it("rejects a customer identity that is not on the list", () => {
    const configured = env({ OPERATOR_EMAILS: "ops@example.test" })
    expect(isOperatorEmail("customer@example.test", request(), configured)).toBe(false)
    expect(isOperatorEmail("ops@example.test.evil.test", request(), configured)).toBe(false)
  })

  it("grants nobody when unset behind Cloudflare's edge, honours the dev fallback off it", () => {
    expect(isOperatorEmail(DEV_OPERATOR_EMAIL, request(EDGE), env())).toBe(false)
    expect(isOperatorEmail(DEV_OPERATOR_EMAIL, request(), env())).toBe(true)
    expect(isOperatorEmail("someone-else@example.test", request(), env())).toBe(false)
  })

  it("ignores the development fallback the moment a list is configured", () => {
    const configured = env({ OPERATOR_EMAILS: "ops-real@example.test" })
    expect(isOperatorEmail(DEV_OPERATOR_EMAIL, request(), configured)).toBe(false)
  })
})

/**
 * The production path (#1981): behind the edge, an unverified header claim —
 * even one naming an address that IS on the allowlist — must not read anyone
 * in any more. Only a `Cf-Access-Jwt-Assertion` that verifies against the
 * team's JWKS, pinned to the *site* application's own AUD, does.
 *
 * Every credential, team domain and AUD tag below is invented — see
 * CLAUDE.md rule 1.
 */
describe("readOperator behind the edge, on a verified Access assertion", () => {
  const TEAM = "example-team.cloudflareaccess.com"
  const ISSUER = `https://${TEAM}`
  const SITE_AUD = "3333333333333333333333333333333333333333333333333333333333333333"
  const BRIDGE_AUD = "4444444444444444444444444444444444444444444444444444444444444444"
  const OPERATOR_EMAIL = "ops@example.test"

  let signer: AccessSigner
  let fetchMock: ReturnType<typeof vi.fn>

  function envWithAccess(overrides: Partial<Env> = {}): Env {
    return {
      ACCESS_TEAM_DOMAIN: TEAM,
      SITE_ACCESS_AUD: SITE_AUD,
      OPERATOR_EMAILS: OPERATOR_EMAIL,
      ...overrides,
    } as Env
  }

  function claims(overrides: Record<string, unknown> = {}) {
    return {
      iss: ISSUER,
      aud: [SITE_AUD],
      exp: epoch(600),
      email: OPERATOR_EMAIL,
      ...overrides,
    }
  }

  function edgeRequest(token?: string, extra: Record<string, string> = {}): Request {
    return request({
      "CF-Ray": "8f0000000000abcd-LHR",
      ...(token ? { "Cf-Access-Jwt-Assertion": token } : {}),
      ...extra,
    })
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

  it("admits an operator on a verified, correctly-audienced assertion", async () => {
    const token = await signer.sign(claims())
    expect(await readOperator(edgeRequest(token), envWithAccess())).toEqual({
      email: OPERATOR_EMAIL,
    })
  })

  it("refuses the exact forged {alg:none} shape measured against this Worker — the vulnerability this closes", async () => {
    // The unverified header claim that used to be enough on its own.
    const forgedHeader = edgeRequest(undefined, { "Cf-Access-Authenticated-User-Email": OPERATOR_EMAIL })
    expect(await readOperator(forgedHeader, envWithAccess())).toBeNull()

    // A self-minted, unsigned JWT naming the same allowlisted address.
    const forgedJwt = unsignedToken(claims(), signer.kid)
    expect(await readOperator(edgeRequest(forgedJwt), envWithAccess())).toBeNull()
  })

  it("refuses an assertion minted for the bridge application — AUDs are not interchangeable", async () => {
    const token = await signer.sign(claims({ aud: [BRIDGE_AUD] }))
    expect(await readOperator(edgeRequest(token), envWithAccess())).toBeNull()
  })

  it("refuses an expired assertion", async () => {
    const token = await signer.sign(claims({ exp: epoch(-1) }))
    expect(await readOperator(edgeRequest(token), envWithAccess())).toBeNull()
  })

  it("refuses a verified assertion for an address that is not on the allowlist", async () => {
    const token = await signer.sign(claims({ email: "not-an-operator@example.test" }))
    expect(await readOperator(edgeRequest(token), envWithAccess())).toBeNull()
  })

  it("fails closed when SITE_ACCESS_AUD or ACCESS_TEAM_DOMAIN is unset, even with a valid assertion and a configured allowlist", async () => {
    const token = await signer.sign(claims())
    expect(
      await readOperator(edgeRequest(token), envWithAccess({ SITE_ACCESS_AUD: undefined })),
    ).toBeNull()
    expect(
      await readOperator(edgeRequest(token), envWithAccess({ ACCESS_TEAM_DOMAIN: undefined })),
    ).toBeNull()
  })
})
