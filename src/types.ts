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
}

export interface ProbeResult {
  ok: boolean
  detail?: string
}
