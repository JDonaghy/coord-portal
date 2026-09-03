import { deploymentOf } from "../deployment"
import { getIntakeHealthSnapshot } from "../inboundEmail"
import { json } from "../router"
import type { Env, ProbeResult } from "../types"
import { VERSION } from "../version"

/**
 * GET /api/health
 *
 * Proves the whole stack is wired, not just that the Worker booted: it touches
 * D1 and R2 so a missing or misnamed binding fails here rather than in the
 * first feature that needs one. 503 when any probe fails, so an uptime check
 * can point at this and mean it.
 *
 * `checks.intake` (issue #197, #160's own ops step 4) closes a different gap:
 * `d1`/`r2` prove the bindings answer, not that any mail has ever reached the
 * Worker's `email()` export. On 2026-09-02 all of #161-#169 shipped, this
 * endpoint reported `ok`, and Cloudflare Email Routing's catch-all was still
 * `enabled: false` with no rule pointed here — a green health check next to a
 * front door that had never opened. See `probeIntake` below for why that
 * check reports the fact and never a verdict about it.
 *
 * Deliberately unauthenticated and deliberately boring — it reveals a schema
 * version, a handful of booleans, and inbound message counts/timestamps,
 * nothing about any customer.
 */
export async function health(request: Request, env: Env): Promise<Response> {
  const [d1, r2, intake] = await Promise.all([probeD1(env), probeR2(env), probeIntake(env)])
  const ok = d1.ok && r2.ok && intake.ok

  return json(
    {
      ok,
      service: "coord-portal",
      version: VERSION,
      deployment: deploymentOf(request),
      checks: { d1, r2, intake },
    },
    { status: ok ? 200 : 503 },
  )
}

async function probeD1(env: Env): Promise<ProbeResult> {
  try {
    const row = await env.DB.prepare(
      "SELECT value FROM schema_meta WHERE key = 'schema_version'",
    ).first<{ value: string }>()

    if (!row) {
      return { ok: false, detail: "schema_meta empty — migrations not applied" }
    }
    return { ok: true, detail: `schema ${row.value}` }
  } catch (err) {
    return { ok: false, detail: describe(err) }
  }
}

async function probeR2(env: Env): Promise<ProbeResult> {
  try {
    // A HEAD of a key that is not expected to exist. `null` means the bucket
    // answered, which is the whole question.
    await env.ARTIFACTS.head("__health__")
    return { ok: true }
  } catch (err) {
    return { ok: false, detail: describe(err) }
  }
}

/**
 * How many trailing days count as "recent" for `checks.intake.recentCount`.
 * Not a freshness threshold — see `probeIntake`'s own doc for why a low or
 * zero count inside this window is never turned into `ok: false`. Seven days
 * is simply a window short enough that "counts and a timestamp" stays a
 * legible, at-a-glance fact rather than a lifetime total that only ever grows.
 */
const INTAKE_RECENT_WINDOW_DAYS = 7

interface IntakeProbeResult extends ProbeResult {
  lastReceivedAt: string | null
  recentCount: number
}

/**
 * Whether the inbound mailbox is reachable at all — issue #197. `d1`/`r2`
 * prove the Worker's own bindings answer; this is the check that would have
 * caught #161-#169 all shipping and deploying next to a Cloudflare Email
 * Routing catch-all that was still `enabled: false` with no rule pointed at
 * this Worker. See `src/inboundEmail.ts`'s `getIntakeHealthSnapshot`, which
 * this wraps, for what the two numbers cover and why they include every
 * `disposition` (a suppressed or rate-limited row still proves the pipe is
 * open).
 *
 * `ok` here reflects only whether the D1 query itself succeeded — the same
 * contract `probeD1`/`probeR2` keep, and deliberately NOT a verdict on
 * `lastReceivedAt`/`recentCount`'s values. A quiet week is not an outage for
 * a business this size, and asserting a fixed freshness threshold here would
 * reproduce this issue's own failure one level up: a health check that cries
 * wolf on ordinary quiet is a health check nobody keeps watching, which is
 * exactly how "silence" went unnoticed the first time. If that judgement is
 * ever wanted, it is a later, separate change — an alert with its own
 * threshold, reading these same numbers, not a rewrite of what this reports.
 */
async function probeIntake(env: Env): Promise<IntakeProbeResult> {
  try {
    const snapshot = await getIntakeHealthSnapshot(env, INTAKE_RECENT_WINDOW_DAYS)
    return { ok: true, lastReceivedAt: snapshot.lastReceivedAt, recentCount: snapshot.recentCount }
  } catch (err) {
    return { ok: false, detail: describe(err), lastReceivedAt: null, recentCount: 0 }
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
