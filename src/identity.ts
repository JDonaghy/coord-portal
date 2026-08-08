/**
 * Reading the caller's identity from Cloudflare Access.
 *
 * ── READ THIS BEFORE USING IT ──────────────────────────────────────────────
 * Nothing here is authentication. Access, when it is actually in front of this
 * Worker, injects `Cf-Access-Authenticated-User-Email` and a signed
 * `Cf-Access-Jwt-Assertion`. This module reads them; it does **not** verify the
 * JWT signature against the team's JWKS, so a request that reaches the Worker
 * without passing through Access can set both headers to anything it likes.
 *
 * Therefore `verified` is hard-coded `false` and no caller may make an
 * authorization decision from this. Signature verification, the JWKS fetch and
 * its cache, and the audience check are #1981. When that lands, this file gains
 * an async `verifyAccessIdentity()` and `verified` becomes meaningful — the
 * shape below exists so that change is additive rather than a rewrite.
 */

export type IdentitySource = "cf-access-header" | "cf-access-jwt" | "none"

export interface AccessIdentity {
  email: string | null
  /** Always false until #1981. Never branch on this expecting true. */
  verified: false
  source: IdentitySource
}

const EMAIL_HEADER = "Cf-Access-Authenticated-User-Email"
const JWT_HEADER = "Cf-Access-Jwt-Assertion"

export function readAccessIdentity(request: Request): AccessIdentity {
  const header = request.headers.get(EMAIL_HEADER)
  if (header && header.includes("@")) {
    return { email: header, verified: false, source: "cf-access-header" }
  }

  const jwt = request.headers.get(JWT_HEADER)
  const claimed = jwt ? emailFromUnverifiedJwt(jwt) : null
  if (claimed) {
    return { email: claimed, verified: false, source: "cf-access-jwt" }
  }

  return { email: null, verified: false, source: "none" }
}

/**
 * Decodes a JWT payload WITHOUT verifying its signature, purely to surface who
 * the request claims to be. See the module comment.
 */
function emailFromUnverifiedJwt(jwt: string): string | null {
  const parts = jwt.split(".")
  const payload = parts.length === 3 ? parts[1] : undefined
  if (!payload) return null

  try {
    const padded = payload.replace(/-/g, "+").replace(/_/g, "/")
    const json = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="))
    const claims: unknown = JSON.parse(json)
    if (typeof claims !== "object" || claims === null) return null
    const email = (claims as Record<string, unknown>)["email"]
    return typeof email === "string" && email.includes("@") ? email : null
  } catch {
    return null
  }
}
