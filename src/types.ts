/** Bindings declared in wrangler.toml. Keep this in step with that file. */
export interface Env {
  /** D1 — the portal's records. Customer-authored facts live here, never in git. */
  DB: D1Database
  /** R2 — mock bundles and screenshots. Same rule. */
  ARTIFACTS: R2Bucket
  /** Static site. Serves everything that is not /api/*. */
  ASSETS: Fetcher
  /**
   * The coordinator daemon's Access service token, for `/api/bridge/*`.
   *
   * Optional because Cloudflare Access validates the token before a request
   * ever reaches this Worker — these are the defence-in-depth copy, set with
   * `wrangler secret put`, NEVER in `wrangler.toml` (this repo is public).
   * See `src/bridge/auth.ts` for what happens when they are unset.
   *
   * `BRIDGE_CLIENT_ID` is load-bearing in production: behind the edge it is the
   * `common_name` the verified Access assertion must carry (#70). Unset ⇒ the
   * bridge answers nobody. It is not really a secret (Access forwards it, and
   * it is useless without the other half) but it lives here rather than in
   * `wrangler.toml` because the pair is set together.
   *
   * `BRIDGE_CLIENT_SECRET` is *not* used behind the edge — the edge consumes it
   * rather than forwarding it, which is the whole of #70 — and remains only for
   * the local `wrangler dev` path and for the day Cloudflare forwards both.
   */
  BRIDGE_CLIENT_ID?: string
  BRIDGE_CLIENT_SECRET?: string
  /**
   * Cloudflare Access verification settings (#70) — what
   * `verifyAccessIdentity()` in `src/identity.ts` pins a token to.
   *
   * `ACCESS_TEAM_DOMAIN` — e.g. `<team>.cloudflareaccess.com`. Fixes both the
   * JWKS URL (`/cdn-cgi/access/certs`) and the exact `iss` accepted, so a token
   * signed by another Cloudflare team is refused rather than verified against
   * its own issuer's keys.
   *
   * `BRIDGE_ACCESS_AUD` — the AUD tag of the *bridge* Access application, so a
   * token minted for the site application cannot be replayed at `/api/bridge`.
   * Per-application: a second verified surface needs its own AUD var, never a
   * shared one.
   *
   * Neither is a secret in the `BRIDGE_CLIENT_SECRET` sense (an AUD tag grants
   * nothing without a Cloudflare-signed token for it), but both name this
   * account's Access setup, so they are set with `wrangler secret put` and stay
   * out of a public `wrangler.toml`. Optional here for the same reason as
   * everything else in this file — unset must fail closed, not crash — and
   * `src/bridge/auth.ts` is what actually refuses.
   */
  ACCESS_TEAM_DOMAIN?: string
  BRIDGE_ACCESS_AUD?: string
  /**
   * The AUD tag of the **site** Access application (docs/CLOUDFLARE.md's
   * "site" row) — the one gating every customer- and operator-facing route,
   * as opposed to `BRIDGE_ACCESS_AUD`'s bridge application. Read by
   * `src/identity.ts`'s `resolveSiteIdentity()` (issue #1981), which every
   * route that scopes a query or authorizes a write by Access identity now
   * calls instead of trusting `readAccessIdentity()`'s unverified claim.
   *
   * Per-application, never shared, for the same reason `BRIDGE_ACCESS_AUD`
   * gives: a token minted for the bridge must not verify against a customer
   * route, and a token minted for a customer route must not authorise the
   * daemon. Copy it from the site application's own page in the dashboard.
   *
   * Optional for the same reason as everything else in this file — unset must
   * fail closed, not crash. Unlike the routes that only lose a nice-to-have
   * when unset (`OPERATOR_EMAILS`), an unset `SITE_ACCESS_AUD` (or
   * `ACCESS_TEAM_DOMAIN`) behind Cloudflare's edge means `resolveSiteIdentity`
   * refuses every customer- and operator-facing route for everyone — the same
   * trade `BRIDGE_ACCESS_AUD` already makes for the bridge.
   */
  SITE_ACCESS_AUD?: string
  /**
   * Who may reach the operator surface (`/leads*`, issue #33) — a comma- or
   * whitespace-separated allowlist of Access identities.
   *
   * Optional, and unset means "nobody" in production: see `src/operators.ts`
   * for why it fails closed there and what stands in for it locally. A secret
   * (`wrangler secret put OPERATOR_EMAILS`), never `wrangler.toml` — this repo
   * is public and the list of people who can read leads is not for publishing.
   * `OPERATOR_EMAIL` is the singular spelling, accepted for the same setting.
   */
  OPERATOR_EMAILS?: string
  OPERATOR_EMAIL?: string
  /**
   * Cloudflare Turnstile (issue #32) — the bot gate in front of `POST /start`.
   *
   * `TURNSTILE_SITEKEY` is public by design: it is rendered straight into
   * `GET /start`'s HTML (`turnstile-widget`'s `data-sitekey`), so a `[vars]`
   * entry would be fine for it, but it lives here as a secret too so a single
   * `wrangler secret put` pair configures both halves together — see
   * `src/turnstile.ts` for why mismatching them (a real sitekey with a test
   * secret, or vice versa) is the one misconfiguration this module cannot
   * detect on its own.
   *
   * `TURNSTILE_SECRET` must never be rendered, logged, or reach `wrangler.toml`
   * — it is the `siteverify` credential. Optional here for the same reason
   * `OPERATOR_EMAILS` is: unset must fail closed (issue #32: "refuse the
   * write ... rather than quietly accepting every submission"), not crash the
   * Worker. `src/turnstile.ts` is what actually fails closed; this type only
   * says the binding may be absent.
   */
  TURNSTILE_SITEKEY?: string
  TURNSTILE_SECRET?: string
  /**
   * The mail provider seam (issue #51) that issue #50's drain calls through —
   * see `src/mailProvider.ts`.
   *
   * `RESEND_API_KEY` — secret, `wrangler secret put RESEND_API_KEY`. Never in
   * `wrangler.toml`, never in a committed `.dev.vars` — this repo is public.
   * Unset (or a call the real API rejects) must never crash the scheduled
   * handler and must never mark a row `sent`; it fails the send attempt with a
   * legible `last_error` and flows through the same attempts/backoff/give-up
   * machinery as any other provider error (contract § "The provider seam",
   * "Fail-closed").
   *
   * `MAIL_PROVIDER` — not a secret, and deliberately not read from
   * `wrangler.toml` either: this file has no named environments (see its own
   * comment on that), so a `[vars]` entry here would apply to the deployed
   * Worker too, and "fake" must never be reachable in production. `=== "fake"`
   * selects the deterministic in-memory fake regardless of whether
   * `RESEND_API_KEY` is set; `npm run serve:acceptance` / `serve:test` set it
   * with `wrangler dev --var MAIL_PROVIDER:fake`, which needs no `.dev.vars`
   * file to keep in step by hand — the same trade `src/turnstile.ts`'s dev
   * fallback makes. Absent (production) ⇒ the real Resend implementation.
   */
  RESEND_API_KEY?: string
  MAIL_PROVIDER?: string
  /**
   * The sending address every notification email carries (issue #51) — var,
   * not secret, declared in `wrangler.toml`'s `[vars]` so a per-environment
   * sending address is a config change, not the code change it used to be
   * (raised as a non-blocking finding on #14). `src/notifications.ts` falls
   * back to the same literal this replaced if the var is ever unset, so a
   * missing declaration degrades to the old behaviour instead of sending with
   * an empty `From`. Production's value is #52's to change once
   * `mail.heurontech.com` is verified — this contract does not pin it, only
   * that it lives here instead of a hardcoded string.
   */
  EMAIL_FROM?: string
  /**
   * Where a customer's reply goes (issue #52) — var, not secret.
   *
   * The `From` address is a send-only identity: `mail.heurontech.com` is
   * verified with Resend for *outbound* and has no inbound mail service, so a
   * customer who hits reply reaches nothing. #52's "somewhere for replies to
   * land" was to be Cloudflare Email Routing on that subdomain, but Cloudflare
   * scopes Email Routing to the zone — "if the domain is disabled, subdomains
   * will be disabled too" — and enabling it on `heurontech.com` would replace
   * the Zoho MX records that carry all real mail for the business. Trading
   * working inboxes for a reply address is not a trade worth making, so the
   * reply path is a header instead: `Reply-To`, pointed at a mailbox that
   * already works.
   *
   * #168 (EM-8, milestone #5) turned this from a fixed mailbox into a
   * per-send TEMPLATE: `src/drain.ts`'s `resolveReplyTo` plus-addresses this
   * value with the row's own `SUB-XXXXXX` submission reference at send time
   * (`intake+SUB-XXXXXX@…`) — the same token `src/inboundRouter.ts`'s rung 1
   * already parses back out of an envelope recipient, so a reply threads
   * itself to the right submission with no human in the loop. This var itself
   * still names only the base mailbox (`wrangler.toml`'s own comment on this
   * var has the production value and the reasoning for converging on it); the
   * `+SUB-XXXXXX` token is resolved fresh per row, never stored, for the same
   * reason `PUBLIC_BASE_URL` below is.
   *
   * Unset ⇒ no `Reply-To` header at all, which is the honest degradation: a
   * reply then bounces off a domain with no MX and the sender learns their
   * message went nowhere. That is strictly better than the alternative #52
   * exists to prevent — silent acceptance into a black hole. A row whose
   * `outbox.submission_id` is not a `SUB-XXXXXX` reference (should not occur —
   * see `src/drain.ts`'s `QueuedRow.submission_id`) degrades the same way:
   * this configured address, unmodified, rather than a malformed plus-address
   * built from the wrong kind of string.
   */
  REPLY_TO?: string
  /**
   * The portal's own public origin (issue #83) — var, not secret, declared in
   * `wrangler.toml`'s `[vars]`, same pattern as `EMAIL_FROM` and `REPLY_TO`.
   *
   * `outbox.cta_href` (`src/notifications.ts`) is root-relative
   * (`/submissions/SUB-XXXXXX`) because it is rendered on the portal's own
   * `/outbox` page, where a relative href just works. A mail client has no
   * such origin to resolve it against — #83's whole defect was exactly this:
   * a correct-looking link that was dead the moment it left the app. This var
   * is read at send time (`src/drain.ts`), not stored on the row, for the
   * same reason `REPLY_TO` is not: it is a property of the deployment, and
   * the cron path that drives most sends has no request to derive an origin
   * from even if it wanted to.
   *
   * Unset ⇒ every notification email is sent with **no call-to-action link at
   * all** — identical to this repo's behaviour before #83, never a relative
   * href and never an interpolated `undefined`. `src/drain.ts` logs a warning
   * on every send this happens to, so the gap stays visible to an operator
   * instead of silently shipping linkless mail indefinitely (#83, "The
   * decision this needs"). Production's value is `https://intake.heurontech.com`
   * (`wrangler.toml`'s own `[[routes]]` pattern) — the same custom domain
   * `/submissions/:id` actually resolves on, behind Access sign-in.
   */
  PUBLIC_BASE_URL?: string
}

export interface ProbeResult {
  ok: boolean
  detail?: string
}
