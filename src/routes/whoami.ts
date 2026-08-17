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
 * It deliberately still uses the *unverified* reading even now that #1981 has
 * wired `verifyAccessIdentity()` into every other human surface
 * (`src/operators.ts`, and the customer routes via `resolveSiteIdentity` in
 * `src/identity.ts`): this is the endpoint you point at Access when something
 * is already wrong, and one that needs a reachable JWKS to answer can fail for
 * a second, unrelated reason at exactly the wrong moment — a diagnostic tool
 * that can itself 401 because of the thing it exists to help debug is a worse
 * tool. Nothing here scopes a query or authorizes a write, so this stays
 * exactly the "personalization only" case `src/identity.ts`'s module comment
 * carves out for `readAccessIdentity`.
 */
export function whoami(request: Request, _env: Env): Response {
  const identity = readAccessIdentity(request)
  return json({
    ...identity,
    note: "identity is NOT cryptographically verified — this endpoint is diagnostic-only by design, see src/routes/whoami.ts",
  })
}
