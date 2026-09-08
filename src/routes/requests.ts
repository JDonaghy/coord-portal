import { appendEventStatement } from "../bridge/events"
import {
  approveOutboundDraftStatement,
  listPendingOutboundDrafts,
  rejectOutboundDraftStatement,
  type CoordOutboundDraft,
  type CoordOutboundDraftKind,
} from "../coordOutboundDrafts"
import { parseFormData } from "../formData"
import { sendTypeForStatus } from "../notifications"
import { readOperator, type Operator } from "../operators"
import { recordOperatorRead } from "../operatorAccess"
import { getProjectsByIds } from "../projects"
import { escapeHtml, html, operatorTopbar, page } from "../render"
import {
  derivedStatus,
  getCurrentRound,
  listRounds,
  loadSignoffStates,
  VERDICT_TEXT,
  type DesignRound,
  type RoundVerdict,
  type SignoffState,
} from "../rounds"
import { derivedStartWorkStatus, getStartWork, loadStartWorkStates, type StartWorkRecord } from "../startWork"
import {
  customerFacingStatus,
  getSubmission,
  isSubmissionStatus,
  statusText,
  titleFromOutcome,
  titleOf,
  type Submission,
  type SubmissionStatus,
} from "../submissions"
import { loadSurveyResponses, SURVEY_RATING_LABELS, type SurveyResponse } from "../surveys"
import type { Env } from "../types"
import {
  applyReassignmentChoice,
  leadsNotFound,
  loadReassignmentOptions,
  reassignPanel,
  type ReassignmentOptions,
} from "./leads"
import { isFormContentType } from "./submission"

/**
 * `GET /requests` — issue #104, the operator's counterpart to `/submissions`.
 *
 * #104's own motivating line: an operator can already see every lead
 * (`/leads`, #33) and every delivery (`/deliveries`, #55), but `/submissions`
 * (`routes/dashboard.ts`) is ownership-scoped to `customer_email = ` the
 * caller's own Access identity, by design since #12. The moment an operator
 * promotes a lead, the submission it just created becomes invisible to the
 * operator who created it — there is no operator-scoped equivalent, and the
 * only way to answer "what state is that customer's request in" is to query
 * D1 directly.
 *
 * ── WHY THIS IS A NEW ROUTE, NOT A BRANCH INSIDE `/submissions` ───────────
 * #104 is explicit: "`/submissions` and `/submissions/:id` are the customer's
 * screens, and their ownership check is load-bearing — the sealed suite pins
 * 'one customer cannot open another customer's submission by URL' and 'no
 * query parameter widens the dashboard past the caller'
 * (`ms-1/12-access-auth.spec.ts`). Widening those routes for operators would
 * be changing exactly the assertion that keeps customers apart. Do not add an
 * operator branch inside them." So this file never imports
 * `listSubmissionsForCustomer` and never touches `routes/dashboard.ts`; it is
 * its own query, its own route, its own template — the exact shape
 * `routes/deliveries.ts` already established against `routes/outbox.ts` (#55),
 * down to reusing that pair's own gate and 404.
 *
 * ── AUTH: NOT A NEW MECHANISM ────────────────────────────────────────────
 * Same `readOperator` gate `/leads` and `/deliveries` already use, same
 * indistinguishable 404 (`leadsNotFound()`) for anyone it rejects — an
 * anonymous caller, a customer who owns rows in the very list they were
 * refused, or (with no operator configured behind Cloudflare's edge) literally
 * everyone. See `src/operators.ts`.
 *
 * ── WHY THIS QUERIES `submissions` DIRECTLY ───────────────────────────────
 * `src/submissions.ts` has no "every submission, unscoped" export — every
 * reader there takes an owning `customerEmail` or a `projectId` a caller has
 * already checked ownership of, on purpose (see that file's own comments on
 * `listSubmissionsForCustomer` and `listSubmissionsForProject`). Rather than
 * add a first unscoped reader to a module whose whole shape is "ownership is
 * the query", this route reads the table itself — the same choice
 * `listAllOutbox` (`src/notifications.ts`) makes for `/deliveries` against
 * `outbox`, which also has no unscoped-anywhere-else caller.
 *
 * ── SCOPE ─────────────────────────────────────────────────────────────────
 * Read-only, like `/deliveries` — at first. No link into `/submissions/:id`:
 * that route is ownership-scoped to the customer's own Access identity (#12)
 * and 404s an operator by construction, so a link into it from here would be
 * a link to a 404. No filtering, search or pagination — the same restraint
 * #55 puts on `/deliveries` until the volume exists to justify them.
 *
 * ── `GET`/`POST /requests/:id` — ISSUE #145's REASSIGNMENT SURFACE ─────────
 * #125/#130 built "move a submission to a different, or new, project of the
 * same client" but wired it up as `POST /leads/:id/reassign` — reachable only
 * from the lead that produced the promoted submission. A submission an
 * already-onboarded customer files through `/intake` has no lead at all
 * (leads only exist for the public `/start` form), so there was structurally
 * no page anywhere that could offer to move it. This list is the one screen
 * that already renders *every* submission the portal holds regardless of
 * whether it has a lead, a project, or even a matched `clients` row, so it is
 * also the one screen that can host the fix without inventing a new query.
 *
 * `requestDetail`/`postRequestReassign` below are a second, submission-keyed
 * entry point to the exact same mechanic #130 already shipped —
 * `loadReassignmentOptions`/`applyReassignmentChoice`/`reassignPanel`
 * (`routes/leads.ts`) are shared, unchanged code, not a reimplementation.
 * `POST /leads/:id/reassign` keeps working exactly as it did; this adds a
 * second door onto the same room; it does not move the first one. Same
 * `readOperator` gate and indistinguishable 404 as every route on this
 * surface, so a non-operator gets a 404, never a 403.
 *
 * ── `GET /requests/:id/rounds` — ISSUE #304's OPERATOR ROUND READ ─────────
 * `requestDetail`'s own doc comment used to say plainly that this surface's
 * "contract is the reassignment panel, not a general operator submission
 * detail screen" and that round history in particular should not be added
 * "without its own issue". #304 is that issue: an operator reviewing a
 * `changes-requested` verdict could read `signoff_comment` off `coord
 * journal` but never open the mock it was commenting on, because
 * `routes/mocks.ts`'s bundle route and `routes/submission.ts`'s round history
 * both gate on `isOwnedBy` alone, and an operator's Access email is never a
 * submission's `customer_email`.
 *
 * `requestRounds` below, and `operatorMockBundle`
 * (`routes/mocks.ts`, wired in `src/pages.ts`), are the fix — a second,
 * operator-scoped read of the exact same `design_rounds`/`signoffs` state and
 * the exact same R2 bytes, never a widening of `isOwnedBy` itself (see that
 * function's own doc comment in `routes/submission.ts` for why not). Every
 * page this surface renders says so in its own copy
 * (`operator-access-notice`) — this is customer material read by an
 * operator, not a customer's own view of it — and every successful read is
 * recorded (`src/operatorAccess.ts`).
 *
 * ── ISSUE #318's DRAFT REVIEW ───────────────────────────────────────────
 * Every coord-owned push (`design_round`, `question`, `relayed_answer`,
 * `status`, `preview`) is staged in coord's own `portal_outbox` and released
 * with `coord portal draft approve` — a terminal command, and until now the
 * only way to release one, however small the edit. `requestDetail` below now
 * renders whatever this submission has queued and unreleased
 * (`listPendingOutboundDrafts`, `src/coordOutboundDrafts.ts` — the portal's
 * read-only mirror of that queue, kept current by coord's own poll against
 * `POST /api/bridge/outbound-drafts`), and `postRequestDraftApprove` /
 * `postRequestDraftReject` are the two actions: the same "Approve & send" /
 * "Reject" pair `/replies` already established for a portal-drafted reply,
 * here applied to a coord-drafted one. Approving carries whatever text the
 * operator actually edited back to coord as an `outbound_draft.approved`
 * event on the existing `bridge_events` stream (`GET /api/bridge/pull`) —
 * never a route coord calls to push a decision at; the bridge stays
 * outbound-only in both directions. The decision write
 * (`approveOutboundDraftStatement`/`rejectOutboundDraftStatement`) and that
 * event append share one `env.DB.batch()`, guarded together, the same
 * all-or-nothing pairing `confirmRelayedAnswer` (`src/questions.ts`) uses —
 * a decision recorded with no event ever announcing it is indistinguishable
 * from coord's side to a message that simply never got sent. See
 * `src/coordOutboundDrafts.ts` and `src/bridge/events.ts` for the rest of the
 * seam.
 */
export async function requestsInbox(request: Request, env: Env): Promise<Response> {
  const operator = await readOperator(request, env)
  if (!operator) return leadsNotFound()

  const rows = await listAllRequestRows(env)
  const { searchParams } = new URL(request.url)
  const filter = resolveRequestsFilter(rows, searchParams.get("client"), searchParams.get("project"))
  const visible = applyRequestsFilter(rows, filter)

  return html(page("Requests — coord-portal", requestsPage(operator, rows, visible, filter)))
}

const REQUESTS_PATH = "/requests"
const REQUEST_DETAIL_PATH = /^\/requests\/([^/?#]+)$/
const REQUEST_REASSIGN_PATH = /^\/requests\/([^/?#]+)\/reassign$/
const REQUEST_ROUNDS_PATH = /^\/requests\/([^/?#]+)\/rounds$/
const REQUEST_DRAFT_APPROVE_PATH = /^\/requests\/([^/?#]+)\/drafts\/([^/?#]+)\/approve$/
const REQUEST_DRAFT_REJECT_PATH = /^\/requests\/([^/?#]+)\/drafts\/([^/?#]+)\/reject$/

/** What `handlePages` needs to know about a `/requests…` URL, or `null`. */
export function matchRequestsPath(
  pathname: string,
):
  | { kind: "index" }
  | { kind: "detail"; id: string }
  | { kind: "reassign"; id: string }
  | { kind: "rounds"; id: string }
  | { kind: "draft-approve"; id: string; draftId: string }
  | { kind: "draft-reject"; id: string; draftId: string }
  | null {
  if (pathname === REQUESTS_PATH) return { kind: "index" }

  const reassign = pathname.match(REQUEST_REASSIGN_PATH)
  if (reassign?.[1]) return { kind: "reassign", id: reassign[1] }

  // Checked ahead of `detail` below, same reason `rounds` is: neither regex
  // has anything after the id, so `/requests/:id/drafts/:draftId/…` would
  // otherwise never reach either one. Issue #318's two actions on a coord
  // queued draft.
  const draftApprove = pathname.match(REQUEST_DRAFT_APPROVE_PATH)
  if (draftApprove?.[1] && draftApprove[2]) {
    return { kind: "draft-approve", id: draftApprove[1], draftId: draftApprove[2] }
  }
  const draftReject = pathname.match(REQUEST_DRAFT_REJECT_PATH)
  if (draftReject?.[1] && draftReject[2]) {
    return { kind: "draft-reject", id: draftReject[1], draftId: draftReject[2] }
  }

  // Checked ahead of `detail` below: `/requests/:id/rounds` would otherwise
  // never reach `REQUEST_DETAIL_PATH` (that regex requires nothing after the
  // id), but the mock-bundle path under it
  // (`/requests/:id/rounds/:n/mock[/...]`) is matched directly in
  // `src/pages.ts` via `routes/mocks.ts`'s own `matchOperatorMockBundlePath`,
  // the same split the customer-facing routes already use between
  // `SUBMISSION_ROUNDS_PATH` and `matchMockBundlePath`.
  const rounds = pathname.match(REQUEST_ROUNDS_PATH)
  if (rounds?.[1]) return { kind: "rounds", id: rounds[1] }

  const detail = pathname.match(REQUEST_DETAIL_PATH)
  if (detail?.[1]) return { kind: "detail", id: detail[1] }

  return null
}

interface SubmissionRow {
  id: string
  reference: string
  status: string
  customer_email: string | null
  outcome: string
  created_at: string
  project_id: string | null
}

/**
 * Exported for `test/requests.test.ts`'s coverage of issue #323's filtering
 * — the pure derivations below (`resolveRequestsFilter`/`applyRequestsFilter`)
 * take and return plain `RequestRow[]`, so a unit test can fabricate rows
 * directly rather than exercising the D1 query in `listAllRequestRows`.
 */
export interface RequestRow {
  id: string
  reference: string
  title: string
  customerEmail: string | null
  createdAt: string
  display: SubmissionStatus
  round: SignoffState | null
  /**
   * Issue #323's own note: this column was already selected by #316 and
   * already resolved into `title` below — filtering only needed the
   * grouping, not a new query shape. Carried on the row (rather than
   * re-derived from `title`, which for an unnamed project is derived from
   * each submission's own `outcome` and so is *not* stable across a
   * project's members — see `buildProjectOptions` below) so the client/project
   * filter can group rows by the same identity the database itself uses.
   */
  projectId: string | null
  /**
   * Issue #329: the customer's survey response for this submission, once
   * shipped — `null` both before it has shipped (nothing to answer yet) and
   * once shipped with nobody having answered. `requestRow` below tells those
   * two apart the same way `deriveDisplayStatus`'s own caller does: by
   * checking `display === "shipped"` first, since only a shipped row (see
   * `submitSurvey`'s own gate, `routes/submission.ts`) is ever eligible for
   * a response at all, and `display` is unaffected for `shipped` by every
   * derivation `deriveDisplayStatus` applies (both `derivedStatus` and
   * `derivedStartWorkStatus` only ever act on `awaiting-signoff` and
   * `describing` respectively).
   */
  survey: SurveyResponse | null
}

/**
 * Every submission across every customer, newest first, with the same
 * customer-facing status a customer's own screens would show — see
 * `routes/dashboard.ts`'s identical `displayOf`, which this mirrors rather
 * than shares: that function closes over one customer's own list, and this
 * one is deliberately the unscoped case that module's own comments say does
 * not belong there.
 */
async function listAllRequestRows(env: Env): Promise<RequestRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, reference, status, customer_email, outcome, created_at, project_id
       FROM submissions
      ORDER BY created_at DESC`,
  ).all<SubmissionRow>()
  const submissions = results ?? []

  const references = submissions.map((row) => row.reference)
  // Issue #316: the same "an operator-named project wins over the derived
  // title" rule `routes/dashboard.ts`'s `groupByProject`/`projectTitleFromNewest`
  // already apply on the customer's own `/submissions` — one batched
  // `getProjectsByIds` for every distinct project id on this page, not one
  // `getProject` per row, same reasoning as `loadSignoffStates` below. Not
  // `projectTitleFromNewest` itself: that helper wants a full `Submission` to
  // fall back to `titleOf` on, and this route's own query (like
  // `titleFromOutcome`'s doc comment in `../submissions` explains) selects
  // only the columns it needs off the unscoped table — so the fallback is
  // `titleFromOutcome` instead, re-exported below (issue #319) from the same
  // module `titleOf` now shares it with.
  const projectIds = [...new Set(submissions.map((row) => row.project_id).filter((id): id is string => !!id))]
  const projects = await getProjectsByIds(env, projectIds)
  // The newest design round + verdict for every submission that has one —
  // unfiltered by status, unlike `loadSignoffStates`'s only other caller
  // (`routes/dashboard.ts`, which asks only for `awaiting-signoff` rows to
  // derive a status from). An operator triaging the whole pipeline benefits
  // from seeing round history on a submission that has since moved past
  // sign-off too, not only the one status where it changes what is shown.
  const roundStates = await loadSignoffStates(env, references)
  // Issue #132's operator override, batched the same way — see
  // `routes/dashboard.ts`'s identical call.
  const startWorkStates = await loadStartWorkStates(
    env,
    submissions.filter((row) => row.status === "describing").map((row) => row.reference),
  )
  // Issue #329: only a `shipped` submission can have a response on file at
  // all (`submitSurvey`'s own gate, `routes/submission.ts`) — scoped the same
  // way `startWorkStates` just above scopes to `describing`, rather than
  // asking `loadSurveyResponses` to look up a reference that can never match.
  const surveyResponses = await loadSurveyResponses(
    env,
    submissions.filter((row) => row.status === "shipped").map((row) => row.reference),
  )

  return submissions.map((row) => {
    const status = isSubmissionStatus(row.status) ? row.status : "describing"
    const state = roundStates.get(row.reference) ?? null
    const display = deriveDisplayStatus(status, state, startWorkStates.get(row.reference) ?? null)
    const project = row.project_id ? projects.get(row.project_id) : undefined
    return {
      id: row.id,
      reference: row.reference,
      title: project?.name ?? titleFromOutcome(row.outcome),
      customerEmail: row.customer_email,
      createdAt: row.created_at,
      display,
      round: state,
      projectId: row.project_id,
      survey: surveyResponses.get(row.reference) ?? null,
    }
  })
}

/**
 * The one derivation `listAllRequestRows` and `requestDetail` (issue #145)
 * both need — factored out so the list's batched lookups
 * (`loadSignoffStates`/`loadStartWorkStates`, chunked for D1's bound-parameter
 * ceiling, see `src/d1.ts`) and the detail screen's single-submission ones
 * (`getCurrentRound`/`getStartWork`) feed the exact same composition rather
 * than two copies drifting apart.
 */
function deriveDisplayStatus(
  status: SubmissionStatus,
  round: SignoffState | null,
  startWork: StartWorkRecord | null,
): SubmissionStatus {
  return customerFacingStatus(derivedStartWorkStatus(derivedStatus(status, round), startWork))
}

/**
 * Issue #319: `titleFromOutcome` now lives in `../submissions`, next to
 * `titleOf`, which is just `titleFromOutcome(submission.outcome)` — the two
 * used to be separate, hand-fixed copies (this route's took the outcome
 * string this route's own query already had off the unscoped table; #316
 * fixed the salutation-skipping here and left `titleOf`'s first-line-only
 * version, the one that reaches the customer's own notifications, broken).
 * Re-exported under its original name so nothing importing it from this
 * module — `listAllRequestRows` below and `test/requests.test.ts` — has to
 * change.
 */
export { titleFromOutcome }

/* ─────────────────── issue #323: client/project filtering ──────────────── */

/**
 * `submissions.customer_email` is nullable (a defensive schema allowance;
 * `requestRow` and `requestDetailPage` already fall back to "no email on
 * file" when it is) — this is the one query-string value that can never
 * collide with a real address, since a real address always contains `@`.
 * The client filter's own "no email on file" bucket is keyed on it, both in
 * the `<option value>` this route renders and in the `?client=` it reads
 * back.
 */
export const NO_CLIENT_EMAIL_KEY = "no-email"

/** One `<option>` — shared shape for both the client and project selects. */
export interface FilterOption {
  value: string
  label: string
}

/**
 * `?client=`/`?project=` after resolving against what is actually on this
 * page — never the raw, unchecked query-string value. `client`/`project`
 * are `null` for "All clients"/"All projects", exactly the current,
 * unfiltered behaviour this issue's contract requires as the default.
 */
export interface RequestsFilter {
  client: string | null
  project: string | null
  clientOptions: FilterOption[]
  /** Scoped to `client` — "with 'All clients' chosen it lists every
   * project; picking a client narrows it" (issue #323). */
  projectOptions: FilterOption[]
}

function clientOptionValue(email: string | null): string {
  return email ?? NO_CLIENT_EMAIL_KEY
}

function clientOptionLabel(email: string | null): string {
  return email ?? "no email on file"
}

/**
 * Every client with at least one submission, most-recently-created-first
 * `rows` collapsed to one option per distinct `customerEmail` — issue #323's
 * "Client lists every client with at least one submission". Sorted
 * case-insensitively by label rather than left in `rows`' own newest-first
 * order: a `<select>` an operator is expected to scan for one known address
 * reads fastest alphabetically, and unlike the request list itself (where
 * "most recent first" is the point), option order here carries no
 * information worth preserving.
 *
 * There is no `clients.name` column (see `src/clients.ts`'s own doc
 * comment) — every label here is the address itself, "the honest label"
 * this issue's own notes call for, with `clientOptionLabel`'s fallback text
 * for the one case a row has no address to show at all.
 */
function buildClientOptions(rows: RequestRow[]): FilterOption[] {
  const seen = new Map<string, FilterOption>()
  for (const row of rows) {
    const value = clientOptionValue(row.customerEmail)
    if (!seen.has(value)) {
      seen.set(value, { value, label: clientOptionLabel(row.customerEmail) })
    }
  }
  return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label))
}

/** Every row belonging to `client` (an option `value`, see
 * `clientOptionValue`), or every row when `client` is `null` — "All
 * clients". */
function rowsForClient(rows: RequestRow[], client: string | null): RequestRow[] {
  if (client === null) return rows
  return rows.filter((row) => clientOptionValue(row.customerEmail) === client)
}

/**
 * Every *project* among `rows` — deliberately not every row: a row with no
 * `projectId` has no project to be grouped under (see `RequestRow.projectId`'s
 * own doc comment) and contributes no option here, though it still renders
 * under "All projects" (`applyRequestsFilter` below never excludes it except
 * when a specific project is chosen).
 *
 * One option per distinct `projectId`, labelled with whichever row's `title`
 * is encountered first — `rows` is newest-created-first
 * (`listAllRequestRows`'s own `ORDER BY`), so the first sighting of a given
 * project is always its newest submission, and that submission's `title` is
 * already `project?.name ?? titleFromOutcome(...)` — the identical value
 * `projectTitleFromNewest` (`routes/leads.ts`) would derive from the same
 * project and its own newest submission. An *unnamed* project's members can
 * each carry a different derived `title` (every submission derives its own
 * from its own `outcome`), so picking any other member's title here would
 * still be a defensible label, just not the one this codebase's other
 * project-title call sites already converge on.
 *
 * Sorted alphabetically by label, the same reasoning `buildClientOptions`
 * gives for doing the same.
 */
function buildProjectOptions(rows: RequestRow[]): FilterOption[] {
  const seen = new Map<string, FilterOption>()
  for (const row of rows) {
    if (!row.projectId) continue
    if (!seen.has(row.projectId)) {
      seen.set(row.projectId, { value: row.projectId, label: row.title })
    }
  }
  return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label))
}

/** `""`/`null` both mean "All …"; anything else is trimmed and returned
 * verbatim — see `resolveRequestsFilter`'s own doc comment for why `client`
 * stops here (honoured even when it names nobody) while `project` (below)
 * goes on to a second, scoping check. */
function trimmedOrNull(raw: string | null): string | null {
  if (raw === null) return null
  const trimmed = raw.trim()
  return trimmed === "" ? null : trimmed
}

/** `project` only: `null` unless `raw` names one of `options` — see
 * `resolveRequestsFilter`'s own doc comment for why `client` does not go
 * through this same check. */
function validatedProject(options: FilterOption[], raw: string | null): string | null {
  const trimmed = trimmedOrNull(raw)
  if (trimmed === null) return null
  return options.some((option) => option.value === trimmed) ? trimmed : null
}

/**
 * Resolves the raw `?client=`/`?project=` query values into a filter the
 * rest of this route trusts — never the unchecked strings themselves.
 *
 * `client` is honoured verbatim (trimmed, `""`/absent -> `null`, "All
 * clients"), even when it names nobody on `clientOptions` — a stale
 * bookmark, or an address whose last submission was reassigned away. That is
 * deliberate, not an oversight: issue #323 asks for "a sentence naming the
 * filter that produced it" on an empty result, e.g. "No requests for
 * ops@northfield-systems.example" — silently discarding an unrecognised
 * `client` back to "All clients" would make that sentence unreachable
 * (`applyRequestsFilter` would show every row instead of naming the filter
 * that matched none of them), the same "malformed input still gets an
 * honest answer, not a guess at what the caller meant" posture the rest of
 * this file already takes for a submission id that names nothing
 * (`leadsNotFound()`), just answered here with a sentence instead of a 404.
 *
 * `project`, by contrast, IS re-validated — against `client`'s *own* project
 * options, not the unscoped list — because issue #323 states its contract
 * explicitly: picking a client "resets the project selection rather than
 * leaving a now-impossible pair selected". A `?client=`/`?project=` pair
 * from before the operator switched clients (the single `<form>` in
 * `requestsFilterForm` submits both selects together, so changing one still
 * resubmits whatever the other was previously set to) is corrected here —
 * dropped back to "All projects" — rather than compounding into an even
 * less legible empty result ("No requests for A · B" when B was never A's
 * project to begin with).
 */
export function resolveRequestsFilter(
  rows: RequestRow[],
  rawClient: string | null,
  rawProject: string | null,
): RequestsFilter {
  const clientOptions = buildClientOptions(rows)
  const client = trimmedOrNull(rawClient)

  const projectOptions = buildProjectOptions(rowsForClient(rows, client))
  const project = validatedProject(projectOptions, rawProject)

  return { client, project, clientOptions, projectOptions }
}

/** The rows this filter actually selects — `rows` unchanged under "All
 * clients" + "All projects", the current behaviour issue #323 requires as
 * the default. */
export function applyRequestsFilter(rows: RequestRow[], filter: RequestsFilter): RequestRow[] {
  const byClient = rowsForClient(rows, filter.client)
  if (filter.project === null) return byClient
  return byClient.filter((row) => row.projectId === filter.project)
}

function requestsPage(
  operator: Operator,
  allRows: RequestRow[],
  visibleRows: RequestRow[],
  filter: RequestsFilter,
): string {
  return `${operatorTopbar(operator.email, "requests")}
<main>
  <div class="page-head">
    <h1>Requests</h1>
  </div>
  <p class="lede">Every submission the portal holds, across every customer, most recently created first — the operator-wide counterpart to a customer's own <code>/submissions</code>.</p>
  ${allRows.length > 0 ? requestsFilterForm(filter) : ""}
  ${visibleRows.length > 0 ? requestsList(visibleRows) : emptyRequests(filter)}
</main>`
}

/**
 * Issue #323's two dependent `<select>`s, in one plain `GET` form — no
 * script, matching every other control this portal ships (see e.g.
 * `render.ts`'s `accountMenu()` doc comment on the zero-JS disclosure
 * convention this codebase holds to throughout). Submitting reloads
 * `/requests?client=…&project=…`, which is also what makes the current
 * selection survive a reload: the query string *is* the state, read back by
 * `resolveRequestsFilter` above.
 *
 * The Project field renders only when `filter.projectOptions` has more than
 * one entry — the operator's own framing, quoted in the issue: "show it if
 * more than 1". Hiding it (rather than disabling it, or rendering it with
 * one inert option) also means a submit made while it is hidden carries no
 * `project` field at all, which is one more way an impossible pair cannot
 * survive a client change: the moment a client narrows the project options
 * down to one or none, the very next submit drops `project` from the
 * request entirely.
 */
function requestsFilterForm(filter: RequestsFilter): string {
  const clientField = `    <div class="field">
      <label for="requests-filter-client">Client</label>
      <select id="requests-filter-client" name="client" data-testid="requests-filter-client">
        <option value=""${filter.client === null ? " selected" : ""}>All clients</option>
${filter.clientOptions.map((option) => filterOptionTag(option, filter.client)).join("\n")}
      </select>
    </div>`

  const projectField =
    filter.projectOptions.length > 1
      ? `    <div class="field">
      <label for="requests-filter-project">Project</label>
      <select id="requests-filter-project" name="project" data-testid="requests-filter-project">
        <option value=""${filter.project === null ? " selected" : ""}>All projects</option>
${filter.projectOptions.map((option) => filterOptionTag(option, filter.project)).join("\n")}
      </select>
    </div>`
      : ""

  return `  <form class="requests-filter" method="GET" action="/requests" data-testid="requests-filter-form">
${clientField}
${projectField}
    <button type="submit" class="secondary" data-testid="requests-filter-submit">Filter</button>
  </form>`
}

function filterOptionTag(option: FilterOption, selected: string | null): string {
  return `        <option value="${escapeHtml(option.value)}"${option.value === selected ? " selected" : ""}>${escapeHtml(option.label)}</option>`
}

function requestsList(rows: RequestRow[]): string {
  return `<ul class="requests-list" data-testid="requests-list">
${rows.map(requestRow).join("\n")}
  </ul>`
}

/**
 * Mirrors `routes/leads.ts`'s `emptyInbox()` — present instead of the list,
 * never alongside it. Issue #323: once a client and/or project filter is
 * active, this names the filter that produced the empty result ("No
 * requests for …") instead of the bare, filter-blind "Nothing submitted
 * yet." — which is preserved unchanged for the actual zero-submissions
 * case, since `requestsPage` above never renders the filter form (and so
 * never an active filter) when `allRows` is empty.
 */
function emptyRequests(filter: RequestsFilter): string {
  const parts: string[] = []
  if (filter.client !== null) {
    // Falls back to the raw filter value itself when it names no known
    // option — `resolveRequestsFilter` deliberately honours an
    // unrecognised `client` rather than discarding it (see that function's
    // own doc comment), so the sentence still names exactly what the
    // operator filtered by, "the address is the honest label" the same way
    // `clientOptionLabel` already is for a row with none at all.
    const option = filter.clientOptions.find((candidate) => candidate.value === filter.client)
    parts.push(option?.label ?? filter.client)
  }
  if (filter.project !== null) {
    // Unlike `client` above, `project` is always a member of
    // `filter.projectOptions` by construction (`resolveRequestsFilter`
    // validates it) — the fallback here is defensive only.
    const option = filter.projectOptions.find((candidate) => candidate.value === filter.project)
    parts.push(option?.label ?? filter.project)
  }

  const message = parts.length > 0 ? `No requests for ${parts.join(" · ")}.` : "Nothing submitted yet."
  return `<p class="lede" data-testid="requests-list-empty">${escapeHtml(message)}</p>`
}

function requestRow(row: RequestRow): string {
  const href = `/requests/${encodeURIComponent(row.id)}`
  return `    <li>
      <div class="request-row" data-testid="request-row" data-status="${escapeHtml(row.display)}">
        <div class="row-main">
          <a class="title" href="${href}" data-testid="request-title">${escapeHtml(row.title)}</a>
          <span class="meta">
            <span data-testid="request-customer">${escapeHtml(row.customerEmail ?? "no email on file")}</span>
            &middot; <span data-testid="request-reference">${escapeHtml(row.reference)}</span>
            &middot; ${escapeHtml(row.createdAt)}
          </span>
        </div>
        <div class="row-side">
          <span class="status-pill" data-testid="status-pill" data-status="${escapeHtml(row.display)}">${escapeHtml(statusText(row.display))}</span>${roundBadge(row.round)}${surveyBadge(row)}
          <a class="button secondary" href="${href}" data-testid="request-open-link">Open</a>
        </div>
      </div>
    </li>`
}

/**
 * Issue #329: "the rating on the request row" — present only once this
 * submission is `shipped` (the same `submitSurvey` gate that decides whether
 * a response could ever exist, see `RequestRow.survey`'s own doc comment
 * above), and, once shipped, always present — either the rating the customer
 * gave, or an explicit "Not answered" when nobody has. The issue is explicit
 * about why the latter matters: "the point of the view is knowing which
 * customers were unhappy *and* which never said — treating those as the same
 * thing loses the more actionable one." A `roundBadge`-shaped absent string
 * for "no response" would collapse exactly that distinction back into
 * silence, so this never returns `""` for a shipped row the way `roundBadge`
 * does for one with no round.
 */
export function surveyBadge(row: RequestRow): string {
  if (row.display !== "shipped") return ""
  if (!row.survey) {
    return `
          <span class="survey-pill" data-testid="request-survey" data-answered="false">Not answered</span>`
  }
  return `
          <span class="survey-pill" data-testid="request-survey" data-answered="true" data-rating="${row.survey.rating}">${escapeHtml(SURVEY_RATING_LABELS[row.survey.rating])}</span>`
}

/**
 * `VERDICT_TEXT` (`src/rounds.ts`) is documented there as "the
 * customer-visible text" — `pending` reads `"Awaiting your sign-off"`,
 * correct on the customer's own screens (`routes/submission.ts`) where "your"
 * means the customer reading it. Every screen in this file is an operator's,
 * reading about a round awaiting the *customer's* sign-off, not their own —
 * issue #316. Not a change to `VERDICT_TEXT` itself (still shared, still
 * right for the customer view); just the second, operator-facing wording at
 * the two call sites here that used to render it verbatim (`roundBadge`
 * below and `operatorRoundEntry`'s `verdict-pill`). `approved` and
 * `changes-requested` need no second wording — neither says "you" or "your"
 * either way — so they pass `VERDICT_TEXT` through unchanged.
 */
const OPERATOR_VERDICT_TEXT: Record<RoundVerdict, string> = {
  pending: "Awaiting customer sign-off",
  approved: VERDICT_TEXT.approved,
  "changes-requested": VERDICT_TEXT["changes-requested"],
}

/**
 * The newest design round and its verdict, present only for a submission
 * that has at least one — same optional-detail shape `deliveries.ts`'s
 * `deliveryDetail` uses for a row's status-dependent extra.
 */
function roundBadge(round: SignoffState | null): string {
  if (!round) return ""
  return `
          <span class="round-pill" data-testid="request-round" data-verdict="${escapeHtml(round.verdict)}">Round ${round.round} &middot; ${escapeHtml(OPERATOR_VERDICT_TEXT[round.verdict])}</span>`
}

/**
 * `GET /requests/:id` — issue #145. One submission, operator-facing, keyed by
 * the row id `listAllRequestRows` already carries rather than the
 * `SUB-XXXXXX` reference: `getSubmission` (`src/submissions.ts`) is the
 * durable by-id lookup every other write path in this codebase already
 * trusts, and reusing it here means this route needs no query of its own
 * beyond the one call.
 *
 * Started as hosting only the reassignment panel for a submission
 * `/leads/:id` cannot reach (see this file's module comment); issue #318
 * added the second thing this screen now renders — any coord-owned draft
 * queued and not yet sent, beside the round-history link, per that issue's
 * own "beside the round history" placement. It renders just enough to orient
 * an operator who followed the title or "Open" link off the list
 * (`requestRow` above, issue #316: neither is labelled "Reassign" any more —
 * that named the one action available once you arrive, not what clicking
 * through actually does): what it is, whose it is, the panel itself, and now
 * whatever coord is waiting on this operator to release. It is still not a
 * second `/submissions/:id`; there is no message thread or preview link
 * here, and neither should be added without its own issue.
 */
export async function requestDetail(request: Request, env: Env, id: string): Promise<Response> {
  const operator = await readOperator(request, env)
  if (!operator) return leadsNotFound()

  const submission = await getSubmission(env, id)
  if (!submission) return leadsNotFound()

  const display = await displayStatusFor(env, submission)
  const options = await loadReassignmentOptions(env, submission.projectId, submission.customerEmail)
  const drafts = await listPendingOutboundDrafts(env, submission.reference)

  return html(
    page(
      `${submission.reference} — coord-portal`,
      requestDetailPage(operator, submission, display, options, drafts),
    ),
  )
}

/**
 * `POST /requests/:id/reassign` — issue #145's second entry point for #130's
 * mechanic. Same guard shape as `postLeadReassign` (`routes/leads.ts`): an
 * unknown id gets the one operator-surface 404, a malformed or unparseable
 * body gets the same 404 (`isFormContentType`, mirroring
 * `postLeadReassign`'s identical check), and an unrecognised `projectChoice`
 * is a no-op 303 back to the screen — never an error for an operator who did
 * nothing wrong.
 *
 * `applyReassignmentChoice` is the exact function `postLeadReassign` calls —
 * same "existing sibling or a brand-new project, same client only" contract,
 * same idempotency, same event on the bridge. This route supplies
 * `submission.customerEmail` where `postLeadReassign` supplies `lead.email`;
 * every other line is the shared function's, not a second copy of it.
 */
export async function postRequestReassign(request: Request, env: Env, id: string): Promise<Response> {
  const operator = await readOperator(request, env)
  if (!operator) return leadsNotFound()

  const submission = await getSubmission(env, id)
  if (!submission) return leadsNotFound()

  const contentType = request.headers.get("content-type") ?? ""
  if (!isFormContentType(contentType)) return leadsNotFound()

  const form = await parseFormData(request)
  if (!form) return leadsNotFound()

  const options = await loadReassignmentOptions(env, submission.projectId, submission.customerEmail)

  const rawChoice = form.get("projectChoice")
  const choice = typeof rawChoice === "string" ? rawChoice.trim() : ""

  await applyReassignmentChoice(env, submission, options, choice, submission.customerEmail)

  return new Response(null, {
    status: 303,
    headers: { location: `/requests/${encodeURIComponent(submission.id)}` },
  })
}

/**
 * The `<textarea>`/`<input>` `name` a draft's field `key` renders under —
 * `field__` prefixed so it can never collide with the reassignment panel's
 * own `projectChoice`, or with a future field of the same bare name on some
 * other form this same page renders.
 */
function draftFieldName(key: string): string {
  return `field__${key}`
}

/** Redirects back to the detail screen — where every draft action above and below lands, win or no-op. */
function backToRequest(submissionId: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location: `/requests/${encodeURIComponent(submissionId)}` },
  })
}

/**
 * A pending draft this route trusts, or `null` if the id names nothing, is no
 * longer `pending`, or belongs to a different submission than the URL names —
 * the last case matters because `draftId` and the submission `id` in the URL
 * are two independent identifiers with no foreign-key relationship visible to
 * the router; without this check an operator with two tabs open could approve
 * submission A's draft through submission B's form action.
 */
async function draftForSubmission(
  env: Env,
  submission: Submission,
  draftId: string,
): Promise<CoordOutboundDraft | null> {
  const drafts = await listPendingOutboundDrafts(env, submission.reference)
  return drafts.find((draft) => draft.id === draftId) ?? null
}

/**
 * `POST /requests/:id/drafts/:draftId/approve` — issue #318's "Approve &
 * send", applied to a coord-drafted message instead of a portal-drafted
 * reply. Whatever the operator has in the form's text fields — not
 * necessarily what coord originally queued — is what travels back to coord,
 * the same "the edited text, not the original" rule `postReplyApprove`
 * (`src/routes/replies.ts`) already applies to `/replies`.
 *
 * A field the form did not carry (a hand-rolled POST missing one, not
 * anything the rendered form can produce) falls back to the draft's own
 * queued text rather than an empty string — "absent beats broken", the same
 * call `fieldOr` makes on `/replies`.
 *
 * Guarded the same way every write on this operator surface is: an unknown
 * submission gets the indistinguishable 404, and a draft that is missing, not
 * `pending`, or not this submission's own is a guarded no-op — a 303 back to
 * the screen an operator was already looking at, never an error for a
 * double-click or a second tab that lost a race.
 *
 * The decision write and the `outbound_draft.approved` event append are one
 * `env.DB.batch()`, not two separately-awaited round trips — the same
 * all-or-nothing pairing `confirmRelayedAnswer` (`src/questions.ts`)
 * establishes for exactly this situation. Both statements share the identical
 * `WHERE …state = 'pending'` guard, evaluated atomically inside the batch's
 * own transaction: either the draft is still pending, in which case both the
 * event lands and the state flips, or it is not, in which case neither
 * happens. A transient D1 error or a mid-flight interruption can no longer
 * leave a decided draft with no event ever announcing it — the failure mode
 * that made the verdict unrecoverable and the message coord was waiting to
 * send never go out.
 */
export async function postRequestDraftApprove(
  request: Request,
  env: Env,
  id: string,
  draftId: string,
): Promise<Response> {
  const operator = await readOperator(request, env)
  if (!operator) return leadsNotFound()

  const submission = await getSubmission(env, id)
  if (!submission) return leadsNotFound()

  const contentType = request.headers.get("content-type") ?? ""
  if (!isFormContentType(contentType)) return leadsNotFound()
  const form = await parseFormData(request)
  if (!form) return leadsNotFound()

  const pending = await draftForSubmission(env, submission, draftId)
  if (pending === null) return backToRequest(submission.id)

  const editedFields: Record<string, string> = {}
  for (const key of Object.keys(pending.fields)) {
    const raw = form.get(draftFieldName(key))
    editedFields[key] = typeof raw === "string" ? raw : (pending.fields[key] ?? "")
  }

  await env.DB.batch([
    appendEventStatement(
      env,
      {
        type: "outbound_draft.approved",
        submissionReference: pending.submissionReference,
        occurredAt: new Date().toISOString(),
        payload: { draft_id: pending.id, kind: pending.kind, fields: editedFields },
      },
      {
        clause: `WHERE EXISTS (SELECT 1 FROM coord_outbound_drafts WHERE id = ? AND state = 'pending')`,
        bindings: [draftId],
      },
    ),
    approveOutboundDraftStatement(env, draftId, editedFields, operator.email),
  ])

  return backToRequest(submission.id)
}

/**
 * `POST /requests/:id/drafts/:draftId/reject` — issue #318's "Reject". Same
 * guard shape as approve above; no form fields are read beyond the same
 * content-type check every write on this surface applies, matching
 * `postReplyDiscard`'s own "carries nothing but its button" convention.
 *
 * Same batched, co-guarded decision-plus-event pairing as
 * `postRequestDraftApprove` above, for the identical reason: a rejection that
 * committed with no `outbound_draft.rejected` event ever reaching coord would
 * leave coord waiting on a draft the portal already considers closed.
 */
export async function postRequestDraftReject(
  request: Request,
  env: Env,
  id: string,
  draftId: string,
): Promise<Response> {
  const operator = await readOperator(request, env)
  if (!operator) return leadsNotFound()

  const submission = await getSubmission(env, id)
  if (!submission) return leadsNotFound()

  const contentType = request.headers.get("content-type") ?? ""
  if (!isFormContentType(contentType)) return leadsNotFound()
  if ((await parseFormData(request)) === null) return leadsNotFound()

  const pending = await draftForSubmission(env, submission, draftId)
  if (pending === null) return backToRequest(submission.id)

  await env.DB.batch([
    appendEventStatement(
      env,
      {
        type: "outbound_draft.rejected",
        submissionReference: pending.submissionReference,
        occurredAt: new Date().toISOString(),
        payload: { draft_id: pending.id, kind: pending.kind },
      },
      {
        clause: `WHERE EXISTS (SELECT 1 FROM coord_outbound_drafts WHERE id = ? AND state = 'pending')`,
        bindings: [draftId],
      },
    ),
    rejectOutboundDraftStatement(env, draftId, operator.email),
  ])

  return backToRequest(submission.id)
}

/**
 * The same derivation `listAllRequestRows` applies per row, for the one
 * submission this detail screen renders — `getCurrentRound`/`getStartWork`
 * rather than the list's batched `loadSignoffStates`/`loadStartWorkStates`:
 * a single-submission lookup has no D1 bound-parameter ceiling to dodge (see
 * `src/d1.ts`), so there is no reason to route it through the batch helpers
 * built for a table-wide scan.
 */
async function displayStatusFor(env: Env, submission: Submission): Promise<SubmissionStatus> {
  // Fetched unconditionally, same as `listAllRequestRows`'s own
  // `loadSignoffStates` call: an operator benefits from seeing round history
  // on a submission that has since moved past sign-off too, not only the one
  // status where it changes the derived value.
  const round = await getCurrentRound(env, submission.reference)
  const startWork =
    submission.status === "describing" ? await getStartWork(env, submission.reference) : null
  return deriveDisplayStatus(
    submission.status,
    round ? { round: round.round, verdict: round.verdict } : null,
    startWork,
  )
}

function requestDetailPage(
  operator: Operator,
  submission: Submission,
  display: SubmissionStatus,
  options: ReassignmentOptions,
  drafts: CoordOutboundDraft[],
): string {
  return `${operatorTopbar(operator.email, "requests")}
<main data-testid="request-detail">
  <a class="back-link" href="/requests" data-testid="back-to-requests">&larr; Requests</a>

  <span class="status-pill" data-testid="status-pill" data-status="${escapeHtml(display)}">${escapeHtml(statusText(display))}</span>
  <h1 data-testid="request-detail-title">${escapeHtml(titleOf(submission))}</h1>
  <p class="meta" data-testid="request-detail-reference">${escapeHtml(submission.reference)}</p>

  <dl class="card">
    <dt>Customer</dt>
    <dd data-testid="request-detail-customer">${escapeHtml(submission.customerEmail ?? "no email on file")}</dd>
  </dl>

  ${outboundDraftsSection(submission, drafts)}

  <p class="round-history-aside">
    <a href="/requests/${encodeURIComponent(submission.id)}/rounds" data-testid="request-rounds-link">
      See design rounds &amp; mock bundles
    </a>
  </p>

  ${reassignPanel(`/requests/${encodeURIComponent(submission.id)}/reassign`, options)}
</main>`
}

/* ─────────────────── issue #318: coord's queued drafts ─────────────────── */

/** What an operator reads for each kind of coord-owned draft — never a raw wire slug. */
const DRAFT_KIND_LABEL: Record<CoordOutboundDraftKind, string> = {
  design_round: "Design round",
  question: "Question",
  relayed_answer: "Relayed answer",
  status: "Status change",
  preview: "Preview link",
}

/**
 * The field(s) a given kind's fields are expected to carry, in render order,
 * with the label an operator reads over each one. Any field on the draft not
 * named here still renders — see `draftFieldLabel` — so a wire shape this
 * deploy has not caught up with is still visible and editable, just under its
 * own raw name rather than a curated one.
 */
const DRAFT_FIELD_LABELS: Record<string, string> = {
  outcome_definition: "Outcome definition",
  question: "Question",
  answer: "Relayed answer",
  status: "Status",
  preview_url: "Preview link",
}

function draftFieldLabel(key: string): string {
  return DRAFT_FIELD_LABELS[key] ?? key
}

/**
 * What approving actually causes — issue #318's own requirement, stated on
 * the screen rather than assumed: "an operator can tell 'this reaches her
 * inbox' from 'this only changes what the portal shows'".
 *
 * `status` is the one *kind* of coord-owned push that can email the customer
 * at all, but not every `status` value does — `sendTypeForStatus`
 * (`src/notifications.ts`, its own `TYPE_FOR_STATUS` map) sends only for
 * `awaiting-signoff`, `needs-input`, `shipped` and `quality-check`; the other
 * five statuses in the vocabulary (`describing`, `in-design`, `planned`,
 * `in-progress`, `on-hold`) never call `recordNotificationForStatus` at all.
 * Gating this text on `kind === "status"` alone would tell an operator
 * approving an `in-progress` draft that it reaches the customer's inbox when
 * it does not — exactly backwards from what this screen exists to say. So
 * this checks the actual `status` field's send type, not just the kind.
 */
export function draftConsequence(draft: CoordOutboundDraft): string {
  const emails = draft.kind === "status" && sendTypeForStatus(draft.fields.status ?? "") !== null
  return emails
    ? "Approving this emails the customer — the only kind of coord message that does."
    : "Approving this only changes what the portal shows. No email is sent."
}

/**
 * Absent entirely when nothing is queued — the ordinary steady state, the
 * same "present iff there is something to say" convention `roundBadge` and
 * `/replies`' own empty state already use on this codebase's operator
 * screens.
 */
function outboundDraftsSection(submission: Submission, drafts: CoordOutboundDraft[]): string {
  if (drafts.length === 0) return ""
  return `
  <div data-testid="outbound-drafts">
${drafts.map((draft) => outboundDraftCard(submission, draft)).join("\n")}
  </div>`
}

function outboundDraftCard(submission: Submission, draft: CoordOutboundDraft): string {
  const action = `/requests/${encodeURIComponent(submission.id)}/drafts/${encodeURIComponent(draft.id)}`
  const fields = Object.entries(draft.fields)
    .map(([key, value]) => draftField(draft.id, key, value))
    .join("\n")

  return `    <section class="card" data-testid="outbound-draft" data-draft-kind="${escapeHtml(draft.kind)}">
      <h2 data-testid="outbound-draft-kind">${escapeHtml(DRAFT_KIND_LABEL[draft.kind])}</h2>
      <p class="meta">
        <span data-testid="outbound-draft-submission">${escapeHtml(submission.reference)}</span> &middot;
        queued <span data-testid="outbound-draft-queued-at">${escapeHtml(draft.queuedAt)}</span>
      </p>
      <p class="draft-consequence" data-testid="outbound-draft-consequence">${escapeHtml(draftConsequence(draft))}</p>
      <form method="POST" action="${action}/approve" data-testid="outbound-draft-approve-form">
${fields}
        <div class="actions">
          <button type="submit" class="primary" data-testid="outbound-draft-approve-button">Approve &amp; send</button>
        </div>
      </form>
      <form method="POST" action="${action}/reject" data-testid="outbound-draft-reject-form">
        <div class="actions">
          <button type="submit" class="ghost" data-testid="outbound-draft-reject-button">Reject</button>
        </div>
      </form>
    </section>`
}

function draftField(draftId: string, key: string, value: string): string {
  const fieldId = `draft-${draftId}-${key}`
  return `        <div class="field">
          <label for="${escapeHtml(fieldId)}">${escapeHtml(draftFieldLabel(key))}</label>
          <textarea id="${escapeHtml(fieldId)}" name="${escapeHtml(draftFieldName(key))}" rows="6" data-testid="outbound-draft-field" data-field-key="${escapeHtml(key)}">${escapeHtml(value)}</textarea>
        </div>`
}

/* ─────────────────────── the operator round read (#304) ────────────────── */

/**
 * `GET /requests/:id/rounds` — issue #304's operator-scoped read of a
 * submission's design-round history: the same `design_rounds`/`signoffs`
 * state `routes/submission.ts`'s `submissionRounds` renders for the customer,
 * plus each round's decision timestamp (which the customer's own round
 * history does not show — see `operatorRoundEntry`) and a link to each
 * round's own published bundle (which the customer's own round history does
 * not link either — only the *current* round does, from the sign-off screen).
 * An operator reviewing history has no "current round" to stand on; every
 * round here needs its own way in.
 *
 * Same guard shape as `requestDetail` just above: `readOperator` first, then
 * `getSubmission`, both refusing with the one indistinguishable
 * `leadsNotFound()` this whole surface uses. A submission with no rounds yet
 * renders the same empty state `routes/submission.ts`'s `roundHistory` does —
 * "No design round has been published for this request yet" — never an
 * error.
 *
 * Recorded via `recordOperatorRead` with `round: null` — this reads the whole
 * history, not one round's bundle; see `src/operatorAccess.ts`.
 */
export async function requestRounds(request: Request, env: Env, id: string): Promise<Response> {
  const operator = await readOperator(request, env)
  if (!operator) return leadsNotFound()

  const submission = await getSubmission(env, id)
  if (!submission) return leadsNotFound()

  const rounds = await listRounds(env, submission.reference)
  await recordOperatorRead(env, operator.email, submission.reference, null)

  return html(
    page(
      `Round history — ${submission.reference} — coord-portal`,
      operatorRoundHistoryPage(operator, submission, rounds),
    ),
  )
}

function operatorRoundHistoryPage(
  operator: Operator,
  submission: Submission,
  rounds: DesignRound[],
): string {
  const body =
    rounds.length > 0
      ? rounds.map((round) => operatorRoundEntry(submission, round)).join("\n")
      : `    <p class="lede">No design round has been published for this request yet.</p>`

  return `${operatorTopbar(operator.email, "requests")}
<main>
  <a class="back-link" href="/requests/${encodeURIComponent(submission.id)}" data-testid="back-to-request">&larr; ${escapeHtml(titleOf(submission))}</a>
  <h1>Round history</h1>
  <p class="meta" data-testid="request-detail-reference">${escapeHtml(submission.reference)}</p>

  ${operatorAccessNotice(submission)}

  <div data-testid="round-history">
${body}
  </div>
</main>`
}

/**
 * "Clearly marked as operator access to customer material, not a customer
 * view" — issue #304's own acceptance line, made literal. Rendered once per
 * page, ahead of the round list itself, so it is the first thing an operator
 * reads here, not a footnote.
 */
function operatorAccessNotice(submission: Submission): string {
  return `<p class="operator-access-notice" data-testid="operator-access-notice" role="note">
    You are viewing ${escapeHtml(submission.customerEmail ?? "this customer")}'s design rounds and
    published mocks as an operator. This is their material, not yours — the read is recorded.
  </p>`
}

/**
 * One round, operator-facing — the same facts `routes/submission.ts`'s
 * `roundEntry` renders for the customer (badge, verdict, opened date, outcome
 * definition, decomposition and, on a `changes-requested` round, the
 * customer's own comment), plus the two things only an operator's screen
 * needs:
 *
 *   `round-decided-at`   the customer's own `decidedAt` — absent on a still-
 *                        `pending` round, the same way `round-comment` is
 *                        absent on an `approved` one. The customer's own
 *                        round history never shows this (their own copy
 *                        already says "opened <date>", and they were there
 *                        when they decided); an operator reviewing a verdict
 *                        after the fact needs to know when, not just what.
 *   `operator-mock-bundle-link`
 *                        every round's own published bundle, via
 *                        `operatorMockBundleHref` below — not only the
 *                        current round's, the way the customer's sign-off
 *                        screen links just one. An operator reviewing
 *                        history has no "current round" to stand on; each
 *                        entry needs its own way into what was actually
 *                        shown.
 *
 * Deliberately its own function rather than an extra parameter threaded onto
 * `routes/submission.ts`'s exported `roundEntry` — that function is called
 * positionally as `.map(roundEntry)` from two customer-facing call sites
 * (`submission.ts` itself and `routes/project.ts`); giving it a second,
 * operator-only parameter would mean either call site accidentally passing
 * `Array.prototype.map`'s own index/array arguments through it, which is
 * exactly the "two copies drifting" failure mode `roundEntry`'s own export
 * comment warns against, applied to itself.
 */
function operatorRoundEntry(submission: Submission, round: DesignRound): string {
  const items = round.decomposition.map((item) => `        <li>${escapeHtml(item)}</li>`).join("\n")
  const decomposition = round.decomposition.length
    ? `      <ul class="decomposition-list">
${items}
      </ul>`
    : ""

  // Only rounds where changes were requested carry a comment — approving asks
  // for none, and a pending round has not been answered yet. Same rule
  // `routes/submission.ts`'s `roundEntry` applies, and the same reason its own
  // comment gives for keeping the customer's words free of decorative
  // quotation marks in the DOM.
  const comment =
    round.verdict === "changes-requested" && round.comment
      ? `      <blockquote data-testid="round-comment">${escapeHtml(round.comment)}</blockquote>`
      : ""

  const decidedAt = round.decidedAt
    ? `      <p class="round-decided-at" data-testid="round-decided-at">Decided ${escapeHtml(round.decidedAt)}</p>`
    : ""

  const href = operatorMockBundleHref(submission, round)
  const bundleLink = href
    ? `      <a class="mock-bundle-link" href="${escapeHtml(href)}" data-testid="operator-mock-bundle-link"
         aria-label="Open the published mock bundle for round ${round.round}">
        View the mock bundle &rarr;
      </a>`
    : ""

  return `    <section class="round-entry" data-testid="round-entry" data-round="${round.round}" data-verdict="${escapeHtml(round.verdict)}">
      <div class="round-entry-head">
        <span class="round-badge">Round ${round.round}</span>
        <span class="verdict-pill" data-testid="verdict-pill" data-verdict="${escapeHtml(round.verdict)}">${escapeHtml(OPERATOR_VERDICT_TEXT[round.verdict])}</span>
        <span class="round-date">opened ${escapeHtml(round.openedAt)}</span>
      </div>
      <p class="outcome-definition">${escapeHtml(round.outcomeDefinition)}</p>
${decomposition}
${comment}
${decidedAt}
${bundleLink}
    </section>`
}

/**
 * `mockBundleHref` (`routes/submission.ts`) for the operator route instead of
 * the customer one — same two shapes (an absolute URL or root-relative path
 * used verbatim; anything else treated as an R2 key and routed back through
 * this portal), same "no identifier in the link text" reasoning, only the R2
 * read path swapped for `routes/mocks.ts`'s `operatorMockBundle`
 * (`/requests/:id/rounds/:n/mock`) instead of the customer's `mockBundle`
 * (`/submissions/:id/rounds/:n/mock`) — a link built from the customer path
 * would 404 for an operator by construction, the same way `promotedReference`
 * (`routes/leads.ts`) never links a `/submissions/:id` an operator cannot open.
 */
function operatorMockBundleHref(submission: Submission, round: DesignRound): string | null {
  const bundle = round.mockBundle?.trim()
  if (!bundle) return null
  if (/^https?:\/\//i.test(bundle) || bundle.startsWith("/")) return bundle
  return `/requests/${submission.id}/rounds/${round.round}/mock`
}
