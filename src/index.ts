import { handleApi } from "./router"
import type { Env } from "./types"

/**
 * One Worker, two jobs: the JSON API under /api/*, and the static site for
 * everything else.
 *
 * Static assets are matched before the Worker runs (see [assets] in
 * wrangler.toml), so in practice this handler sees /api/* plus anything with no
 * matching file. The explicit ASSETS.fetch fallback keeps that true even if the
 * asset-matching behaviour is reconfigured later.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url)

    if (pathname === "/api" || pathname.startsWith("/api/")) {
      return handleApi(request, env)
    }

    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
