import { submissionsDashboard } from "./routes/dashboard"
import { intakeForm, submitIntake } from "./routes/intake"
import { matchMockBundlePath, mockBundle } from "./routes/mocks"
import { startForm, submitStart } from "./routes/start"
import { submissionDetail, submissionRounds, submitSubmissionAction } from "./routes/submission"
import type { Env } from "./types"

const SUBMISSION_ROUNDS_PATH = /^\/submissions\/([^/?#]+)\/rounds$/
const SUBMISSION_PATH = /^\/submissions\/([^/?#]+)$/

/**
 * Server-rendered portal pages — everything in this milestone's scope that is
 * not `/api/*` and not a static file under `public/`.
 *
 * Returns `null` for anything it does not own, so the caller (`src/index.ts`)
 * can fall through to `env.ASSETS.fetch`, same as it already does for `/`.
 *
 * Every route here sits behind Cloudflare Access in production (issue #12),
 * **except `/start`** (issue #31): that one route is deliberately public —
 * see `routes/start.ts` — and needs its own Access **Bypass** policy in the
 * dashboard, the same way `/api/health` already has one (README.md, "Access").
 * This file's job is only to render; the ownership scoping that keeps a
 * customer to their own submissions lives in `routes/dashboard.ts` and
 * `routes/submission.ts`, next to the queries it constrains.
 */
export async function handlePages(request: Request, env: Env): Promise<Response | null> {
  const { pathname } = new URL(request.url)

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
