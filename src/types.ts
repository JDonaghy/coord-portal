/** Bindings declared in wrangler.toml. Keep this in step with that file. */
export interface Env {
  /** D1 — the portal's records. Customer-authored facts live here, never in git. */
  DB: D1Database
  /** R2 — mock bundles and screenshots. Same rule. */
  ARTIFACTS: R2Bucket
  /** Static site. Serves everything that is not /api/*. */
  ASSETS: Fetcher
  /** "dev" | "production" — see [vars] in wrangler.toml. */
  PORTAL_ENV: string
}

export interface ProbeResult {
  ok: boolean
  detail?: string
}
