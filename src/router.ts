import type { Env } from "./types"
import { health } from "./routes/health"
import { whoami } from "./routes/whoami"

export type Handler = (request: Request, env: Env) => Promise<Response> | Response

const ROUTES: Record<string, Partial<Record<string, Handler>>> = {
  "/api/health": { GET: health },
  "/api/whoami": { GET: whoami },
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set("content-type", "application/json; charset=utf-8")
  // The portal's own page is served by the same Worker on the same origin, so
  // there is no legitimate cross-origin caller and no CORS header to add.
  headers.set("cache-control", "no-store")
  return new Response(JSON.stringify(body, null, 2) + "\n", { ...init, headers })
}

export async function handleApi(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url)

  const methods = ROUTES[pathname]
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
    return await handler(request, env)
  } catch (err) {
    // Never leak an internal message to the public internet; the real error
    // goes to the Workers log, which [observability] keeps.
    console.error(`unhandled error on ${request.method} ${pathname}:`, err)
    return json({ error: "internal_error" }, { status: 500 })
  }
}
