import { intakeForm, submitIntake } from "./routes/intake"
import { submissionDetail } from "./routes/submission"
import type { Env } from "./types"

const SUBMISSION_PATH = /^\/submissions\/([^/?#]+)$/

/**
 * Server-rendered portal pages — everything in this milestone's scope that is
 * not `/api/*` and not a static file under `public/`.
 *
 * Returns `null` for anything it does not own, so the caller (`src/index.ts`)
 * can fall through to `env.ASSETS.fetch`, same as it already does for `/`.
 * `GET /submissions` (the dashboard, #10) is deliberately not handled here —
 * out of scope for this issue.
 */
export async function handlePages(request: Request, env: Env): Promise<Response | null> {
  const { pathname } = new URL(request.url)

  if (pathname === "/intake") {
    if (request.method === "GET") return intakeForm(request, env)
    if (request.method === "POST") return submitIntake(request, env)
    return null
  }

  const submissionMatch = pathname.match(SUBMISSION_PATH)
  if (submissionMatch && request.method === "GET") {
    const id = submissionMatch[1]
    if (id) return submissionDetail(request, env, id)
  }

  return null
}
