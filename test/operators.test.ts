import { describe, expect, it } from "vitest"
import { DEV_OPERATOR_EMAIL, readOperator } from "../src/operators"
import type { Env } from "../src/types"

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
  it("is nobody without an Access identity", () => {
    expect(readOperator(request(), env())).toBeNull()
    expect(readOperator(request(), env({ OPERATOR_EMAILS: "ops@example.test" }))).toBeNull()
  })

  it("admits an address on the configured list", () => {
    const configured = env({ OPERATOR_EMAILS: "ops@example.test, second@example.test" })
    expect(readOperator(asIdentity("ops@example.test"), configured)).toEqual({
      email: "ops@example.test",
    })
    expect(readOperator(asIdentity("second@example.test"), configured)).toEqual({
      email: "second@example.test",
    })
  })

  it("accepts the singular spelling the Gate-A contract suggests", () => {
    expect(readOperator(asIdentity("solo@example.test"), env({ OPERATOR_EMAIL: "solo@example.test" })))
      .toEqual({ email: "solo@example.test" })
  })

  it("splits a list on whitespace as well as commas", () => {
    const configured = env({ OPERATOR_EMAILS: "one@example.test\ntwo@example.test three@example.test" })
    for (const email of ["one@example.test", "two@example.test", "three@example.test"]) {
      expect(readOperator(asIdentity(email), configured)).toEqual({ email })
    }
  })

  it("matches case-insensitively but reports the address as presented", () => {
    // No identity provider treats the local part as case-sensitive in
    // practice, and an operator locked out by capitalisation they did not
    // choose is a bad failure. What the screen shows is still what they typed.
    const operator = readOperator(
      asIdentity("Ops@Example.Test"),
      env({ OPERATOR_EMAILS: "ops@example.test" }),
    )
    expect(operator).toEqual({ email: "Ops@Example.Test" })
  })

  it("rejects a customer identity that is not on the list", () => {
    const configured = env({ OPERATOR_EMAILS: "ops@example.test" })
    expect(readOperator(asIdentity("customer@example.test"), configured)).toBeNull()
    // Not a prefix or suffix match, either.
    expect(readOperator(asIdentity("ops@example.test.evil.test"), configured)).toBeNull()
    expect(readOperator(asIdentity("notops@example.test"), configured)).toBeNull()
  })

  it("grants nobody when unset behind Cloudflare's edge", () => {
    // The fail-closed half: a production deploy that forgets the secret has no
    // operator surface at all, rather than one that answers to whoever Access
    // happens to admit.
    expect(readOperator(asIdentity(DEV_OPERATOR_EMAIL, EDGE), env())).toBeNull()
    expect(readOperator(asIdentity("anyone@example.test", EDGE), env())).toBeNull()
  })

  it("honours the synthetic development operator only away from the edge", () => {
    expect(readOperator(asIdentity(DEV_OPERATOR_EMAIL), env())).toEqual({
      email: DEV_OPERATOR_EMAIL,
    })
    expect(readOperator(asIdentity("someone-else@example.test"), env())).toBeNull()
  })

  it("ignores the development fallback the moment a list is configured", () => {
    const configured = env({ OPERATOR_EMAILS: "ops-real@example.test" })
    expect(readOperator(asIdentity(DEV_OPERATOR_EMAIL), configured)).toBeNull()
  })

  it("treats a blank or malformed setting as unset", () => {
    for (const value of ["", "   ", ",,", "not-an-address"]) {
      expect(readOperator(asIdentity(DEV_OPERATOR_EMAIL), env({ OPERATOR_EMAILS: value }))).toEqual({
        email: DEV_OPERATOR_EMAIL,
      })
      expect(
        readOperator(asIdentity(DEV_OPERATOR_EMAIL, EDGE), env({ OPERATOR_EMAILS: value })),
      ).toBeNull()
    }
  })
})
