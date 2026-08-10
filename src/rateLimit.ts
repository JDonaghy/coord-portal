import type { Env } from "./types"

/**
 * The coarse per-IP rate limit on `POST /start` (issue #32): "Neither needs
 * to be clever — this is a contact form, and the honest traffic pattern is
 * one submission per person per week." Turnstile stops the dumb flood; this
 * bounds the determined one — a caller who *does* carry a token that
 * verifies, submitted over and over.
 *
 * ── WHY A SLIDING WINDOW OVER `start_attempts` (0008), NOT A FIXED BUCKET ──
 * A fixed per-minute bucket resets at the top of the clock minute, so two
 * bursts timed either side of `:00` both land under the cap. Counting rows
 * younger than `WINDOW_MS`, recomputed on every request, has no such seam.
 *
 * ── WHY EVERY ATTEMPT COUNTS, NOT JUST ACCEPTED SUBMISSIONS ────────────────
 * The budget is spent the moment a request arrives, before this module's
 * caller knows whether Turnstile or field validation will also reject it —
 * otherwise a flood of malformed-token requests would cost a `siteverify`
 * call and a D1 write forever, which is exactly the cost this gate exists to
 * bound.
 *
 * ── WHY D1, NOT A DEDICATED RATE-LIMITING BINDING ──────────────────────────
 * A Durable Object or Cloudflare's own Rate Limiting binding would be the
 * "correct" production shape, but adding either means touching production
 * Cloudflare config this worker must not touch, and D1 is already bound. A
 * contact-form-grade limit does not need sub-millisecond global consistency —
 * it needs to stop a sustained burst, which a per-request D1 round trip does
 * today. `WINDOW_MS` is short specifically so this stays coarse rather than
 * precise: see the acceptance slice's own timing note in
 * `tests/acceptance/ms-2/32-bot-gate-rate-limit.spec.ts` for why a short
 * window is what keeps this from also catching ordinary, spread-out traffic
 * from a single shared address (every caller in local dev and in the sealed
 * suite's own #31/#33 slices that does not spoof `CF-Connecting-IP`).
 */

/** How far back an attempt still counts against the same address. */
const WINDOW_MS = 5_000

/** Attempts allowed from one address inside the window before it is cut off. */
const MAX_ATTEMPTS = 15

/** Attempt rows older than this are pruned so the table does not grow forever. */
const RETENTION_MS = 24 * 60 * 60 * 1000

/**
 * Records this attempt and reports whether the address is over budget —
 * including the attempt just recorded, so the Nth request within the window
 * is the one that trips it, not the (N+1)th.
 */
export async function isRateLimited(env: Env, ip: string): Promise<boolean> {
  const nowMs = Date.now()
  const now = new Date(nowMs).toISOString()
  const windowStart = new Date(nowMs - WINDOW_MS).toISOString()
  const retentionStart = new Date(nowMs - RETENTION_MS).toISOString()

  await env.DB.batch([
    env.DB.prepare(`INSERT INTO start_attempts (ip, at) VALUES (?, ?)`).bind(ip, now),
    // Opportunistic hygiene: bound this address's own row count rather than
    // letting a sustained attacker grow the table forever. Scoped to `ip` so
    // this stays a cheap, indexed delete rather than a table scan.
    env.DB.prepare(`DELETE FROM start_attempts WHERE ip = ? AND at < ?`).bind(
      ip,
      retentionStart,
    ),
  ])

  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM start_attempts WHERE ip = ? AND at >= ?`,
  )
    .bind(ip, windowStart)
    .first<{ count: number }>()

  return (row?.count ?? 0) > MAX_ATTEMPTS
}

/**
 * The caller's address, as best a Cloudflare Worker can know it.
 *
 * `CF-Connecting-IP` is the only IP surface a Worker has, set by the edge in
 * production. Measured locally under `wrangler dev` (2026-08-10): the header
 * defaults to `127.0.0.1` when a caller sends none, and is passed through
 * verbatim when a caller does — nothing in local dev strips or overwrites a
 * client-supplied value the way Cloudflare's real edge would. That pass-
 * through is exactly what lets the sealed acceptance suite drive per-IP
 * isolation (and this repo's own e2e coverage) from a single local server.
 *
 * `X-Forwarded-For` is a fallback for any environment that sets that instead;
 * if neither header is present, every caller collapses onto one `"unknown"`
 * bucket rather than the gate silently exempting them.
 */
export function clientIp(request: Request): string {
  const direct = request.headers.get("cf-connecting-ip")?.trim()
  if (direct) return direct

  const forwarded = request.headers.get("x-forwarded-for")?.trim()
  if (forwarded) return forwarded.split(",")[0]!.trim()

  return "unknown"
}
