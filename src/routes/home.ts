import { isBehindCloudflareEdge } from "../deployment"
import { accessRefused, resolveSiteIdentity } from "../identity"
import { escapeHtml, html, page, publicPage } from "../render"
import { listSubmissionsForCustomer } from "../submissions"
import type { Env } from "../types"

/**
 * GET / — the bare domain.
 *
 * Issue #84: until now this path fell through to the static asset
 * `public/index.html` (now deleted) — the day-one "Nothing is built yet"
 * placeholder. It is the first thing a customer sees after Cloudflare Access
 * proves who they are, and for a stranger it is the only front door there is.
 *
 * Three branches, matching the issue's three named states:
 *   1. signed in, with submissions -> redirect straight to `/submissions`.
 *      #84 explicitly allows either "their list, or straight through to it" —
 *      `/submissions` is already ownership-scoped (issue #12) and newest-
 *      first, so this route has nothing to add by rendering its own copy of
 *      that list.
 *   2. signed in, with none -> a short screen that names them and points at
 *      `/intake`, so arriving here is not "a dead end that also insults the
 *      work."
 *   3. not signed in -> what the site is and how to start, in plain
 *      language — `/start` (issue #31's public lead form) is exactly that
 *      "how to start" for someone with no account.
 *
 * Branch 3 only fires off Cloudflare's edge (#1981): the site Access
 * application gates this whole hostname, so behind the edge a request
 * reaching this handler with no *verified* identity (`resolveSiteIdentity`,
 * not `readAccessIdentity`) means Access was bypassed or a token failed
 * verification, not a stranger — refused, not shown the public front door.
 * `wrangler dev`, `e2e/` and the sealed acceptance run have no Access in
 * front, so branch 3 is exactly how they reach this handler with none —
 * `src/pages.ts`'s own comment on this route.
 *
 * Deliberately does NOT reuse `topbar()` / `publicHeader()` (`src/render.ts`):
 * both render the brand link as the literal text "coord-portal", and issue
 * #84 names that string explicitly as vocabulary a customer must never see
 * ("not 'coord-portal' ... on a page a customer can see"). Every other
 * authenticated or public screen keeps that brand text — this one route
 * builds its own minimal header instead of touching the shared one.
 *
 * That header still carries `signout-link` (issue #103): `emptyFrontDoor`
 * below is reached only once `resolveSiteIdentity` has resolved a caller, the
 * same authenticated-screen gate every other route behind Access carries a
 * sign-out control on, and #103's own "done" bar names no carve-out for this
 * screen — only `/start` (`anonymousFrontDoor`, which stays on
 * `publicPage()`/no identity at all) is exempted. Same href, same markup
 * shape as `topbar()`'s, styled by the same `.signout` rule in `APP_STYLES`
 * (this screen renders with `page()`, not `publicPage()`), just built here by
 * hand instead of through `topbar()` for the brand-text reason above.
 */
export async function frontDoor(request: Request, env: Env): Promise<Response> {
  const email = await resolveSiteIdentity(request, env)
  if (!email) {
    if (isBehindCloudflareEdge(request)) return accessRefused()
    return html(publicPage("Welcome — coord-portal", anonymousFrontDoor()))
  }

  const submissions = await listSubmissionsForCustomer(env, email)
  if (submissions.length > 0) {
    return new Response(null, { status: 302, headers: { location: "/submissions" } })
  }

  return html(page("Welcome — coord-portal", emptyFrontDoor(email)))
}

function anonymousFrontDoor(): string {
  return `<main>
  <h1>Tell us what you need. We'll build it and keep you posted.</h1>
  <p class="lede">
    Describe the outcome you're after, in plain language — no account needed. We turn it into a
    design you can approve, keep you posted while it's built, and let you know the moment it's
    ready.
  </p>
  <a class="button primary" href="/start" data-testid="front-door-start">Tell us what you need</a>
</main>`
}

function emptyFrontDoor(email: string): string {
  return `<header class="topbar">
  <span class="identity" data-testid="identity-email">signed in as ${escapeHtml(email)}</span>
  <a class="signout" href="/cdn-cgi/access/logout" data-testid="signout-link">Sign out</a>
</header>
<main>
  <h1>You don't have any requests yet</h1>
  <p class="lede">Tell us what you need and we'll take it from there.</p>
  <a class="button primary" href="/intake" data-testid="nav-new-cta">Send your first request</a>
</main>`
}
