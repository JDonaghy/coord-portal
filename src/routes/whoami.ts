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
 *
 * It deliberately still uses the *unverified* reading even though #70 built
 * `verifyAccessIdentity()`: this is the endpoint you point at Access when
 * something is already wrong, and one that needs a reachable JWKS to answer can
 * fail for a second, unrelated reason at exactly the wrong moment. Verifying
 * the human surfaces (here, `src/operators.ts`) is #1981, and it needs the site
 * application's own AUD tag, not the bridge's.
 */
export function whoami(request: Request, _env: Env): Response {
  const identity = readAccessIdentity(request)
  return json({
    ...identity,
    note: "identity is NOT cryptographically verified — see #1981",
  })
}
