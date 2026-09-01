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
 * ── ISSUE #169 (EM-9 of milestone #5) — THE SAME SHAPE, FOR THE INBOUND MAILBOX ──
 *
 * "The abuse controls a mailbox needs and a form already has." `POST /start`
 * has Turnstile plus this coarse cap; a mailbox cannot have Turnstile at all
 * — Cloudflare Email Routing hands `email()` a message however fast an
 * attacker can send one — so the cap above is the whole defense reused, not
 * a new mechanism. Storage is `migrations/0024_inbound_draft_attempts.sql`,
 * `start_attempts`'s own precedent: one row per attempt, a sliding window
 * over `at`, no reset seam.
 *
 * ── TWO CAPS, ONE TABLE ──────────────────────────────────────────────────────
 * EM-9's own text: "Cap drafts created, per sender and in total." Both caps
 * share the same attempt log and the same window — a per-sender count (`AND
 * from_email = ?`) and a total count (no such predicate) over the same rows
 * — so there is exactly one place that decides what "recently" means, not
 * two windows that could drift apart.
 *
 * ── WHY THE CALLER CHECKS THIS AFTER SUPPRESSION, NOT BEFORE ────────────────
 * Unlike `isRateLimited` above, this budget is not spent by every inbound
 * message — only by one that would otherwise earn a draft. A message
 * `detectSuppression` (`src/inboundEmail.ts`) already refuses — an
 * auto-responder, a bounce, a mailing list — was never going to draft
 * anything regardless of this cap, and there is no `siteverify`-shaped
 * external cost here that a suppressed message could still be inflating (the
 * whole reason `isRateLimited` above spends its budget on *every* attempt,
 * accepted or not). `src/inboundEmail.ts`'s own call site enforces the
 * ordering; this function does not gate on disposition itself.
 */
const DRAFT_WINDOW_MS = 5_000

/**
 * More than this many drafts from one sender inside the window trips the
 * cap. Exported so `test/inboundEmail.test.ts`'s own wiring tests (and, if a
 * future e2e fixture needs it, `e2e/`) can size a burst off this value rather
 * than a second, driftable copy of the number.
 */
export const PER_SENDER_MAX_DRAFTS = 5

/** More than this many drafts across every sender inside the window trips the cap. */
export const TOTAL_MAX_DRAFTS = 20

/** Same retention reasoning as `isRateLimited`'s own hygiene delete, scoped the same way — per sender. */
const DRAFT_RETENTION_MS = 24 * 60 * 60 * 1000

/**
 * Records this draft attempt and reports whether `fromEmail` (or the mailbox
 * as a whole) is over budget — including the attempt just recorded, so the
 * (N+1)th message in a window is the one that trips it, matching
 * `isRateLimited`'s own "the Nth request is the one" convention above.
 *
 * `fromEmail` is expected already normalised (lowercased, clamped) — the
 * same value `inbound_emails.from_email` records — so this bucket and that
 * column agree about what "the same sender" means without a second pass of
 * normalisation here.
 */
export async function isInboundDraftRateLimited(env: Env, fromEmail: string): Promise<boolean> {
  const nowMs = Date.now()
  const now = new Date(nowMs).toISOString()
  const windowStart = new Date(nowMs - DRAFT_WINDOW_MS).toISOString()
  const retentionStart = new Date(nowMs - DRAFT_RETENTION_MS).toISOString()

  await env.DB.batch([
    env.DB.prepare(`INSERT INTO inbound_draft_attempts (from_email, at) VALUES (?, ?)`).bind(fromEmail, now),
    // Opportunistic hygiene, scoped to this sender for the same reason
    // `isRateLimited`'s own delete is: a cheap, indexed delete rather than a
    // table scan, at the cost of not pruning a sender who never comes back —
    // acceptable for the same reason it is acceptable there.
    env.DB.prepare(`DELETE FROM inbound_draft_attempts WHERE from_email = ? AND at < ?`).bind(
      fromEmail,
      retentionStart,
    ),
  ])

  const perSender = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM inbound_draft_attempts WHERE from_email = ? AND at >= ?`,
  )
    .bind(fromEmail, windowStart)
    .first<{ count: number }>()

  const total = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM inbound_draft_attempts WHERE at >= ?`,
  )
    .bind(windowStart)
    .first<{ count: number }>()

  return (perSender?.count ?? 0) > PER_SENDER_MAX_DRAFTS || (total?.count ?? 0) > TOTAL_MAX_DRAFTS
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
