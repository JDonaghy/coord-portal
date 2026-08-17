import { submissionsDashboard } from "./routes/dashboard"
import { deliveries } from "./routes/deliveries"
import { frontDoor } from "./routes/home"
import { intakeForm, submitIntake } from "./routes/intake"
import {
  leadDetail,
  leadsInbox,
  leadsNotFound,
  matchLeadsPath,
  promoteLeadAction,
} from "./routes/leads"
import { matchMockBundlePath, mockBundle } from "./routes/mocks"
import { outbox } from "./routes/outbox"
import { projectDetail } from "./routes/project"
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
    // Any other method on a `/leads…` path gets the same 404 a non-operator
    // gets — see `src/operators.ts`. A 405 would confirm the path exists.
    return leadsNotFound()
  }

  const roundsMatch = pathname.match(SUBMISSION_ROUNDS_PATH)
  if (roundsMatch && request.method === "GET") {
    const id = roundsMatch[1]
    if (id) return submissionRounds(request, env, id)
  }

  // The round's mock bundle, out of R2 (issue #13). GET only — there is no
  // upload half on this side; see `routes/mocks.ts`.
  const bundleMatch = matchMockBundlePath(pathname)
  if (bundleMatch && request.method === "GET") {
    return mockBundle(request, env, bundleMatch.id, bundleMatch.round, bundleMatch.rest)
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
