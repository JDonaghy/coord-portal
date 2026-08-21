import { decodeCursor, encodeCursor } from "../bridge/cursor"
import { parsePullLimit, readEventsAfter } from "../bridge/events"
import { normaliseTimestamp, recordHeartbeat } from "../bridge/heartbeat"
import { MAX_PUSH_UPDATES, applyUpdates } from "../bridge/updates"
import { json } from "../router"
import type { Env } from "../types"

/**
 * The sync bridge — the portal-side API the coordinator's daemon polls.
 *
 * ── THE SHAPE OF THIS SURFACE IS THE SECURITY ARGUMENT ─────────────────────
 * The three routes below, plus one more that lives in `src/routes/mocks.ts`
 * (`POST /api/bridge/mocks/:reference/:round`, #120 — a mock bundle upload,
 * gated in `src/router.ts` exactly like these three): the daemon pulls what
 * happened here, pushes what happened there, says it is alive, and hands over
 * the bytes for a design round's mock. Every connection is opened by the
 * daemon. This side has no idea where the fleet is, holds no address for it,
 * and must never learn one — no webhook, no callback URL, no "push endpoint"
 * to register, not even behind a shared secret. If latency feels bad the
 * daemon polls faster. That asymmetry is the entire reason this portal can sit
 * on the public internet in front of a private tailnet, and it is exactly the
 * kind of thing a well-meaning "just add a notify hook" PR destroys quietly.
 *
 * Auth (the service token) is applied by the router for the whole `/api/bridge`
 * prefix, before routing, so an unknown path under it cannot be probed without
 * a credential either — see `src/router.ts`.
 */

/**
 * `GET /api/bridge/pull` — everything customer-authored since the cursor.
 *
 * Replay-safe by construction: the cursor names a revision, the query is
 * `revision > cursor`, and events are immutable once written. Pulling the same
 * cursor twice therefore returns the same events, which is what lets a daemon
 * that died mid-tick simply start again from where it last committed. A
 * submission is never lost to a daemon outage — it queues, which is the entire
 * point of an inbox.
 */
export async function bridgePull(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)

  const rawCursor = url.searchParams.get("cursor")
  let afterRevision = 0
  if (rawCursor !== null && rawCursor.trim() !== "") {
    const decoded = decodeCursor(rawCursor.trim())
    if (decoded === null) {
      // Not a rewind to the beginning: a daemon holding a cursor this portal
      // never issued has a real problem, and replaying its whole history at it
      // would hide that behind a very large, very slow "success".
      return json({ error: "invalid_cursor" }, { status: 400 })
    }
    afterRevision = decoded
  }

  const limit = parsePullLimit(url.searchParams.get("limit"))
  const { events, hasMore } = await readEventsAfter(env, afterRevision, limit)

  const last = events[events.length - 1]
  // On an empty page the cursor stands still rather than disappearing, so a
  // daemon can persist whatever it was handed on every tick without special
  // casing "there was nothing new".
  const cursor = encodeCursor(last ? last.revision : afterRevision)

  return json({ events, cursor, has_more: hasMore })
}

/**
 * `POST /api/bridge/push` — coord-owned facts coming back the other way.
 *
 * Always 200 when the body is a batch: `rejected` and `already_applied` are
 * per-item outcomes, not transport failures. The semantics that make this safe
 * to retry blindly live in `src/bridge/updates.ts`.
 */
export async function bridgePush(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const body = await readJsonBody(request)
  if (body === null || !isPlainObject(body) || !Array.isArray(body["updates"])) {
    // A body that is not a batch has no per-item outcome to report — there are
    // no items. That is the one thing here that is genuinely a bad request.
    return json({ error: "invalid_request" }, { status: 400 })
  }

  const updates = body["updates"]
  if (updates.length > MAX_PUSH_UPDATES) {
    // Said out loud, with the limit in it, rather than truncating: a daemon
    // that silently had half its batch dropped would believe it had synced.
    return json(
      { error: "too_many_updates", limit: MAX_PUSH_UPDATES },
      { status: 400 },
    )
  }

  const results = await applyUpdates(env, updates, ctx)
  return json({ results })
}

/**
 * `POST /api/bridge/heartbeat` — the daemon saying it is still there.
 *
 * Idempotent and cheap on purpose: it records a level, not a log, so a daemon
 * may beat as often as it likes without growing a table.
 */
export async function bridgeHeartbeat(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request)
  const at = isPlainObject(body) ? normaliseTimestamp(body["at"]) : null
  if (at === null) {
    return json({ error: "invalid_at" }, { status: 400 })
  }

  await recordHeartbeat(env, at, new Date().toISOString())
  return json({ ok: true })
}

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return null
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
