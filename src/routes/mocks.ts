import { resolveSiteIdentity } from "../identity"
import { html, page } from "../render"
import { listRounds } from "../rounds"
import { isOwnedBy } from "./submission"
import { getSubmission } from "../submissions"
import type { Env } from "../types"

/**
 * `GET /submissions/:id/rounds/:n/mock[/...]` — the round's mock bundle,
 * served read-only out of R2.
 *
 * Issue #13: "Mocks reuse the pattern already in the repo (`docs/mocks/web/`):
 * self-contained static HTML against a shared token stylesheet, stored in R2,
 * served read-only. No build step, no framework, no live data — the cheapest
 * thing that answers 'is this what you meant?'."
 *
 * ── WHAT THIS ROUTE IS NOT ─────────────────────────────────────────────────
 * There is no upload half. The bucket is populated coord-side; the pinned wire
 * contract for `/api/bridge/*` names exactly three routes and is jointly owned
 * with `JDonaghy/claude-coordinator#1982`, so adding a fourth to take bundle
 * uploads is not a call this side gets to make alone. Everything here is `GET`.
 *
 * ── WHY IT IS BEHIND THE SAME OWNERSHIP GATE AS THE SUBMISSION ─────────────
 * A mock bundle is customer material (CLAUDE.md rule 1 — which is also why none
 * of it is in git). Reaching one requires being the customer the submission
 * belongs to, and a stranger who guesses a URL gets the same 404 a stranger who
 * guesses a submission id gets: knowing a key is not authorisation, and a 404
 * that only fires for someone else's bundle would itself confirm it exists.
 *
 * ── AND WHY SCRIPT IS DISABLED ON IT ───────────────────────────────────────
 * These are HTML documents authored elsewhere, served from the portal's own
 * origin — the same origin as the sign-off buttons. A bundle that could run
 * script could act as the signed-in customer. `script-src 'none'` costs a static
 * mock nothing and closes that entirely.
 *
 * The ownership check runs against `resolveSiteIdentity`'s email (#1981), the
 * same swap `src/routes/submission.ts` makes and for the same reason: this is
 * customer material gated by `isOwnedBy`, and an unverified claim must not be
 * able to satisfy it.
 */

const BUNDLE_PATH = /^\/submissions\/([^/?#]+)\/rounds\/(\d+)\/mock(?:\/(.*))?$/

export function matchMockBundlePath(
  pathname: string,
): { id: string; round: number; rest: string } | null {
  const match = pathname.match(BUNDLE_PATH)
  if (!match) return null
  const [, id, round, rest] = match
  if (!id || !round) return null
  return { id, round: Number(round), rest: rest ?? "" }
}

export async function mockBundle(
  request: Request,
  env: Env,
  id: string,
  roundNumber: number,
  rest: string,
): Promise<Response> {
  const email = await resolveSiteIdentity(request, env)
  const submission = await getSubmission(env, id)
  if (!submission || !isOwnedBy(submission, email)) {
    return notFound()
  }

  const round = (await listRounds(env, submission.reference)).find((r) => r.round === roundNumber)
  const key = round?.mockBundle ? resolveBundleKey(round.mockBundle, rest) : null
  if (!key) return notFound()

  const object = await env.ARTIFACTS.get(key)
  if (!object) return notFound()

  const headers = new Headers()
  headers.set("content-type", contentTypeFor(key))
  headers.set("x-content-type-options", "nosniff")
  headers.set("content-security-policy", "default-src 'self'; script-src 'none'; frame-ancestors 'self'")
  // Customer material behind Access — never store it in a shared cache.
  headers.set("cache-control", "private, no-store")

  return new Response(object.body, { headers })
}

/**
 * The R2 key for one request against a bundle.
 *
 * `bundle` is whatever the coordinator pushed for the round (an absolute URL
 * never reaches here — `mockBundleHref` links straight to those). Two shapes are
 * supported, and the difference is only whether the key names a file:
 *
 *   `rounds/SUB-.../2/index.html`  a single document. `/mock` serves it;
 *                                  `/mock/tokens.css` resolves beside it, which
 *                                  is what a self-contained page's own
 *                                  stylesheet link expects.
 *   `rounds/SUB-.../2`             a prefix. `/mock` serves `<prefix>/index.html`
 *                                  and `/mock/<rest>` serves `<prefix>/<rest>`.
 *
 * Returns `null` for anything that tries to climb out of the bundle. `..` is
 * rejected rather than normalised: a bundle is a subtree, and a request that
 * needs to leave it is not a request this route has any reason to satisfy.
 */
export function resolveBundleKey(bundle: string, rest: string): string | null {
  const base = bundle.trim().replace(/^\/+/, "").replace(/\/+$/, "")
  if (!base || hasTraversal(base)) return null
  if (rest && hasTraversal(rest)) return null

  const isFile = /\/?[^/]+\.[A-Za-z0-9]{1,8}$/.test(base)
  if (!rest) return isFile ? base : `${base}/index.html`

  const cleanRest = rest.replace(/^\/+/, "")
  if (!cleanRest) return isFile ? base : `${base}/index.html`

  const directory = isFile ? base.replace(/\/[^/]*$/, "") : base
  return directory ? `${directory}/${cleanRest}` : cleanRest
}

function hasTraversal(value: string): boolean {
  return value.split("/").some((segment) => segment === "..")
}

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff2: "font/woff2",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
}

/**
 * Content type from the key's extension, defaulting to a download rather than
 * to `text/html`. Guessing "it is probably a web page" on an unknown extension
 * is how an uploaded blob ends up interpreted as markup on this origin.
 */
function contentTypeFor(key: string): string {
  const extension = key.split(".").pop()?.toLowerCase() ?? ""
  return CONTENT_TYPES[extension] ?? "application/octet-stream"
}

function notFound(): Response {
  return html(
    page(
      "Not found — coord-portal",
      `<main>
  <h1>We can't find that mock</h1>
  <p class="lede">The link may be out of date, or the round it belonged to was never published.</p>
</main>`,
    ),
    { status: 404 },
  )
}
