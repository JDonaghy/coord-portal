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
}

export interface ProbeResult {
  ok: boolean
  detail?: string
}
