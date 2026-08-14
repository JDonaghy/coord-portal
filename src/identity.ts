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
 * Therefore `readAccessIdentity`'s `verified` is hard-coded `false` and no
 * caller may make an authorization decision from it. The verified reading is
 * `verifyAccessIdentity()` at the bottom of this file (#70): async, JWKS-backed,
 * signature + `iss` + `aud` + `exp` checked, and it returns `null` — never a
 * half-trusted object — for anything it could not prove.
 *
 * ── MEASURED AGAINST THE LIVE DEPLOYMENT, 2026-08-08 ───────────────────────
 * The two headers are NOT equally trustworthy, and the difference is not
 * documented anywhere obvious:
 *
 *   Cf-Access-Authenticated-User-Email  — STRIPPED by Cloudflare's edge on a
 *       request that did not come through Access. A client cannot set it.
 *   Cf-Access-Jwt-Assertion             — PASSES THROUGH UNTOUCHED. A curl with
 *       a self-minted `{"alg":"none"}` token was parsed by this Worker and came
 *       back as `attacker@example.test`.
 *
 * So the *unverified* JWT path is client-controlled, and `verified: false` is
 * the only thing standing in front of it. `verifyAccessIdentity()` is not
 * hardening; it is the control. Do not "simplify" by trusting either header,
 * and do not assume the stripping behaviour above is a contract — it is
 * observed, not promised.
 *
 * ── WHAT SURVIVES THE EDGE ON A SERVICE-TOKEN REQUEST (#70) ────────────────
 * Measured against production 2026-08-13 from the daemon host, through the
 * fourth Access application (Service Auth, `intake.heurontech.com/api/bridge`),
 * with `BRIDGE_CLIENT_ID` / `BRIDGE_CLIENT_SECRET` both set to the byte-exact
 * values Access itself accepts:
 *
 *   correct client id + correct secret → 401 from this Worker (empty body)
 *   correct client id + wrong secret   → 403 from Cloudflare Access
 *   no credential headers at all       → 403 from Cloudflare Access
 *
 * Access is therefore configured correctly and the secrets are correct — a
 * wrong secret never reaches the Worker, so the 401 row cannot be a value
 * mismatch. The only reading left is that at least one half of the
 * `CF-Access-Client-Id` / `CF-Access-Client-Secret` pair is **consumed at the
 * edge and not forwarded**, so a plaintext comparison against it inside the
 * Worker is structurally unsatisfiable, not misconfigured. It had been since
 * ms-1 and nobody noticed because nothing called the bridge until #2179.
 *
 * WHICH half is stripped is NOT yet measured, and this module does not guess:
 * the verified path below ignores both headers behind the edge and reads the
 * signed assertion instead. `src/bridge/auth.ts` logs (header presence only,
 * never values) what actually arrived on a refusal, so the first real daemon
 * request finishes the measurement in `wrangler tail` rather than in an
 * argument.
 *
 * The claim naming a service token is **expected** to be `common_name`
 * (carrying the client id) rather than `email`, which is why `commonName` is
 * surfaced separately below — but that expectation is unverified against a live
 * service-token assertion. It is asserted nowhere except in
 * `src/bridge/auth.ts`'s one comparison, and a token that carries some other
 * claim shape refuses (fail closed) and logs its claim *names* so the next
 * change is informed rather than assumed. Do not promote this paragraph to
 * "measured" without a `wrangler tail` line to point at.
 */

export type IdentitySource = "cf-access-header" | "cf-access-jwt" | "none"

export interface AccessIdentity {
  email: string | null
  /**
   * Always false from `readAccessIdentity`, which checks nothing. Never branch
   * on this expecting true; call `verifyAccessIdentity` if you need proof.
   */
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

/* ───────────────────────────────────────────────────────────────────────────
 * The verified reading (#70).
 *
 * Everything below proves the assertion before it believes a word of it:
 * RS256 signature against a key from the team's JWKS, `iss` pinned to the
 * configured team domain, `aud` pinned to the calling application's AUD tag,
 * `exp` in the future. Anything it cannot prove — a missing header, an
 * unreachable JWKS, an unknown `kid`, `alg: none`, a wrong audience, an expired
 * token — returns `null`. There is deliberately no "partially verified" value
 * to accidentally branch on, and no reason string in the return: callers turn
 * `null` into the same opaque refusal their surface already uses.
 * ─────────────────────────────────────────────────────────────────────────── */

/** A verified Access assertion. Only constructed after every check passes. */
export interface VerifiedAccessIdentity {
  verified: true
  source: "cf-access-jwt"
  /** The human's email, when the token is a human's. `null` for a service token. */
  email: string | null
  /**
   * The service token's client id, from the `common_name` claim. `null` for a
   * human. This is what `src/bridge/auth.ts` matches the daemon on.
   */
  commonName: string | null
  /** Every claim, verified. Read a new one from here rather than widening this type. */
  claims: Readonly<Record<string, unknown>>
}

export interface AccessVerificationOptions {
  /**
   * The team domain, e.g. `example.cloudflareaccess.com` (with or without a
   * scheme). Pins both the JWKS URL and the accepted `iss`. Unset ⇒ refuse.
   */
  teamDomain: string | undefined
  /**
   * The AUD tag of the Access application that is supposed to have issued this
   * token. Pins `aud`, so a token minted for the *site* application cannot be
   * replayed at the bridge. Unset ⇒ refuse.
   */
  audience: string | undefined
}

/**
 * How long a fetched JWKS is reused. Cloudflare rotates Access signing keys
 * roughly every 6 weeks with an overlap, so this is about limiting how long a
 * revoked key stays usable, not about catching a rotation in time.
 */
const JWKS_TTL_MS = 10 * 60 * 1000

/**
 * Floor between JWKS fetches when a token names a `kid` we have never seen. A
 * rotation should be picked up immediately, but an attacker minting tokens with
 * random `kid`s must not turn this Worker into a fetch amplifier pointed at
 * Cloudflare's own certs endpoint.
 */
const JWKS_UNKNOWN_KID_REFETCH_MS = 60 * 1000

interface Jwks {
  fetchedAt: number
  keys: Map<string, CryptoKey>
}

const jwksCache = new Map<string, Jwks>()
const jwksInFlight = new Map<string, Promise<Jwks | null>>()

/**
 * Drops the cached JWKS. For tests, and for a future "the team rotated a key
 * early" hook; nothing in the request path needs to call it.
 */
export function clearAccessJwksCache(): void {
  jwksCache.clear()
  jwksInFlight.clear()
}

/**
 * Verifies the `Cf-Access-Jwt-Assertion` on this request, or returns `null`.
 *
 * Never throws: a caller's authorization decision must not turn into a 500,
 * and a 500 is a louder answer than a 401 to whoever is probing.
 */
export async function verifyAccessIdentity(
  request: Request,
  options: AccessVerificationOptions,
): Promise<VerifiedAccessIdentity | null> {
  try {
    return await verifyAssertion(request.headers.get(JWT_HEADER), options)
  } catch {
    return null
  }
}

async function verifyAssertion(
  token: string | null,
  options: AccessVerificationOptions,
): Promise<VerifiedAccessIdentity | null> {
  const issuer = issuerFrom(options.teamDomain)
  const audience = (options.audience ?? "").trim()
  // Unconfigured is not "skip the check" — it is a refusal. A deploy that
  // forgets these gets a bridge that answers nobody, never one that answers
  // everybody.
  if (!issuer || !audience || !token) return null

  const parts = token.trim().split(".")
  if (parts.length !== 3) return null
  const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string]

  const header = decodeJson(rawHeader)
  const claims = decodeJson(rawPayload)
  if (!header || !claims) return null

  // `alg` is attacker-supplied, so it is checked against what we will do rather
  // than used to decide what to do. `none` and the HMAC family (which would let
  // a public key be used as the shared secret) never reach the verifier.
  if (header["alg"] !== "RS256") return null
  const kid = header["kid"]
  if (typeof kid !== "string" || kid === "") return null

  const key = await signingKey(issuer, kid)
  if (!key) return null

  const signed = new TextEncoder().encode(`${rawHeader}.${rawPayload}`)
  const signature = base64UrlToBytes(rawSignature)
  if (!signature) return null

  const signatureOk = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    signature,
    signed,
  )
  if (!signatureOk) return null

  if (claims["iss"] !== issuer) return null
  if (!audienceIncludes(claims["aud"], audience)) return null

  const exp = claims["exp"]
  if (typeof exp !== "number" || !Number.isFinite(exp)) return null
  // No leeway on expiry, deliberately: "a bit expired" is expired, and the
  // acceptance contract for #70 asserts an expired token is refused.
  if (exp * 1000 <= Date.now()) return null

  const nbf = claims["nbf"]
  if (typeof nbf === "number" && nbf * 1000 > Date.now() + 60_000) return null

  const email = claims["email"]
  const commonName = claims["common_name"]

  return {
    verified: true,
    source: "cf-access-jwt",
    email: typeof email === "string" && email.includes("@") ? email : null,
    commonName: typeof commonName === "string" && commonName !== "" ? commonName : null,
    claims,
  }
}

/**
 * `example.cloudflareaccess.com` → `https://example.cloudflareaccess.com`.
 *
 * The origin is both the JWKS host and the exact `iss` accepted, so a token
 * signed by some other Cloudflare team is refused rather than verified against
 * its own issuer's keys — which would be no check at all.
 */
function issuerFrom(teamDomain: string | undefined): string | null {
  const raw = (teamDomain ?? "").trim().replace(/\/+$/, "")
  if (!raw) return null
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`)
    if (url.protocol !== "https:" || !url.hostname) return null
    return url.origin
  } catch {
    return null
  }
}

function audienceIncludes(aud: unknown, expected: string): boolean {
  if (typeof aud === "string") return aud === expected
  if (Array.isArray(aud)) return aud.some((entry) => entry === expected)
  return false
}

async function signingKey(issuer: string, kid: string): Promise<CryptoKey | null> {
  const cached = jwksCache.get(issuer)
  if (cached) {
    const key = cached.keys.get(kid)
    if (key) return key
    const age = Date.now() - cached.fetchedAt
    if (age < JWKS_UNKNOWN_KID_REFETCH_MS) return null
    if (age < JWKS_TTL_MS) {
      // Unknown kid on a still-fresh JWKS: could be a rotation, so re-fetch —
      // but no more often than the floor above.
      return (await loadJwks(issuer))?.keys.get(kid) ?? null
    }
  }
  return (await loadJwks(issuer))?.keys.get(kid) ?? null
}

async function loadJwks(issuer: string): Promise<Jwks | null> {
  const inFlight = jwksInFlight.get(issuer)
  // One fetch per issuer at a time: a burst of daemon requests on a cold
  // isolate should not become a burst of JWKS fetches.
  if (inFlight) return inFlight

  const pending = fetchJwks(issuer)
    .then((jwks) => {
      // A failed fetch leaves the previous JWKS in place if there is one — it
      // was valid a moment ago — and leaves nothing cached if there is not,
      // which refuses. Failure never installs an empty key set.
      if (jwks) jwksCache.set(issuer, jwks)
      return jwks
    })
    .catch(() => null)
    .finally(() => {
      jwksInFlight.delete(issuer)
    })

  jwksInFlight.set(issuer, pending)
  return pending
}

async function fetchJwks(issuer: string): Promise<Jwks | null> {
  const response = await fetch(`${issuer}/cdn-cgi/access/certs`, {
    headers: { accept: "application/json" },
  })
  if (!response.ok) return null

  const body: unknown = await response.json()
  if (typeof body !== "object" || body === null) return null
  const rawKeys = (body as Record<string, unknown>)["keys"]
  if (!Array.isArray(rawKeys)) return null

  const keys = new Map<string, CryptoKey>()
  for (const entry of rawKeys) {
    if (typeof entry !== "object" || entry === null) continue
    const jwk = entry as Record<string, unknown>
    const { kid, kty, n, e } = jwk
    if (typeof kid !== "string" || kty !== "RSA") continue
    if (typeof n !== "string" || typeof e !== "string") continue
    if (jwk["alg"] !== undefined && jwk["alg"] !== "RS256") continue

    try {
      // Rebuilt from named fields rather than passing the JWKS entry through:
      // whatever else the endpoint sends is not something to hand to WebCrypto.
      keys.set(
        kid,
        await crypto.subtle.importKey(
          "jwk",
          { kty: "RSA", n, e, alg: "RS256" },
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"],
        ),
      )
    } catch {
      // A key that will not import is a key nothing can be verified with.
    }
  }

  return keys.size > 0 ? { fetchedAt: Date.now(), keys } : null
}

function decodeJson(segment: string): Record<string, unknown> | null {
  const bytes = base64UrlToBytes(segment)
  if (!bytes) return null
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null
    return value as Record<string, unknown>
  } catch {
    return null
  }
}

function base64UrlToBytes(segment: string): Uint8Array | null {
  if (segment === "" || /[^A-Za-z0-9_-]/.test(segment)) return null
  const padded = segment
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(segment.length / 4) * 4, "=")
  try {
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}
