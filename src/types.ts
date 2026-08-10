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
   */
  BRIDGE_CLIENT_ID?: string
  BRIDGE_CLIENT_SECRET?: string
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
}

export interface ProbeResult {
  ok: boolean
  detail?: string
}
