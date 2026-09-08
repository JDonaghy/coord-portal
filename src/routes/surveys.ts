import { getProjectsByIds } from "../projects"
import { readOperator, type Operator } from "../operators"
import { escapeHtml, html, operatorTopbar, page } from "../render"
import { titleFromOutcome } from "../submissions"
import { SURVEY_RATING_LABELS, SURVEY_RATINGS, type SurveyRating } from "../surveys"
import type { Env } from "../types"
import { leadsNotFound } from "./leads"

/**
 * `GET /surveys` — issue #329, the operator's read of every customer survey
 * response on file (#328's capture).
 *
 * #329's own motivating line: "capture with nowhere to read it is worse than
 * not asking — the customer believes they have been heard." `src/surveys.ts`
 * records a response but, before this issue, rendered it back only on the
 * customer's own `/submissions/:id` — there was no way for an operator to see
 * across every customer's responses at once, the same gap #104 closed for
 * submissions (`/requests`) and #55 closed for outbox rows (`/deliveries`).
 *
 * ── AUTH: NOT A NEW MECHANISM ────────────────────────────────────────────
 * Same `readOperator` gate every other operator-only screen on this surface
 * uses, same indistinguishable 404 (`leadsNotFound()`) for anyone it
 * rejects — an anonymous caller, an ordinary customer, or (with no operator
 * configured behind Cloudflare's edge) literally everyone. See
 * `src/operators.ts`.
 *
 * ── WHY THIS QUERIES `submission_surveys` AND `submissions` DIRECTLY ────────
 * `submission_surveys` (owned by `src/surveys.ts`) has no `project_id` or
 * `customer_email` column of its own — that module's own doc comment on the
 * table explains why: it is a portal-owned fact keyed on the customer-visible
 * reference alone, with nothing coord-owned to reconcile against and no
 * project/client relationship it needs for its own job (recording a response,
 * reading it back on the one screen that used to show it). Answering "whose
 * project was this" needs a join against `submissions`, and rather than add a
 * first unscoped-by-customer reader to `src/submissions.ts` — whose own doc
 * comments, and `routes/requests.ts`'s at length, are explicit that ownership
 * is the query there — this route reads both tables itself. This is the
 * identical choice `routes/requests.ts`'s `listAllRequestRows` already makes
 * for `submissions` (and batches `getProjectsByIds` for `projects`), for the
 * same reason.
 *
 * ── SCOPE ─────────────────────────────────────────────────────────────────
 * Read-only, per #329's own rule: no edit, no delete, no reply from this
 * screen — a reply to a customer is an email, and it goes through the
 * existing outbound path with its approval gate. No aggregate score, no
 * average, no chart, per the issue's second rule — with this volume an
 * average is noise, the individual comments are the signal. No filtering,
 * search or pagination either, the same restraint `/requests` and
 * `/deliveries` put on themselves until the volume exists to justify them.
 *
 * A response with nobody answering does not appear here at all — there is no
 * row in `submission_surveys` for it to join against. "Say plainly when
 * nobody answered" is answered on `/requests` instead (`listAllRequestRows`'s
 * `survey` field), the one screen that already lists every shipped submission
 * whether or not it has a response.
 */
export async function surveysInbox(request: Request, env: Env): Promise<Response> {
  const operator = await readOperator(request, env)
  if (!operator) return leadsNotFound()

  const rows = await listSurveyRows(env)
  return html(page("Responses — coord-portal", surveysPage(operator, rows)))
}

interface SurveyJoinRow {
  reference: string
  rating: number
  comment: string | null
  created_at: string
  submission_row_id: string
  project_id: string | null
  customer_email: string | null
  outcome: string
}

export interface SurveyResponseRow {
  /** The submission's own row id — what a link back to `/requests/:id` needs. */
  submissionId: string
  reference: string
  rating: SurveyRating
  comment: string | null
  createdAt: string
  /** Project name if the submission belongs to a named project, otherwise
   * `titleFromOutcome` of its own outcome — the identical fallback
   * `listAllRequestRows` (`routes/requests.ts`) already uses for the same
   * "what do we call this on an operator screen" question. */
  title: string
  customerEmail: string | null
}

function isSurveyRating(value: number): value is SurveyRating {
  return (SURVEY_RATINGS as readonly number[]).includes(value)
}

/**
 * Every response on file, newest first, joined against the submission it
 * belongs to for the project/client this screen shows alongside it — see this
 * file's module comment, "WHY THIS QUERIES … DIRECTLY", for why that join
 * lives here rather than in either owning module.
 */
async function listSurveyRows(env: Env): Promise<SurveyResponseRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT ss.submission_id AS reference, ss.rating, ss.comment, ss.created_at,
            s.id AS submission_row_id, s.project_id, s.customer_email, s.outcome
       FROM submission_surveys ss
       JOIN submissions s ON s.reference = ss.submission_id
      ORDER BY ss.created_at DESC`,
  ).all<SurveyJoinRow>()
  const rows = results ?? []

  const projectIds = [...new Set(rows.map((row) => row.project_id).filter((id): id is string => !!id))]
  const projects = await getProjectsByIds(env, projectIds)

  // A stored rating outside 1–5 can only come from a hand-edited row — the
  // `CHECK` constraint on `submission_surveys.rating`
  // (`migrations/0028_submission_surveys.sql`) backstops this further.
  // Skipped rather than guessed at, the same defensive posture
  // `src/surveys.ts`'s own `fromRow` takes for the identical case.
  return rows
    .filter((row): row is SurveyJoinRow & { rating: SurveyRating } => isSurveyRating(row.rating))
    .map((row) => {
      const project = row.project_id ? projects.get(row.project_id) : undefined
      return {
        submissionId: row.submission_row_id,
        reference: row.reference,
        rating: row.rating,
        comment: row.comment,
        createdAt: row.created_at,
        title: project?.name ?? titleFromOutcome(row.outcome),
        customerEmail: row.customer_email,
      }
    })
}

function surveysPage(operator: Operator, rows: SurveyResponseRow[]): string {
  return `${operatorTopbar(operator.email, "surveys")}
<main>
  <div class="page-head">
    <h1>Responses</h1>
  </div>
  <p class="lede">Every customer survey response on file, newest first. Read-only — a reply to a customer is an email, sent through the existing outbound path and its approval gate, not from this screen.</p>
  ${rows.length > 0 ? surveysList(rows) : emptySurveys()}
</main>`
}

function surveysList(rows: SurveyResponseRow[]): string {
  return `<ul class="responses-list" data-testid="responses-list">
${rows.map(surveyRow).join("\n")}
  </ul>`
}

/**
 * Mirrors `routes/requests.ts`'s `emptyRequests()` / `routes/leads.ts`'s
 * `emptyInbox()` — present instead of the list, never alongside it.
 */
function emptySurveys(): string {
  return `<p class="lede" data-testid="responses-list-empty">No responses yet.</p>`
}

function surveyRow(row: SurveyResponseRow): string {
  const href = `/requests/${encodeURIComponent(row.submissionId)}`
  const comment = row.comment
    ? `
          <p class="comment" data-testid="response-comment">${escapeHtml(row.comment)}</p>`
    : ""

  return `    <li>
      <div class="response-row" data-testid="response-row" data-rating="${row.rating}">
        <div class="row-main">
          <a class="title" href="${href}" data-testid="response-title">${escapeHtml(row.title)}</a>
          <span class="meta">
            <span data-testid="response-customer">${escapeHtml(row.customerEmail ?? "no email on file")}</span>
            &middot; <span data-testid="response-date">${escapeHtml(row.createdAt)}</span>
          </span>${comment}
        </div>
        <div class="row-side">
          <span class="survey-pill" data-testid="response-rating" data-rating="${row.rating}">${escapeHtml(SURVEY_RATING_LABELS[row.rating])}</span>
          <a class="button secondary" href="${href}" data-testid="response-open-link">Open</a>
        </div>
      </div>
    </li>`
}
