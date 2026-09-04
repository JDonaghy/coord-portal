import { accountProfile, submitAccountProfile } from "./routes/account"
import {
  clientDetail,
  clientsIndex,
  matchClientsPath,
  postClientMerge,
  postClientProjectRename,
} from "./routes/clients"
import { submissionsDashboard } from "./routes/dashboard"
import { deliveries } from "./routes/deliveries"
import { frontDoor } from "./routes/home"
import { intakeForm, submitIntake } from "./routes/intake"
import {
  leadDetail,
  leadsInbox,
  leadsNotFound,
  matchLeadsPath,
  postLeadMessage,
  postLeadProjectRename,
  postLeadReassign,
  postLeadStartWork,
  promoteLeadAction,
} from "./routes/leads"
import { matchMockBundlePath, matchOperatorMockBundlePath, mockBundle, operatorMockBundle } from "./routes/mocks"
import { outbox } from "./routes/outbox"
import {
  matchRepliesPath,
  postReplyApprove,
  postReplyDiscard,
  postReplyPromote,
  postReplyRoute,
  repliesInbox,
  replyDetail,
} from "./routes/replies"
import { projectDetail } from "./routes/project"
import {
  matchRequestsPath,
  postRequestReassign,
  requestDetail,
  requestRounds,
  requestsInbox,
} from "./routes/requests"
import { startForm, submitStart } from "./routes/start"
import { submissionDetail, submissionRounds, submitSubmissionAction } from "./routes/submission"
import type { Env } from "./types"

const SUBMISSION_ROUNDS_PATH = /^\/submissions\/([^/?#]+)\/rounds$/
const SUBMISSION_PATH = /^\/submissions\/([^/?#]+)$/
const PROJECT_PATH = /^\/projects\/([^/?#]+)$/

/**
 * Server-rendered portal pages — everything in this milestone's scope that is
 * not `/api/*` and not a static file under `public/`.
 *
 * Returns `null` for anything it does not own, so the caller (`src/index.ts`)
 * can fall through to `env.ASSETS.fetch` for a genuinely unmatched path.
 *
 * Every route here sits behind Cloudflare Access in production (issue #12),
 * **except `/start`** (issue #31): that one route is deliberately public —
 * see `routes/start.ts` — and needs its own Access **Bypass** policy in the
 * dashboard, the same way `/api/health` already has one (README.md, "Access").
 * `/` (issue #84, `routes/home.ts`) stays behind the *existing* site Access
 * app — no policy change here — but still branches on whether an identity is
 * present, because the sealed acceptance harness and any other Access-less
 * context reach this handler with none.
 * This file's job is only to render; the ownership scoping that keeps a
 * customer to their own submissions lives in `routes/dashboard.ts` and
 * `routes/submission.ts`, next to the queries it constrains.
 */
export async function handlePages(request: Request, env: Env): Promise<Response | null> {
  const { pathname } = new URL(request.url)

  // The bare domain (issue #84). `public/index.html` — the day-one
  // placeholder this replaced — is gone, so nothing under `public/` matches
  // `/` any more and every request for it reaches this handler.
  if (pathname === "/" && request.method === "GET") {
    return frontDoor(request, env)
  }

  if (pathname === "/intake") {
    if (request.method === "GET") return intakeForm(request, env)
    if (request.method === "POST") return submitIntake(request, env)
    return null
  }

  if (pathname === "/start") {
    if (request.method === "GET") return startForm(request, env)
    if (request.method === "POST") return submitStart(request, env)
    return null
  }

  if (pathname === "/submissions" && request.method === "GET") {
    return submissionsDashboard(request, env)
  }

  // The client's own self-service profile (issue #131) — phone, cc emails,
  // address on their own `clients` row (#128). Behind the same customer
  // Access application every other route in this block sits behind; see
  // `routes/account.ts`.
  if (pathname === "/account") {
    if (request.method === "GET") return accountProfile(request, env)
    if (request.method === "POST") return submitAccountProfile(request, env)
    return null
  }

  // The combined view for a customer relationship spanning more than one
  // submission (issue #109) — the counterpart `/submissions/:id` links to
  // once two or more of a customer's own submissions share a project. GET
  // only: a project has nothing a customer writes to directly (see
  // `routes/project.ts`).
  const projectMatch = pathname.match(PROJECT_PATH)
  if (projectMatch && request.method === "GET") {
    const id = projectMatch[1]
    if (id) return projectDetail(request, env, id)
  }

  // The outbox (issue #14) — a black-box read-back of what the portal decided
  // to send, since the Gate-A contract pins the email DOM but no route that
  // renders it. See `routes/outbox.ts`.
  if (pathname === "/outbox" && request.method === "GET") {
    return outbox(request, env)
  }

  // The operator's delivery view (#55) — every outbox row, every customer,
  // the counterpart to the customer-scoped `/outbox` above. Owned here for
  // every method, same reasoning as `/leads…` just below: falling through to
  // `ASSETS.fetch` on an unsupported method would hand an unauthenticated
  // caller a response this contract says is operator-only. See
  // `routes/deliveries.ts`.
  if (pathname === "/deliveries") {
    if (request.method === "GET") return deliveries(request, env)
    return leadsNotFound()
  }

  // The operator's reply-approval queue (#166, EM-6 of milestone #5) — the
  // screen a drafted intake reply is read, edited and approved on before the
  // drain will ever carry it. Owned here for every method on any `/replies…`
  // path, same reasoning as `/deliveries` just above and `/leads…` below;
  // `matchRepliesPath`'s own `"other"` catch-all is what makes that true for
  // any path this route does not answer. `/promote` (#167, EM-7) is the
  // fourth action. See `routes/replies.ts`.
  const repliesMatch = matchRepliesPath(pathname)
  if (repliesMatch) {
    if (repliesMatch.kind === "index" && request.method === "GET") {
      return repliesInbox(request, env)
    }
    if (repliesMatch.kind === "detail" && request.method === "GET") {
      return replyDetail(request, env, repliesMatch.id)
    }
    if (repliesMatch.kind === "approve" && request.method === "POST") {
      return postReplyApprove(request, env, repliesMatch.id)
    }
    if (repliesMatch.kind === "discard" && request.method === "POST") {
      return postReplyDiscard(request, env, repliesMatch.id)
    }
    if (repliesMatch.kind === "route" && request.method === "POST") {
      return postReplyRoute(request, env, repliesMatch.id)
    }
    if (repliesMatch.kind === "promote" && request.method === "POST") {
      return postReplyPromote(request, env, repliesMatch.id)
    }
    return leadsNotFound()
  }

  // The operator's every-submission view (#104) — the counterpart to the
  // customer-scoped `/submissions` above, the same way `/deliveries` (#55) is
  // to `/outbox`. Owned here for every method, same reasoning as `/deliveries`
  // just above: falling through to `ASSETS.fetch` on an unsupported method
  // would hand an unauthenticated caller a response this contract says is
  // operator-only. See `routes/requests.ts`.
  // `/requests/:id` and `/requests/:id/reassign` (issue #145) — the second
  // entry point onto #130's reassignment mechanic, for a submission that has
  // no lead to reach `/leads/:id` through. `/requests/:id/rounds` (issue
  // #304) is the operator-scoped read of that submission's design-round
  // history — see `routes/requests.ts`'s module comment, "ISSUE #304's
  // OPERATOR ROUND READ", for why this surface now owns that too. Owned here
  // for every method on any `/requests…` path, same reasoning as `/leads…`
  // below: falling through to `ASSETS.fetch` on an unsupported method would
  // hand an unauthenticated caller a response this contract says is
  // operator-only. See `routes/requests.ts`.
  const requestsMatch = matchRequestsPath(pathname)
  if (requestsMatch) {
    if (requestsMatch.kind === "index" && request.method === "GET") {
      return requestsInbox(request, env)
    }
    if (requestsMatch.kind === "detail" && request.method === "GET") {
      return requestDetail(request, env, requestsMatch.id)
    }
    if (requestsMatch.kind === "reassign" && request.method === "POST") {
      return postRequestReassign(request, env, requestsMatch.id)
    }
    if (requestsMatch.kind === "rounds" && request.method === "GET") {
      return requestRounds(request, env, requestsMatch.id)
    }
    return leadsNotFound()
  }

  // The operator's client list and per-client project view (#144) — "who are
  // my customers" and "what projects does this customer have", the two
  // questions `/leads` and `/deliveries` cannot answer. Owned here for every
  // method, same reasoning as `/deliveries` just above. See `routes/clients.ts`.
  const clientsMatch = matchClientsPath(pathname)
  if (clientsMatch) {
    if (clientsMatch.kind === "index" && request.method === "GET") {
      return clientsIndex(request, env)
    }
    if (clientsMatch.kind === "detail" && request.method === "GET") {
      return clientDetail(request, env, clientsMatch.id)
    }
    // Issue #150 — "merge client B into client A after the fact". See
    // `routes/clients.ts`'s module comment for why this is the one write
    // this surface owns.
    if (clientsMatch.kind === "merge" && request.method === "POST") {
      return postClientMerge(request, env, clientsMatch.id)
    }
    // Issue #156 — name or rename one of this client's projects directly, by
    // project id, from the screen that lists them. The project-keyed
    // counterpart to `/leads/:id/project/rename` (#149) — see
    // `routes/clients.ts`'s module comment for why this route exists
    // alongside that one rather than instead of it.
    if (clientsMatch.kind === "rename-project" && request.method === "POST") {
      return postClientProjectRename(request, env, clientsMatch.clientId, clientsMatch.projectId)
    }
    return leadsNotFound()
  }

  // The operator's lead triage surface (#33). Owned here for every method, not
  // just the ones it answers: falling through to `ASSETS.fetch` on, say, a GET
  // of `/leads/:id/promote` would hand an unauthenticated caller the static
  // site's response for a path this contract says is operator-only. `null` from
  // here means "not mine"; `/leads…` is always mine.
  const leadsMatch = matchLeadsPath(pathname)
  if (leadsMatch) {
    if (leadsMatch.kind === "index" && request.method === "GET") {
      return leadsInbox(request, env)
    }
    if (leadsMatch.kind === "detail" && request.method === "GET") {
      return leadDetail(request, env, leadsMatch.id)
    }
    if (leadsMatch.kind === "promote" && request.method === "POST") {
      return promoteLeadAction(request, env, leadsMatch.id)
    }
    // The operator's half of issue #110's chat thread — see
    // `routes/leads.ts`'s module comment for why it lives here rather than
    // on `/submissions/:id`.
    if (leadsMatch.kind === "message" && request.method === "POST") {
      return postLeadMessage(request, env, leadsMatch.id)
    }
    // Issue #130 — move the promoted submission to a different (or new)
    // project of the same client. See `routes/leads.ts`'s module comment,
    // "THE FIFTH ROUTE", for why this lives here too.
    if (leadsMatch.kind === "reassign" && request.method === "POST") {
      return postLeadReassign(request, env, leadsMatch.id)
    }
    // Issue #132 — the operator "start work" override: skip the sign-off
    // loop and land the attached submission on the customer-visible
    // equivalent of Planned. Same operator gate, same route file, for the
    // same reason #130's reassignment does — see `routes/leads.ts`.
    if (leadsMatch.kind === "start-work" && request.method === "POST") {
      return postLeadStartWork(request, env, leadsMatch.id)
    }
    // Issue #149 — name or rename the promoted lead's current project. Same
    // operator gate, same route file, for the same reason #130's
    // reassignment does — see `routes/leads.ts`.
    if (leadsMatch.kind === "rename-project" && request.method === "POST") {
      return postLeadProjectRename(request, env, leadsMatch.id)
    }
    // Any other method on a `/leads…` path gets the same 404 a non-operator
    // gets — see `src/operators.ts`. A 405 would confirm the path exists.
    return leadsNotFound()
  }

  const roundsMatch = pathname.match(SUBMISSION_ROUNDS_PATH)
  if (roundsMatch && request.method === "GET") {
    const id = roundsMatch[1]
    if (id) return submissionRounds(request, env, id)
  }

  // The round's mock bundle, out of R2 (issue #13). GET only on this
  // customer-facing path — the upload half (#120) is a bridge route,
  // `POST /api/bridge/mocks/:reference/:round`, wired in `src/router.ts`; see
  // `routes/mocks.ts`.
  const bundleMatch = matchMockBundlePath(pathname)
  if (bundleMatch && request.method === "GET") {
    return mockBundle(request, env, bundleMatch.id, bundleMatch.round, bundleMatch.rest)
  }

  // The operator-scoped read of the same bundle (issue #304) — same R2 key,
  // same headers, same bytes, gated by `readOperator` instead of `isOwnedBy`.
  // Matched here rather than folded into `matchRequestsPath` above for the
  // same reason the customer path just above is split from
  // `SUBMISSION_ROUNDS_PATH`/`SUBMISSION_PATH`: this is a nested resource
  // under a submission id, not a flat `/requests…` action. See
  // `routes/mocks.ts`'s module comment.
  const operatorBundleMatch = matchOperatorMockBundlePath(pathname)
  if (operatorBundleMatch && request.method === "GET") {
    return operatorMockBundle(
      request,
      env,
      operatorBundleMatch.id,
      operatorBundleMatch.round,
      operatorBundleMatch.rest,
    )
  }

  const submissionMatch = pathname.match(SUBMISSION_PATH)
  if (submissionMatch) {
    const id = submissionMatch[1]
    if (id && request.method === "GET") return submissionDetail(request, env, id)
    // POST /submissions/:id — answering an open question (#11), approving a
    // design round or requesting changes on it (#13). Same path as the GET
    // above, same "form posts back to its own route" convention `/intake`
    // already uses; the `action` field says which.
    if (id && request.method === "POST") return submitSubmissionAction(request, env, id)
  }

  return null
}
