import type { Env } from "../types"

/**
 * `POST /api/bridge/heartbeat` — last-seen for the daemon.
 *
 * ── WHY THIS ENDPOINT EXISTS ───────────────────────────────────────────────
 * Without it, a dead daemon and a slow one are indistinguishable from here. The
 * portal would keep rendering the last `status` it was told as though it were
 * current, and the customer would read a confidently stale screen with no hint
 * that nothing is moving. Past a threshold the portal must say so. Recording
 * the beat is the half this issue owns; the screen that renders staleness needs
 * a pinned surface (no mock, no `data-testid`, no threshold is pinned by the
 * Gate-A contract) and belongs to the issue that owns that screen.
 *
 * `at` is what the daemon claimed. `received_at` is when this Worker actually
 * saw it, and freshness is judged on that: a daemon with a runaway clock must
 * not be able to declare itself fresh until the year 2400.
 */

export interface DaemonLastSeen {
  /** The daemon's own timestamp, normalised to UTC. */
  at: string
  /** When this Worker recorded it. The one this side trusts. */
  receivedAt: string
}

export type DaemonFreshness = "never" | "fresh" | "stale"

/**
 * How long silence is tolerated before the daemon counts as stale.
 *
 * A guess, and marked as one: the wire contract pins the endpoint but not a
 * threshold, and the daemon's tick length lives in the other repo. Ten minutes
 * is several ticks of anything plausible, so a single slow poll does not raise
 * a false alarm. When the two sides agree a number, it is pinned in the issue,
 * not here.
 */
export const DAEMON_STALE_AFTER_MS = 10 * 60 * 1000

/** Records a beat. One row, overwritten — this is a level, not a log. */
export async function recordHeartbeat(env: Env, at: string, receivedAt: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO bridge_daemon (id, at, received_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET at = excluded.at, received_at = excluded.received_at`,
  )
    .bind(at, receivedAt)
    .run()
}

export async function readDaemonLastSeen(env: Env): Promise<DaemonLastSeen | null> {
  const row = await env.DB.prepare(`SELECT at, received_at FROM bridge_daemon WHERE id = 1`)
    .first<{ at: string; received_at: string }>()
  return row ? { at: row.at, receivedAt: row.received_at } : null
}

/**
 * `never` is not `stale`, and the difference matters: a portal that has never
 * heard from a daemon is probably a portal nobody has pointed a fleet at yet,
 * which is a different thing to tell someone than "the fleet stopped answering".
 */
export function daemonFreshness(
  lastSeen: DaemonLastSeen | null,
  now: Date = new Date(),
): DaemonFreshness {
  if (!lastSeen) return "never"
  const receivedAt = Date.parse(lastSeen.receivedAt)
  if (Number.isNaN(receivedAt)) return "never"
  return now.getTime() - receivedAt > DAEMON_STALE_AFTER_MS ? "stale" : "fresh"
}

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

/**
 * Normalises the daemon's `at` to an ISO-8601 UTC string, or returns `null` if
 * it is not a timestamp. Offsets are accepted and converted; a bare local
 * datetime is not, because "19:04:11" without a zone is not a moment in time.
 */
export function normaliseTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !ISO_8601.test(value)) return null
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return null
  return new Date(parsed).toISOString()
}
