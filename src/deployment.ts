/**
 * Where this request came from — the two questions the Worker can actually
 * answer about its own environment.
 *
 * Lives in its own module (rather than in `routes/health.ts`, where
 * `deploymentOf` started) because `src/bridge/auth.ts` needs the second one,
 * and a route importing the router importing a route is a cycle waiting to
 * bite.
 */

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"])

/**
 * Which deployment is answering, derived from the hostname rather than a
 * configured var. A hand-set `PORTAL_ENV` is a thing that can be wrong; the
 * hostname answers the more useful question: *which* one is this.
 *
 * ⚠ Not a security signal, and specifically not a "am I in production" test.
 * `wrangler dev` rewrites the hostname to the `[[routes]]` custom domain
 * (measured 2026-08-08: a local request to `127.0.0.1:8788` reaches the Worker
 * as `http://intake.heurontech.com/…`, with miniflare's own
 * `mf-original-hostname` header alongside), so this reports the production
 * domain from a laptop. Use `isBehindCloudflareEdge` for anything that must not
 * be fooled.
 */
export function deploymentOf(request: Request): string {
  const { hostname } = new URL(request.url)
  return LOCAL_HOSTNAMES.has(hostname) ? "local" : hostname
}

/**
 * Did this request actually pass through Cloudflare's edge?
 *
 * `CF-Ray` is added by the edge on every request it forwards, and it is *set*,
 * not merged — a client cannot remove it, and a client that forges one only
 * makes this Worker treat it as more trusted infrastructure, i.e. stricter. So
 * the safe reading is one-directional and that is exactly how it is used:
 *
 *   present  ⇒ assume production, with Access in front. Fail closed.
 *   absent   ⇒ nothing evaluated this request before we did (`wrangler dev`,
 *              the e2e smoke net, the sealed acceptance run).
 *
 * The header cannot be used the other way round — "absent therefore safe" would
 * be a header an attacker controls — which is why the only thing keyed off its
 * absence is the *local* relaxation in `src/bridge/auth.ts`, never a grant of
 * anything in production.
 */
export function isBehindCloudflareEdge(request: Request): boolean {
  return request.headers.has("cf-ray")
}
