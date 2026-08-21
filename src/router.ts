import { bridgeUnauthorized, isBridgeAuthorized } from "./bridge/auth"
import type { Env } from "./types"
import { bridgeHeartbeat, bridgePull, bridgePush } from "./routes/bridge"
import { health } from "./routes/health"
import { matchMockUploadPath, uploadMockBundle } from "./routes/mocks"
import { whoami } from "./routes/whoami"

export type Handler = (
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
) => Promise<Response> | Response

const ROUTES: Record<string, Partial<Record<string, Handler>>> = {
  "/api/health": { GET: health },
  "/api/whoami": { GET: whoami },
  // The sync bridge (#15). Every one of these is opened by the daemon, on its
  // own tick — that asymmetry, not the count, is CLAUDE.md rule 2's actual
  // invariant: no route here ever lets the daemon register an address, a
  // subscription or a callback for this side to call *it* on.
  "/api/bridge/pull": { GET: bridgePull },
  "/api/bridge/push": { POST: bridgePush },
  "/api/bridge/heartbeat": { POST: bridgeHeartbeat },
  // The mock bundle upload (#120) is matched below, not listed here: its path
  // carries a submission reference and round number, which this flat map has
  // no way to express.
}

const BRIDGE_PREFIX = "/api/bridge"

export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set("content-type", "application/json; charset=utf-8")
  // The portal's own page is served by the same Worker on the same origin, so
  // there is no legitimate cross-origin caller and no CORS header to add.
  headers.set("cache-control", "no-store")
  return new Response(JSON.stringify(body, null, 2) + "\n", { ...init, headers })
}

export async function handleApi(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const { pathname } = new URL(request.url)

  // The service-token gate covers the whole `/api/bridge` prefix, not just the
  // three routes under it, and runs before routing. Two reasons: an
  // unauthenticated caller learns nothing about which bridge paths exist (a 404
  // is a yes/no answer), and a route added here later cannot be published
  // unauthenticated by forgetting a line. `/api/bridge` authorises the bridge
  // and nothing else — it must never widen into a general Access bypass.
  // Awaited: behind Cloudflare's edge the gate verifies a signed Access
  // assertion against the team's JWKS, which is a (cached) network call (#70).
  if (isBridgePath(pathname) && !(await isBridgeAuthorized(request, env))) {
    return bridgeUnauthorized()
  }

  // The one route whose path carries parameters. Bound into the same
  // `Partial<Record<string, Handler>>` shape the flat map returns, so
  // everything below — 405s, the allow header, the error boundary — is one
  // path instead of two.
  const upload = matchMockUploadPath(pathname)
  const methods: Partial<Record<string, Handler>> | undefined = upload
    ? { POST: (req, e) => uploadMockBundle(req, e, upload.reference, upload.round) }
    : ROUTES[pathname]

  if (!methods) {
    return json({ error: "not_found", path: pathname }, { status: 404 })
  }

  const handler = methods[request.method]
  if (!handler) {
    const allowed = Object.keys(methods).join(", ")
    return json(
      { error: "method_not_allowed", allowed: Object.keys(methods) },
      { status: 405, headers: { allow: allowed } },
    )
  }

  try {
    return await handler(request, env, ctx)
  } catch (err) {
    // Never leak an internal message to the public internet; the real error
    // goes to the Workers log, which [observability] keeps.
    console.error(`unhandled error on ${request.method} ${pathname}:`, err)
    return json({ error: "internal_error" }, { status: 500 })
  }
}

function isBridgePath(pathname: string): boolean {
  return pathname === BRIDGE_PREFIX || pathname.startsWith(`${BRIDGE_PREFIX}/`)
}
