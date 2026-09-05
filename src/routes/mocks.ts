import { parseFormData } from "../formData"
import { resolveSiteIdentity } from "../identity"
import { readOperator } from "../operators"
import { recordOperatorRead } from "../operatorAccess"
import { html, page } from "../render"
import { json } from "../router"
import { listRounds } from "../rounds"
import { isOwnedBy } from "./submission"
import { getSubmission, getSubmissionByReference, type Submission } from "../submissions"
import type { Env } from "../types"

/**
 * `GET /submissions/:id/rounds/:n/mock[/...]` — the round's mock bundle,
 * served read-only out of R2 — `GET /requests/:id/rounds/:n/mock[/...]`, the
 * operator-scoped counterpart (issue #304) — and
 * `POST /api/bridge/mocks/:reference/:round`, the upload half that fills that
 * bucket.
 *
 * Issue #13: "Mocks reuse the pattern already in the repo (`docs/mocks/web/`):
 * self-contained static HTML against a shared token stylesheet, stored in R2,
 * served read-only. No build step, no framework, no live data — the cheapest
 * thing that answers 'is this what you meant?'."
 *
 * ── THE OPERATOR READ (#304) ─────────────────────────────────────────────
 * Before this issue, reaching a round's bundle required being the customer it
 * belongs to — an operator reviewing a `changes-requested` verdict could read
 * the comment (`routes/requests.ts`'s round history) but never open the mock
 * it was about. `operatorMockBundle` below is a second entry point onto the
 * exact same read `serveBundle` performs for `mockBundle` — same R2 key
 * resolution, same headers, same bytes — gated by `readOperator`
 * (`src/operators.ts`) instead of `isOwnedBy`. Per the issue's own design
 * constraint, this is deliberately a second gate on a second route, not a
 * bypass added inside `isOwnedBy` itself: that function is called from both
 * this file and `routes/submission.ts`, and widening it there would silently
 * widen access at every call site, including ones that must never grant an
 * operator anything. The 404 stays the 404: `readOperator` returning `null`
 * (a stranger, an unconfigured deploy, a customer who is not also an
 * operator) renders the exact same `notFound()` a missing bundle does, so a
 * non-operator sees no behavioural difference between this route existing and
 * not. Every request that clears both gates (a verified operator, a
 * submission that exists) is recorded — `src/operatorAccess.ts`'s
 * `recordOperatorRead`, written before the R2 lookup itself — because this is
 * the first route in the portal where one person reads another's private
 * material, and a round with no bundle published yet should leave the same
 * trace a genuine look at one would, not a silent gap in the log.
 *
 * ── THE UPLOAD HALF (#120) ──────────────────────────────────────────────────
 * This used to be GET-only, with a comment here explaining that adding an
 * upload route was "not a call this side gets to make alone" — the pinned wire
 * contract for `/api/bridge/*` named exactly three routes, jointly owned with
 * `JDonaghy/claude-coordinator#1982`. #120 is that call, made explicitly by the
 * epic: `uploadMockBundle` below is the fourth route. It still changes nothing
 * about CLAUDE.md rule 2 — the daemon is still the one opening the connection,
 * on its own tick, to hand this side bytes it already decided to send; nothing
 * here hands the daemon an address, a subscription or a callback to register.
 * See `src/router.ts` for how it is wired in and gated exactly like the other
 * three.
 *
 * Deliberately does **not** touch `design_rounds.mock_bundle` — that column is
 * coord-owned (`src/bridge/ownership.ts`) and is written only by
 * `roundStatementsForPush`, from an ordinary `POST /api/bridge/push` carrying
 * `design_round.mock_bundle` (or `artifacts`). This route's whole job is to put
 * bytes in R2 and hand back the key it used; recording that key against a round
 * is the caller's next, separate push, exactly as issue #120 describes it. That
 * keeps the single-writer rule intact instead of growing a second path into the
 * same column.
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

  return serveBundle(env, submission, roundNumber, rest)
}

/* ─────────────────────────── the operator read (#304) ──────────────────────── */

const OPERATOR_BUNDLE_PATH = /^\/requests\/([^/?#]+)\/rounds\/(\d+)\/mock(?:\/(.*))?$/

export function matchOperatorMockBundlePath(
  pathname: string,
): { id: string; round: number; rest: string } | null {
  const match = pathname.match(OPERATOR_BUNDLE_PATH)
  if (!match) return null
  const [, id, round, rest] = match
  if (!id || !round) return null
  return { id, round: Number(round), rest: rest ?? "" }
}

/**
 * `GET /requests/:id/rounds/:n/mock[/...]` — the operator-scoped counterpart
 * to `mockBundle` above (issue #304). See this module's own doc comment for
 * the full rationale; in short, this reads through `serveBundle` exactly as
 * `mockBundle` does — same R2 key, same headers, same bytes — gated by
 * `readOperator` rather than `isOwnedBy`, and records the read
 * (`recordOperatorRead`) before serving it.
 *
 * `readOperator` returning `null` and `getSubmission` finding nothing both
 * render the identical `notFound()` below — not a distinct refusal for "you
 * are not an operator" versus "no such submission" — the same "a 404 that
 * only fires for someone else's bundle would itself confirm it exists"
 * reasoning `mockBundle` already applies, extended to whether this operator
 * route itself exists at all.
 */
export async function operatorMockBundle(
  request: Request,
  env: Env,
  id: string,
  roundNumber: number,
  rest: string,
): Promise<Response> {
  const operator = await readOperator(request, env)
  if (!operator) return notFound()

  const submission = await getSubmission(env, id)
  if (!submission) return notFound()

  await recordOperatorRead(env, operator.email, submission.reference, roundNumber)

  return serveBundle(env, submission, roundNumber, rest)
}

/**
 * The one read both `mockBundle` and `operatorMockBundle` perform once their
 * own gate has passed — "same R2 read path the customer route uses" is issue
 * #304's own requirement for the operator route, and factoring the shared
 * tail out is what makes that true by construction rather than by two copies
 * staying in sync by hand.
 *
 * A round with no bundle, or a round number nothing was ever published under,
 * renders the same `notFound()` a missing submission does — never an error —
 * which is also what makes "a round with no bundle... render[s] cleanly"
 * true for the operator path with no extra code: it is the same call.
 */
async function serveBundle(
  env: Env,
  submission: Submission,
  roundNumber: number,
  rest: string,
): Promise<Response> {
  const round = (await listRounds(env, submission.reference)).find((r) => r.round === roundNumber)
  const key = round?.mockBundle ? resolveBundleKey(round.mockBundle, rest) : null
  if (!key) return notFound()

  const object = await env.ARTIFACTS.get(key)
  if (!object) return notFound()

  const headers = new Headers()
  headers.set("content-type", contentTypeFor(key))
  headers.set("x-content-type-options", "nosniff")
  headers.set(
    "content-security-policy",
    "default-src 'self'; script-src 'none'; style-src 'self' 'unsafe-inline'; frame-ancestors 'self'",
  )
  // Customer material behind Access — never store it in a shared cache.
  headers.set("cache-control", "private, no-store")

  return new Response(object.body, { headers })
}

/* ─────────────────────────── the upload half (#120) ────────────────────────── */

const UPLOAD_PATH = /^\/api\/bridge\/mocks\/([^/?#]+)\/(\d+)$/

/**
 * Matches `POST /api/bridge/mocks/:reference/:round`. Named `reference`, not
 * `id`: this route is reached by the daemon, over the bridge, and the bridge
 * addresses submissions by the `SUB-XXXXXX` reference everywhere else
 * (`src/bridge/updates.ts`), never by the customer-facing `id` the GET route
 * above uses. A caller that presents an `id` here simply finds no submission
 * and gets `unknown_submission` — the same shape a stale or mistyped reference
 * gets.
 */
export function matchMockUploadPath(
  pathname: string,
): { reference: string; round: number } | null {
  const match = pathname.match(UPLOAD_PATH)
  if (!match) return null
  const [, reference, round] = match
  if (!reference || !round) return null
  return { reference, round: Number(round) }
}

/** The most files one bundle upload may carry — mirrors `MAX_PUSH_UPDATES`'s shape. */
export const MAX_BUNDLE_FILES = 60

/** The largest single file a bundle may carry — a static mock page, not a video. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024

/** The largest a whole bundle may total, across every file in it. */
export const MAX_BUNDLE_BYTES = 20 * 1024 * 1024

/**
 * `POST /api/bridge/mocks/:reference/:round` — writes a mock bundle into R2
 * under the exact key convention `resolveBundleKey` above already reads from,
 * and hands back the prefix it used.
 *
 * Body is `multipart/form-data`; each part's field name is the file's path
 * *relative to the round's bundle prefix* (`index.html`, `tokens.css`,
 * `contract.md`, `assets/logo.png`, ...) and its value is the file itself.
 * There is no envelope beyond that — no metadata field, no manifest — because
 * the daemon already knows the one thing that matters (which submission, which
 * round) and put it in the URL, and everything else is exactly the bytes that
 * end up served back out through `mockBundle` above.
 *
 * Authorised by the same gate as the other three bridge routes
 * (`src/bridge/auth.ts`, applied in `src/router.ts` before this ever runs) —
 * not `resolveSiteIdentity`/`isOwnedBy` like the GET route just above. Those
 * two gates answer different questions: GET asks "is the caller the customer
 * this bundle belongs to", POST asks "is the caller the daemon", and a signed-
 * in customer is never the daemon.
 *
 * Three checks earn their own status code before anything is written:
 *
 *   `unknown_submission` (404)  the reference names no submission at all — the
 *                               same shape a push against one gets.
 *   `round_decided`      (409)  the round already has a verdict. Rounds are
 *                               "never deleted, hidden or rewritten once they
 *                               have a verdict" (`src/rounds.ts`) — that
 *                               invariant is about the bytes a customer signed
 *                               off on, not just the `design_rounds` row
 *                               pointing at them, so it is enforced here too,
 *                               against `listRounds`, before a single object
 *                               is written.
 *   `missing_index_html` (400)  the bundle has no `index.html`. This route
 *                               always hands back a *prefix*, never a file
 *                               (`rounds/<reference>/<round>`, the second shape
 *                               `resolveBundleKey` documents), and a prefix
 *                               with no `index.html` behind it 404s on every
 *                               request `mockBundle` ever serves for it — an
 *                               unusable upload is worth refusing loudly now
 *                               rather than discovering it is empty later.
 *
 * A file's own relative path is rejected (`invalid_path`) on the same rule
 * `resolveBundleKey` enforces on the way out: no `..` segment climbs out of
 * the round's own subtree, and no leading `/` reinterprets the path as
 * absolute.
 */
export async function uploadMockBundle(
  request: Request,
  env: Env,
  reference: string,
  round: number,
): Promise<Response> {
  if (!Number.isInteger(round) || round < 1) {
    return json({ error: "invalid_round" }, { status: 400 })
  }

  const submission = await getSubmissionByReference(env, reference)
  if (!submission) {
    return json({ error: "unknown_submission" }, { status: 404 })
  }

  const existing = (await listRounds(env, reference)).find((r) => r.round === round)
  if (existing && existing.verdict !== "pending") {
    return json({ error: "round_decided" }, { status: 409 })
  }

  const form = await parseFormData(request)
  if (!form) {
    return json({ error: "invalid_request" }, { status: 400 })
  }

  const files: Array<{ path: string; file: File }> = []
  for (const [name, value] of form.entries()) {
    if (!(value instanceof File)) {
      return json({ error: "invalid_entry", field: name }, { status: 400 })
    }
    const path = name.trim().replace(/^\/+/, "")
    if (!path || hasTraversal(path)) {
      return json({ error: "invalid_path", field: name }, { status: 400 })
    }
    files.push({ path, file: value })
  }

  if (files.length === 0) {
    return json({ error: "empty_bundle" }, { status: 400 })
  }
  if (files.length > MAX_BUNDLE_FILES) {
    return json({ error: "too_many_files", limit: MAX_BUNDLE_FILES }, { status: 400 })
  }
  if (!files.some((entry) => entry.path === "index.html")) {
    return json({ error: "missing_index_html" }, { status: 400 })
  }

  let totalBytes = 0
  for (const { file } of files) {
    if (file.size > MAX_FILE_BYTES) {
      return json({ error: "file_too_large", limit: MAX_FILE_BYTES }, { status: 400 })
    }
    totalBytes += file.size
  }
  if (totalBytes > MAX_BUNDLE_BYTES) {
    return json({ error: "bundle_too_large", limit: MAX_BUNDLE_BYTES }, { status: 400 })
  }

  const prefix = `rounds/${reference}/${round}`
  for (const { path, file } of files) {
    await env.ARTIFACTS.put(`${prefix}/${path}`, await file.arrayBuffer(), {
      httpMetadata: { contentType: contentTypeFor(path) },
    })
  }

  return json({ key: prefix, files: files.map((entry) => entry.path).sort() })
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
