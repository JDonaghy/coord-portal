import { drainOutbox } from "./drain"
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

  /**
   * The Cron Trigger issue #50 asks for (`[triggers]` in wrangler.toml is the
   * production schedule). Fully awaited rather than handed to
   * `ctx.waitUntil`: a scheduled invocation has no response to return early,
   * so there is nothing to unblock by deferring, and awaiting here means a
   * thrown error surfaces as a failed invocation instead of a silently
   * abandoned background task.
   *
   * `wrangler dev --test-scheduled` (`npm run serve:acceptance` /
   * `serve:test`) exposes this at `GET /__scheduled` — see `src/drain.ts` for
   * why nothing here is ever reachable from `fetch` above.
   */
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await drainOutbox(env)
  },
} satisfies ExportedHandler<Env>
