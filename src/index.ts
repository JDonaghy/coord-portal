import { handlePages } from "./pages"
import { handleApi } from "./router"
import type { Env } from "./types"

/**
 * One Worker, three jobs: the JSON API under /api/*, the server-rendered
 * portal pages (/intake, /submissions/:id, ...), and the static site for
 * everything else.
 *
 * Static assets are matched before the Worker runs (see [assets] in
 * wrangler.toml), so in practice this handler sees /api/* plus anything with no
 * matching file. The explicit ASSETS.fetch fallback keeps that true even if the
 * asset-matching behaviour is reconfigured later, and is also what a portal
 * page falls through to when `handlePages` does not own the path (e.g. `/`).
 */
export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url)

    if (pathname === "/api" || pathname.startsWith("/api/")) {
      return handleApi(request, env, ctx)
    }

    const page = await handlePages(request, env)
    if (page) return page

    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
