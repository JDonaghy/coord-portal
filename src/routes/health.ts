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
 * Deliberately unauthenticated and deliberately boring — it reveals a schema
 * version and two booleans, nothing about any customer.
 */
export async function health(request: Request, env: Env): Promise<Response> {
  const [d1, r2] = await Promise.all([probeD1(env), probeR2(env)])
  const ok = d1.ok && r2.ok

  return json(
    {
      ok,
      service: "coord-portal",
      version: VERSION,
      deployment: deploymentOf(request),
      checks: { d1, r2 },
    },
    { status: ok ? 200 : 503 },
  )
}

/**
 * Which deployment is answering, derived from the hostname rather than a
 * configured var.
 *
 * A hand-set `PORTAL_ENV` is a thing that can be wrong — the local dev server
 * cheerfully calling itself "production" is exactly the false signal this
 * endpoint exists to avoid. The hostname cannot lie about which deployment you
 * reached, and it answers the more useful question: *which* one is this.
 */
export function deploymentOf(request: Request): string {
  const { hostname } = new URL(request.url)
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") {
    return "local"
  }
  return hostname
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

function describe(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
