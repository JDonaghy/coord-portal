import { readAccessIdentity } from "../identity"
import { json } from "../router"
import type { Env } from "../types"

/**
 * GET /api/whoami
 *
 * Echoes who Cloudflare Access says the caller is, so the Access configuration
 * can be confirmed from a browser before any product surface depends on it.
 *
 * `verified` is always false — see src/identity.ts. This endpoint is a
 * diagnostic, not a session.
 */
export function whoami(request: Request, _env: Env): Response {
  const identity = readAccessIdentity(request)
  return json({
    ...identity,
    note: "identity is NOT cryptographically verified — see #1981",
  })
}
