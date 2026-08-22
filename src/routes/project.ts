import { resolveSiteIdentity } from "../identity"
import { isOperatorEmail } from "../operators"
import { getProject } from "../projects"
import { escapeHtml, html, page, topbar } from "../render"
import { derivedStatus, listRounds, loadSignoffStates, type DesignRound } from "../rounds"
import {
  customerFacingStatus,
  listSubmissionsForProject,
  statusText,
  titleOf,
  type Submission,
  type SubmissionStatus,
} from "../submissions"
import type { Env } from "../types"
import { roundEntry } from "./submission"

/**
 * GET /projects/:id — issue #109's combined view: "a project-level view that
 * combines the round histories of every submission under it into one
 * timeline, rather than requiring the customer to know which submission ID
 * covers which round."
 *
 * One route, GET only — a project has nothing a customer writes to directly
 * (see `migrations/0012_projects.sql`: no status, no title, nothing owned
 * here). Everything on this screen is read from the submissions under it, the
 * same submissions already reachable one at a time at `/submissions/:id`;
 * this page is a different arrangement of the same data, not a new source of
 * it.
 *
 * Ownership is `project.customerEmail === the caller's verified identity` —
 * the project-level version of the exact check `isOwnedBy` makes for one
 * submission (`routes/submission.ts`) — and fails the same way: a project
 * that does not exist and a project that belongs to someone else render the
 * identical 404, so knowing (or guessing) a `proj_…` id is not itself a way
 * to learn whether it is real.
 */
export async function projectDetail(request: Request, env: Env, id: string): Promise<Response> {
  const email = await resolveSiteIdentity(request, env)
  const project = await getProject(env, id)
  if (!project || !email || project.customerEmail !== email) {
    return html(page("Not found — coord-portal", notFound()), { status: 404 })
  }

  const submissions = await listSubmissionsForProject(env, id, email)

  // Same derivation the dashboard and each submission's own detail screen
  // use (`src/rounds.ts`), so a round this customer just sent back for
  // changes does not read "Awaiting your sign-off" here while every other
  // screen has already moved on.
  const states = await loadSignoffStates(
    env,
    submissions
      .filter((submission) => submission.status === "awaiting-signoff")
      .map((submission) => submission.reference),
  )

  // One `listRounds` per submission — a project groups few enough
  // submissions (each one a deliberate, human-initiated follow-up, never an
  // automatic merge) that fetching them in sequence costs one extra D1
  // round-trip per member, not a query that scales with the whole table the
  // way an unbounded fan-out would.
  const blocks: string[] = []
  for (const submission of submissions) {
    const display = customerFacingStatus(
      derivedStatus(submission.status, states.get(submission.reference) ?? null),
    )
    const rounds = await listRounds(env, submission.reference)
    blocks.push(submissionBlock(submission, display, rounds))
  }

  // Additive to the ownership scoping above, never a substitute for it — see
  // `dashboard.ts`'s identical call, and `isOperatorEmail` in
  // `src/operators.ts`, for the full rationale (issue #103).
  const isOperator = isOperatorEmail(email, request, env)

  return html(
    page("Project history — coord-portal", projectPage(email, isOperator, submissions, blocks)),
  )
}

function projectPage(
  email: string | null,
  isOperator: boolean,
  submissions: Submission[],
  blocks: string[],
): string {
  // Newest first — `listSubmissionsForProject` already orders it that way,
  // and its first entry is the current state of the relationship, the same
  // way the dashboard's grouped row picks its title and status from it.
  const newest = submissions[0]
  const title = newest ? titleOf(newest) : "Project history"
  const count = submissions.length
  const countLabel = count === 1 ? "1 request" : `${count} requests`

  return `${topbar(email, "dashboard", isOperator)}
<main data-testid="project-detail">
  <a class="back-link" href="/submissions" data-testid="back-to-dashboard">&larr; My requests</a>
  <h1>${escapeHtml(title)}</h1>
  <p class="meta" data-testid="project-summary">${countLabel} in this project's combined history</p>

  <div data-testid="project-timeline">
${blocks.join("\n")}
  </div>
</main>`
}

/**
 * One submission's slice of the combined timeline: its own reference, current
 * status and filed date, then every design round it has ever had — rendered
 * with `roundEntry` (`routes/submission.ts`), the identical markup
 * `/submissions/:id/rounds` uses for one submission's own history, so a round
 * reads the same whether it is seen there or folded into this combined view.
 */
function submissionBlock(submission: Submission, display: SubmissionStatus, rounds: DesignRound[]): string {
  const roundsMarkup =
    rounds.length > 0
      ? rounds.map(roundEntry).join("\n")
      : `      <p class="lede">No design round has been published for this request yet.</p>`

  return `    <section class="card" data-testid="project-submission" data-status="${escapeHtml(display)}">
      <div class="round-entry-head">
        <span class="round-badge">${escapeHtml(submission.reference)}</span>
        <span class="status-pill" data-testid="status-pill" data-status="${escapeHtml(display)}">${escapeHtml(statusText(display))}</span>
        <span class="round-date">filed ${escapeHtml(submission.createdAt)}</span>
      </div>
      <h2><a href="/submissions/${submission.id}" data-testid="project-submission-link">${escapeHtml(titleOf(submission))}</a></h2>
${roundsMarkup}
    </section>`
}

function notFound(): string {
  return `<main>
  <h1>We can't find that project</h1>
  <p class="lede">It may have been submitted somewhere else, or the link is wrong.</p>
</main>`
}
