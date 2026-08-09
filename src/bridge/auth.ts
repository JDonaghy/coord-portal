import { isBehindCloudflareEdge } from "../deployment"
import type { Env } from "../types"

/**
 * The service-token gate in front of `/api/bridge/*`.
 *
 * ── WHAT ACTUALLY AUTHENTICATES THE DAEMON ─────────────────────────────────
 * In production, a **third** Cloudflare Access application — scoped to
 * `intake.heurontech.com/api/bridge`, Service Auth policy, separate from the
 * site application and from the `/api/health` bypass — validates the
 * `CF-Access-Client-Id` / `CF-Access-Client-Secret` pair *before* the request
 * reaches this Worker. A request that fails there never gets here.
 *
 * That Access application is the control. This module is defence in depth for
 * the case it is misconfigured, absent, or bypassed, and the local gate for
 * `wrangler dev`, where there is no Access at all.
 *
 * ── HOW IT DECIDES ─────────────────────────────────────────────────────────
 * 1. A well-formed pair (both headers present and non-empty) is required
 *    always. Half a credential is not a credential, and a signed-in human's
 *    `Cf-Access-Authenticated-User-Email` is not one either — the bridge is not
 *    a customer surface and `/api/bridge` must never widen into a general
 *    Access bypass.
 * 2. If `BRIDGE_CLIENT_ID` and `BRIDGE_CLIENT_SECRET` are configured
 *    (`wrangler secret put`, never `wrangler.toml` — this repo is public), the
 *    presented pair must match them.
 * 3. If they are *not* configured:
 *      - on a request that did not come through Cloudflare's edge — no
 *        `CF-Ray`, so `wrangler dev`, the e2e smoke net, the sealed acceptance
 *        run — a well-formed pair is honoured. This is the same position
 *        `src/identity.ts` takes for the Access email header: locally the
 *        header is the mechanism, because there is nothing else to check it
 *        against. Note this cannot key off the hostname; `wrangler dev` serves
 *        the custom domain from a laptop. See `src/deployment.ts`.
 *      - on a request that DID come through the edge, it is refused. Failing
 *        closed means a production deploy that forgets the secret gets a bridge
 *        that answers nobody, rather than one that answers everybody if the
 *        Access application is ever misconfigured or removed.
 *
 * ⚠ OPERATIONAL CONSEQUENCE OF (3): after deploying, `wrangler secret put
 * BRIDGE_CLIENT_ID` and `BRIDGE_CLIENT_SECRET` with the service token's values
 * or the daemon gets a flat 401 no matter what Access says. That is deliberate.
 * See README.md § The sync bridge.
 *
 * Missing or invalid ⇒ 401 with an empty body and no detail about what was
 * wrong: which half was missing, and whether a well-formed pair was simply the
 * wrong one, are both facts an attacker would like and the daemon does not
 * need.
 */

const CLIENT_ID_HEADER = "CF-Access-Client-Id"
const CLIENT_SECRET_HEADER = "CF-Access-Client-Secret"

export function isBridgeAuthorized(request: Request, env: Env): boolean {
  const presentedId = header(request, CLIENT_ID_HEADER)
  const presentedSecret = header(request, CLIENT_SECRET_HEADER)

  // Both halves, or nothing.
  if (!presentedId || !presentedSecret) return false

  const expectedId = trimmed(env.BRIDGE_CLIENT_ID)
  const expectedSecret = trimmed(env.BRIDGE_CLIENT_SECRET)

  if (expectedId && expectedSecret) {
    return (
      constantTimeEqual(presentedId, expectedId) &&
      constantTimeEqual(presentedSecret, expectedSecret)
    )
  }

  return !isBehindCloudflareEdge(request)
}

/**
 * The one response shape every bridge rejection uses. `null` body, so the three
 * ways to fail (no headers, one header, wrong pair) are byte-identical from the
 * outside.
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
