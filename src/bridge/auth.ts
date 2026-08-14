import { isBehindCloudflareEdge } from "../deployment"
import { verifyAccessIdentity } from "../identity"
import type { Env } from "../types"

/**
 * The service-token gate in front of `/api/bridge/*`.
 *
 * ── WHAT ACTUALLY AUTHENTICATES THE DAEMON ─────────────────────────────────
 * In production, a **fourth** Cloudflare Access application — scoped to
 * `intake.heurontech.com/api/bridge`, Service Auth policy, separate from the
 * site application and from the `/api/health` bypass — validates the
 * `CF-Access-Client-Id` / `CF-Access-Client-Secret` pair *before* the request
 * reaches this Worker. A request that fails there never gets here (it gets a
 * 403 from Access, which is why the 401 below is distinguishable from an Access
 * refusal by status code alone).
 *
 * That Access application is the control. This module is defence in depth for
 * the case it is misconfigured, absent, or bypassed, and the local gate for
 * `wrangler dev`, where there is no Access at all.
 *
 * ── WHY THIS IS NOT A HEADER COMPARISON ANY MORE (#70) ──────────────────────
 * It used to compare the presented pair against `BRIDGE_CLIENT_ID` /
 * `BRIDGE_CLIENT_SECRET` on every request, including behind the edge. Measured
 * against production on 2026-08-13 with both secrets set byte-exact from the
 * token Access itself accepts, that comparison **can never succeed**: a wrong
 * secret is refused at the edge (403) and a correct one is admitted but at
 * least one half is consumed there rather than forwarded, so the Worker sees an
 * incomplete credential and refuses a correctly-configured daemon with a flat
 * 401. Not misconfigured — structurally unsatisfiable, and it had been since
 * ms-1 because nothing called the bridge until #2179 built the client. The full
 * measurement table is in `src/identity.ts`'s module comment.
 *
 * The defence-in-depth intent survives; the mechanism changed. Behind the edge
 * the daemon is now recognised by the thing Access actually forwards — the
 * signed `Cf-Access-Jwt-Assertion` — verified against the team's JWKS with
 * `iss`, `aud` and `exp` pinned, and required to name the expected service
 * token. That is a stronger check than the old one: it cannot be satisfied by
 * a header a client sets, only by a token Cloudflare signed for *this*
 * application.
 *
 * ── HOW IT DECIDES ─────────────────────────────────────────────────────────
 * 1. A presented pair that matches configured `BRIDGE_CLIENT_ID` /
 *    `BRIDGE_CLIENT_SECRET` exactly authorises anywhere. This is the old rule,
 *    kept because knowing the secret is still proof and it costs no network
 *    call — it simply is not reachable behind the edge today. If Cloudflare
 *    ever starts forwarding both halves, this lights up again on its own.
 * 2. Behind Cloudflare's edge (`CF-Ray`, see `src/deployment.ts`), otherwise:
 *    a **verified** Access assertion whose `common_name` is the configured
 *    `BRIDGE_CLIENT_ID`. Requires `ACCESS_TEAM_DOMAIN` and `BRIDGE_ACCESS_AUD`
 *    to be configured; any of the three unset ⇒ refuse. A human's token, a
 *    token minted for the site application (wrong `aud`), an expired one, an
 *    unsigned one, and an unreachable JWKS all refuse. `/api/bridge` authorises
 *    the daemon and nothing else; it must never widen into a general Access
 *    bypass.
 * 3. Off the edge — no `CF-Ray`, so `wrangler dev`, the e2e smoke net, the
 *    sealed acceptance run — where there is no Access and no JWT to verify: a
 *    well-formed pair (both headers present and non-empty) is honoured, exactly
 *    as before. Half a credential is not a credential. This relaxation keys off
 *    the *absence* of a header only the edge can set, so a client who forges
 *    `CF-Ray` lands in the stricter branch, which is the direction that costs
 *    them. Note it cannot key off the hostname; `wrangler dev` serves the
 *    custom domain from a laptop.
 *
 * ⚠ OPERATIONAL CONSEQUENCE OF (2): production needs three settings, not two —
 * `BRIDGE_CLIENT_ID`, `ACCESS_TEAM_DOMAIN`, `BRIDGE_ACCESS_AUD`. Notably
 * `BRIDGE_CLIENT_SECRET` is *not* among them: the verified path never sees a
 * secret, so the copy the Worker holds is now only the local-dev/legacy half of
 * rule (1). See README.md § The sync bridge.
 *
 * Missing or invalid ⇒ 401 with an empty body and no detail about what was
 * wrong: which half was missing, whether a well-formed pair was simply the
 * wrong one, and which of the four verification checks fired are all facts an
 * attacker would like and the daemon does not need. What the *operator* needs
 * goes to the Workers log instead — see `noteEdgeRefusal`.
 */

const CLIENT_ID_HEADER = "CF-Access-Client-Id"
const CLIENT_SECRET_HEADER = "CF-Access-Client-Secret"
const JWT_HEADER = "Cf-Access-Jwt-Assertion"

export async function isBridgeAuthorized(request: Request, env: Env): Promise<boolean> {
  try {
    return await decide(request, env)
  } catch {
    // A gate that throws must refuse, not 500. A 500 is a louder answer than a
    // 401 to whoever is probing, and an availability bug in the JWKS path must
    // never become an authorization bug.
    return false
  }
}

async function decide(request: Request, env: Env): Promise<boolean> {
  const presentedId = header(request, CLIENT_ID_HEADER)
  const presentedSecret = header(request, CLIENT_SECRET_HEADER)

  const expectedId = trimmed(env.BRIDGE_CLIENT_ID)
  const expectedSecret = trimmed(env.BRIDGE_CLIENT_SECRET)
  const configured = expectedId !== "" && expectedSecret !== ""

  // (1) The full pair, if it ever arrives intact.
  if (configured && presentedId && presentedSecret) {
    if (
      constantTimeEqual(presentedId, expectedId) &&
      constantTimeEqual(presentedSecret, expectedSecret)
    ) {
      return true
    }
  }

  // (2) Behind the edge: the signed assertion, or nothing.
  if (isBehindCloudflareEdge(request)) {
    return await authorizedByAccessToken(request, env, expectedId)
  }

  // (3) Off the edge: a well-formed pair, and it must match if one is
  //     configured — a mismatch already fell through (1) above.
  if (!presentedId || !presentedSecret) return false
  return !configured
}

/**
 * The production path: prove the assertion, then require it to name the daemon.
 */
async function authorizedByAccessToken(
  request: Request,
  env: Env,
  expectedId: string,
): Promise<boolean> {
  const identity =
    expectedId === ""
      ? null
      : await verifyAccessIdentity(request, {
          teamDomain: env.ACCESS_TEAM_DOMAIN,
          audience: env.BRIDGE_ACCESS_AUD,
        })

  // A verified *human* has no `common_name` and is refused here: the bridge is
  // not a customer surface, and a signed-in operator must not be able to read
  // the event stream by pointing a browser at it.
  if (identity && identity.commonName && constantTimeEqual(identity.commonName, expectedId)) {
    return true
  }

  noteEdgeRefusal(request, env, identity?.claims)
  return false
}

/**
 * The measurement instrument (#70).
 *
 * This bug existed because a header's behaviour was assumed rather than
 * measured, and the assumption was invisible from outside: an empty-bodied 401
 * says nothing, deliberately. So a refusal *behind the edge* — where a real
 * daemon request is the only thing that can tell us what Cloudflare actually
 * forwards — leaves one line in `wrangler tail`.
 *
 * NOTHING SECRET IS LOGGED: header *presence* as booleans, claim *names* only,
 * and which settings are absent. No values, no token, no claim contents, no
 * email. Anything added here must keep that property — Workers logs are not a
 * place to put a credential, and this repo is public so the format is too.
 *
 * Only fires when the request carried some Access artifact, so a probe with no
 * headers at all cannot turn the log into a flood.
 */
function noteEdgeRefusal(
  request: Request,
  env: Env,
  claims: Readonly<Record<string, unknown>> | undefined,
): void {
  const hasId = header(request, CLIENT_ID_HEADER) !== ""
  const hasSecret = header(request, CLIENT_SECRET_HEADER) !== ""
  const hasJwt = header(request, JWT_HEADER) !== ""
  if (!hasId && !hasSecret && !hasJwt) return

  const missing = [
    trimmed(env.BRIDGE_CLIENT_ID) === "" ? "BRIDGE_CLIENT_ID" : null,
    trimmed(env.ACCESS_TEAM_DOMAIN) === "" ? "ACCESS_TEAM_DOMAIN" : null,
    trimmed(env.BRIDGE_ACCESS_AUD) === "" ? "BRIDGE_ACCESS_AUD" : null,
  ].filter((name): name is string => name !== null)

  console.warn(
    "bridge: refused behind the edge —",
    `client-id header: ${hasId}, client-secret header: ${hasSecret}, jwt header: ${hasJwt},`,
    `verified claims: ${claims ? Object.keys(claims).sort().join("|") || "(none)" : "(unverified)"},`,
    `unset settings: ${missing.length > 0 ? missing.join("|") : "(none)"}`,
  )
}

/**
 * The one response shape every bridge rejection uses. `null` body, so the ways
 * to fail (no headers, one header, wrong pair, unverifiable token) are
 * byte-identical from the outside.
 */
export function bridgeUnauthorized(): Response {
  return new Response(null, {
    status: 401,
    headers: { "cache-control": "no-store" },
  })
}

function header(request: Request, name: string): string {
  return (request.headers.get(name) ?? "").trim()
}

function trimmed(value: string | undefined): string {
  return (value ?? "").trim()
}

/**
 * Compares two secrets without short-circuiting on the first differing byte.
 *
 * Not `a === b`: string equality returns as soon as it finds a mismatch, and
 * the time it took is a hint about how much of the secret was right. The length
 * still leaks (the loop runs `max(a, b)` times) which is an accepted trade — a
 * service token's length is not the secret part.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder()
  const left = encoder.encode(a)
  const right = encoder.encode(b)

  let diff = left.length ^ right.length
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0)
  }
  return diff === 0
}
