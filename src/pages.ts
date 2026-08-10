import { submissionsDashboard } from "./routes/dashboard"
import { intakeForm, submitIntake } from "./routes/intake"
import { startForm, submitStart } from "./routes/start"
import { submissionDetail, submissionRounds, submitAnswer } from "./routes/submission"
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

  const submissionMatch = pathname.match(SUBMISSION_PATH)
  if (submissionMatch) {
    const id = submissionMatch[1]
    if (id && request.method === "GET") return submissionDetail(request, env, id)
    // POST /submissions/:id — answering an open question (issue #11). Same
    // path as the GET above, same "form posts back to its own route"
    // convention `/intake` already uses.
    if (id && request.method === "POST") return submitAnswer(request, env, id)
  }

  return null
}
