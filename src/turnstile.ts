import { isBehindCloudflareEdge } from "./deployment"
import type { Env } from "./types"

/**
 * Cloudflare Turnstile — the bot gate issue #32 puts in front of `POST
 * /start`: "verified server-side in the Worker — not merely rendered
 * client-side."
 *
 * ── THE DEV FALLBACK, MIRRORING `src/operators.ts`'S DEV_OPERATOR_EMAIL ────
 * `TURNSTILE_SITEKEY`/`TURNSTILE_SECRET` are `wrangler secret put` values —
 * optional in `Env`, unset by default. When unset:
 *   - behind Cloudflare's edge (production): fail closed. No sitekey to
 *     render is a broken form either way, and no secret means every
 *     `siteverify` call is skipped and every submission refused — "an unset
 *     secret must fail closed ... rather than quietly accepting everything."
 *   - not behind the edge (`wrangler dev`, the e2e smoke net, the sealed
 *     acceptance run): fall back to Cloudflare's own documented always-pass
 *     test pair. There is no secret store locally and nothing else for a dev
 *     Turnstile config to be — same trade `DEV_OPERATOR_EMAIL` makes, and it
 *     is what lets `npm run test:acceptance` drive both outcomes with zero
 *     setup (contract.md, "Bot gate + rate limit": the acceptance run "must
 *     configure both the sitekey ... and the ... secret to the matching
 *     member of one pair" — this makes that true without a `.dev.vars` file
 *     to keep in step by hand).
 *
 * `DEV_SITEKEY`/`DEV_SECRET` are Cloudflare's own published test values
 * (developers.cloudflare.com/turnstile/troubleshooting/testing/), not a
 * secret of this repo's — publishing them here is exactly what Cloudflare's
 * docs invite. The real secret never appears in this file or anywhere else
 * in git.
 */
const DEV_SITEKEY = "1x00000000000000000000AA" // always passes
const DEV_SECRET = "1x0000000000000000000000000000000AA" // matching secret

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"

/** The request field Turnstile's own widget injects — Cloudflare's convention, not this repo's. */
export const TURNSTILE_FIELD = "cf-turnstile-response"

/**
 * The literal token Cloudflare's widget mints against the always-pass test
 * sitekey (contract.md: "The widget generates a literal token string
 * `XXXX.DUMMY.TOKEN.XXXX` against a test sitekey").
 */
const DUMMY_TEST_TOKEN = "XXXX.DUMMY.TOKEN.XXXX"

/**
 * A real Turnstile response token is a long, opaque, whitespace-free string —
 * comfortably three figures long in practice. These bounds exist only to
 * reject obvious garbage before spending a network round trip on it.
 */
const MIN_PLAUSIBLE_TOKEN_LENGTH = 100
const MAX_PLAUSIBLE_TOKEN_LENGTH = 2048

/**
 * A cheap, local shape check that runs before `siteverify` is ever called.
 *
 * ── WHY THIS EXISTS AT ALL ───────────────────────────────────────────────
 * Measured directly against Cloudflare's real `siteverify` endpoint
 * (2026-08-10): the documented always-pass secret (`1x0000...AA`) returns
 * `success: true` for *any* non-empty `response` value — `"garbage"`,
 * `"not-a-turnstile-token"`, a 4KB string, all of it. That is the test
 * secret's whole purpose (letting the "happy path" be driven without a
 * browser solving a real challenge), but it also means "call the real
 * `siteverify` with the always-pass secret" cannot, on its own, distinguish
 * the dummy token the test widget actually mints from a string a caller made
 * up — every response in that world is equally "valid" to a test secret that
 * was built to never say no.
 *
 * A real, non-test secret does not have this problem — it cryptographically
 * validates a genuine widget-issued token, which a malformed string can never
 * be. So this check is deliberately loose enough to pass through anything
 * that could plausibly BE a real token (`MIN_PLAUSIBLE_TOKEN_LENGTH` sits
 * far below what one actually looks like) and only rejects what could not —
 * the literal dummy token is special-cased through it explicitly, since it is
 * short by design and is the one string this whole gate must accept in an
 * environment wired to the test pair.
 */
function looksLikeATurnstileToken(token: string): boolean {
  if (token === DUMMY_TEST_TOKEN) return true
  if (token.length < MIN_PLAUSIBLE_TOKEN_LENGTH) return false
  if (token.length > MAX_PLAUSIBLE_TOKEN_LENGTH) return false
  return !/\s/.test(token)
}

/**
 * The sitekey to render on `GET /start`. Never `undefined` locally (falls
 * back to the dev pair); may be `undefined` behind the edge if the deploy
 * forgot to configure one — the page still renders (an empty `data-sitekey`
 * is a broken widget, not a 500), and `verifySubmission` below is what
 * actually enforces the fail-closed rule.
 */
export function publicSitekey(request: Request, env: Env): string {
  if (env.TURNSTILE_SITEKEY) return env.TURNSTILE_SITEKEY
  return isBehindCloudflareEdge(request) ? "" : DEV_SITEKEY
}

function siteverifySecret(request: Request, env: Env): string | undefined {
  if (env.TURNSTILE_SECRET) return env.TURNSTILE_SECRET
  return isBehindCloudflareEdge(request) ? undefined : DEV_SECRET
}

/**
 * Did this submission pass the bot gate? `false` covers every case issue #32
 * names in one return value — no token, an empty token, a malformed token, a
 * token `siteverify` rejects, and an unconfigured secret — because the
 * caller (`routes/start.ts`) renders the exact same generic refusal for all
 * of them regardless of which one fired.
 *
 * Never throws: a network failure talking to `siteverify` is treated as a
 * failed verification, not a 500 — "fail closed" means closed on every
 * failure mode, including Cloudflare's own API being unreachable.
 */
export async function verifySubmission(
  request: Request,
  env: Env,
  token: string,
): Promise<boolean> {
  const trimmed = token.trim()
  if (!trimmed) return false
  if (!looksLikeATurnstileToken(trimmed)) return false

  const secret = siteverifySecret(request, env)
  if (!secret) return false

  try {
    const body = new URLSearchParams({ secret, response: trimmed })
    const clientIp = request.headers.get("cf-connecting-ip")
    if (clientIp) body.set("remoteip", clientIp)

    const response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    })
    if (!response.ok) return false

    const result = (await response.json()) as { success?: boolean }
    return result.success === true
  } catch {
    return false
  }
}
