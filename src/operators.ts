import { isBehindCloudflareEdge } from "./deployment"
import { readAccessIdentity } from "./identity"
import type { Env } from "./types"

/**
 * Who is allowed to read leads and promote them (issue #33).
 *
 * ── WHY THIS FILE EXISTS AT ALL ────────────────────────────────────────────
 * Every authenticated surface built before this one (issue #12) is scoped by
 * *ownership*: `/submissions/:id` asks "is this row's `customer_email` the
 * caller's Access email", never "what role is this caller". That worked while
 * every Access identity was a customer. `/leads*` is the first surface that
 * needs a second kind of identity, so it is the first place the portal has to
 * answer a question ownership cannot: is this person staff.
 *
 * It is still not authentication. Cloudflare Access is (README.md § Access,
 * and CLAUDE.md's "no authentication code in the application") — this module
 * reads the identity Access resolved, via `readAccessIdentity`, and checks it
 * against a configured list. Everything `src/identity.ts` says about that
 * identity being unverified until #1981 applies here unchanged: #70 built
 * `verifyAccessIdentity()` and wired it into the *bridge* only, so the operator
 * allowlist is still checked against an identity nothing has proved.
 *
 * ── HOW IT DECIDES ─────────────────────────────────────────────────────────
 * 1. If `OPERATOR_EMAILS` (or `OPERATOR_EMAIL`) is configured, the caller's
 *    Access email must appear in it. Comparison is case-insensitive because
 *    the local part of an address is technically case-sensitive but no identity
 *    provider in practice treats it that way, and an operator locked out by the
 *    capitalisation their IdP happened to return is a bad failure.
 * 2. If it is *not* configured, this takes the same position
 *    `src/bridge/auth.ts` takes for the daemon's service token:
 *      - on a request that came through Cloudflare's edge (production), nobody
 *        is an operator and `/leads*` 404s for everyone, including the person
 *        who deployed it. Failing closed means a deploy that forgets the
 *        setting has no operator surface, rather than one whose operator
 *        surface answers to whatever address an Access policy happens to admit.
 *      - on a request that did not (`wrangler dev`, the `e2e/` smoke net, the
 *        sealed acceptance run) a single synthetic development operator is
 *        honoured, below. Locally there is no Access, no IdP and no secret
 *        store, so there is nothing else for a local operator identity to be.
 *
 * ⚠ OPERATIONAL CONSEQUENCE OF (2): after deploying, `wrangler secret put
 * OPERATOR_EMAILS` or `/leads` is a 404 for you too. That is deliberate, and
 * it is the same trade `BRIDGE_CLIENT_ID`/`BRIDGE_CLIENT_SECRET` already make.
 *
 * The setting is a *secret*, not a `[vars]` entry, for two reasons: this repo
 * is public and an operator's address is not something to publish in it, and a
 * list of who can reach customer data is exactly the kind of thing that should
 * need a credential to change.
 */

/**
 * The one identity that is an operator when nothing is configured and nothing
 * evaluated the request before this Worker did.
 *
 * `example.test` is reserved by RFC 6761: it can never be registered, can never
 * receive mail, and therefore can never be an address an identity provider
 * returns to Cloudflare Access. So this cannot become a real production
 * operator by accident — and it is not honoured behind the edge in any case.
 */
export const DEV_OPERATOR_EMAIL = "ops@example.test"

/** The operator, if this request is one. `null` is "not an operator", full stop. */
export interface Operator {
  /**
   * Exactly the address Access presented, not a normalised copy of it — this is
   * display copy for `identity-email` ("signed in as …"), and a screen that
   * silently re-cases the address a person signed in with is confusing at
   * precisely the moment (issue #33: the seat email is load-bearing) when an
   * operator most needs to trust what the screen says.
   */
  email: string
}

export function readOperator(request: Request, env: Env): Operator | null {
  const email = readAccessIdentity(request).email?.trim()
  if (!email) return null

  const allowlist = operatorAllowlist(request, env)
  return allowlist.has(email.toLowerCase()) ? { email } : null
}

/**
 * The configured allowlist, lower-cased, or the local fallback described above.
 *
 * Both `OPERATOR_EMAILS` (a list) and `OPERATOR_EMAIL` (the singular the Gate-A
 * contract suggests) are read, so a deployment configured either way works.
 * Separators are commas or whitespace, so a list pasted out of a spreadsheet or
 * a chat message lands correctly without anyone having to know which.
 */
function operatorAllowlist(request: Request, env: Env): Set<string> {
  const configured = [env.OPERATOR_EMAILS, env.OPERATOR_EMAIL]
    .flatMap((value) => (value ?? "").split(/[,\s]+/))
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.includes("@"))

  if (configured.length > 0) return new Set(configured)

  return new Set(isBehindCloudflareEdge(request) ? [] : [DEV_OPERATOR_EMAIL])
}
