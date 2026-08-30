import { drainOutbox } from "./drain"
import { recordInboundEmail } from "./inboundEmail"
import { handlePages } from "./pages"
import { handleApi } from "./router"
import { inboundTestDoor } from "./routes/inboundTestDoor"
import { outboundRecordings } from "./routes/outbound"
import type { Env } from "./types"

/**
 * One Worker, three jobs: the JSON API under /api/*, the server-rendered
 * portal pages (/, /intake, /submissions/:id, ...), and the static site for
 * everything else.
 *
 * Static assets are matched before the Worker runs (see [assets] in
 * wrangler.toml), so in practice this handler sees /api/* plus anything with no
 * matching file — which, since `public/index.html` was retired (issue #84),
 * now includes `/` itself. The explicit ASSETS.fetch fallback keeps that true
 * even if the asset-matching behaviour is reconfigured later, and is what an
 * unrecognised path — not `/api/*`, not owned by `handlePages` — falls
 * through to.
 */
export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url)

    // The recording fake's read-back surface (issue #83) — see
    // `src/routes/outbound.ts` for why this exists and why it is safe in
    // production (it 404s there unconditionally). Checked ahead of `/api` and
    // the page router since it owns exactly one path and nothing else here
    // needs to know about it.
    if (pathname === "/__outbound") {
      return outboundRecordings(env)
    }

    // The inbound seam's test door (issue #161) — same `__` convention, same
    // "404 unless the fake provider is selected" gate, and here for the same
    // reason `/__outbound` is: it owns exactly one path, nothing else in the
    // Worker needs to know about it, and it must be unreachable in production.
    // See `src/routes/inboundTestDoor.ts` for why an `email()` handler needs a
    // door at all.
    if (pathname === "/__email") {
      return inboundTestDoor(request, env)
    }

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

  /**
   * Inbound mail (issue #161). Cloudflare Email Routing invokes this export
   * directly — there is no HTTP request behind it, exactly as with
   * `scheduled()` above, which is why `POST /__email` exists at all (see
   * `src/routes/inboundTestDoor.ts`).
   *
   * Fully awaited, for the same reason `scheduled()` is: there is no response
   * to return early, so deferring to `ctx.waitUntil` would unblock nothing, and
   * awaiting means a thrown error surfaces as a failed invocation — which for
   * inbound mail means the sending server retries — instead of a silently
   * abandoned background task and a message nobody ever sees again.
   *
   * This handler deliberately does not call `message.setReject()`, `forward()`
   * or `reply()`. #161 "routes nothing and replies to nothing": everything that
   * arrives is recorded, and the ones that must never earn an answer are
   * recorded as `suppressed` rather than bounced back at whoever sent them.
   */
  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
    await recordInboundEmail(env, {
      // The ENVELOPE addresses, not the `To:`/`From:` headers — see
      // `migrations/0020_inbound_emails.sql` for why that distinction is
      // load-bearing for EM-3's rung 1.
      from: message.from,
      to: message.to,
      raw: message.raw,
    })
  },
} satisfies ExportedHandler<Env>
