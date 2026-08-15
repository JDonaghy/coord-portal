import { recordedFakeEmails } from "../mailProvider"
import { json } from "../router"
import type { Env } from "../types"

/**
 * `GET /__outbound` — dev-only read surface for issue #51's recording fake's
 * captured payloads.
 *
 * Not pinned by `tests/acceptance/ms-3/contract.md` — § "The provider seam"
 * says the opposite ("not HTTP-observable"), which is exactly the gap issue
 * #83 was filed against: every CTA assertion this milestone shipped landed on
 * `GET /outbox`, "the portal's own rendering of what it decided to send,"
 * because nothing exposed what the drain actually handed the provider, and
 * every real email went out with no link as a result. #83 Scope item 4:
 * "Assert it in the sealed slice, on the recorded provider payload" — this
 * route is what makes that payload readable at all.
 *
 * `tests/acceptance/ms-3/83-email-link.spec.ts` probes this exact path first,
 * ahead of a handful of fallbacks, and documents it as "this slice's
 * recommendation, and the one a contract amendment should pin" — same `__`
 * convention, same "local dev / acceptance only, never in production" rule
 * the contract already applies to `GET /__scheduled`.
 *
 * Gated on `env.MAIL_PROVIDER === "fake"`, the exact condition
 * `src/mailProvider.ts`'s `selectMailProvider` uses to pick the recording
 * fake at all: the real `ResendMailProvider` never calls
 * `recordedFakeEmails`'s recorder, so there is nothing to read when it is
 * selected, and production never sets this var to `"fake"` (see
 * `Env.MAIL_PROVIDER`'s own doc in `src/types.ts`) — so this route 404s there
 * exactly like every environment that has not opted into the fake, the same
 * shape `leadsNotFound()` uses elsewhere in this repo to answer "not an
 * operator" and "does not exist" identically.
 */
export function outboundRecordings(env: Env): Response {
  if (env.MAIL_PROVIDER !== "fake") {
    return json({ error: "not_found" }, { status: 404 })
  }
  return json({ emails: recordedFakeEmails() })
}
