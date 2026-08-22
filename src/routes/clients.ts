import { getClientProfileById, listClients, type Client, type ClientSummary } from "../clients"
import { readOperator, type Operator } from "../operators"
import { listProjectsForClient, type Project } from "../projects"
import { escapeHtml, html, operatorTopbar, page } from "../render"
import { derivedStatus, getCurrentRound, type DesignRound } from "../rounds"
import {
  customerFacingStatus,
  listSubmissionsForProjectUnscoped,
  statusText,
  titleOf,
  type Submission,
} from "../submissions"
import type { Env } from "../types"
import { leadsNotFound } from "./leads"

/**
 * `GET /clients` and `GET /clients/:id` — issue #144. The portal has had
 * `clients` (#128) and `projects` (#109) since the previous milestone, and
 * lead promotion (#129) has been creating and linking both automatically —
 * but nothing renders either one. The two questions an operator actually
 * asks, "who are my customers" and "what projects does this customer have",
 * could previously only be answered by querying D1 by hand.
 *
 * ── SHAPE: THE SAME ONE `/deliveries` USES (issue #55) ──────────────────────
 * A separate operator route, its own template, gated on `readOperator()`,
 * reading every row — not a widened branch inside the customer-scoped
 * `/projects/:id` (`routes/project.ts`), which issue #104 already forbids
 * doing to `/submissions` and which would not even work here: that route is
 * ownership-scoped to the caller's own `customerEmail`, so an operator
 * opening a customer's project through it would see nothing. Same
 * `readOperator` gate, same indistinguishable 404 (`leadsNotFound()`) for
 * anyone it rejects, same `operatorTopbar()` rather than the merged customer
 * `topbar()` — see `src/operators.ts` and `src/render.ts` for why.
 *
 * ── NO NAME COLUMN ────────────────────────────────────────────────────────
 * The issue asks for "display name (or email if unnamed)". `clients` (0016)
 * has no `name` column, so every client is "unnamed" today — `displayName`
 * (`src/clients.ts`) is always `email`. That is a schema gap for a future
 * issue to close, not something this route can invent a value for.
 *
 * ── READ-ONLY ─────────────────────────────────────────────────────────────
 * Both routes are GET only, same as `/projects/:id`: a client and a project
 * are both facts derived from the submissions and lead promotions that
 * created them, with nothing on this screen for an operator to write.
 */

const CLIENTS_PATH = "/clients"
const CLIENT_PATH = /^\/clients\/([^/?#]+)$/

/** What `handlePages` needs to know about a `/clients…` URL, or `null`. */
export function matchClientsPath(
  pathname: string,
): { kind: "index" } | { kind: "detail"; id: string } | null {
  if (pathname === CLIENTS_PATH) return { kind: "index" }

  const detail = pathname.match(CLIENT_PATH)
  if (detail?.[1]) return { kind: "detail", id: detail[1] }

  return null
}

/** GET /clients — every client, newest-created first. */
export async function clientsIndex(request: Request, env: Env): Promise<Response> {
  const operator = await readOperator(request, env)
  if (!operator) return leadsNotFound()

  const clients = await listClients(env)
  return html(page("Clients — coord-portal", clientsIndexPage(operator, clients)))
}

function clientsIndexPage(operator: Operator, clients: ClientSummary[]): string {
  return `${operatorTopbar(operator.email, "clients")}
<main>
  <div class="page-head">
    <h1>Clients</h1>
  </div>
  <p class="lede">Every customer with a client record, most recently added first.</p>
  ${clients.length > 0 ? clientsList(clients) : emptyClients()}
</main>`
}

function clientsList(clients: ClientSummary[]): string {
  return `<ul class="leads-list" data-testid="clients-list">
${clients.map(clientRow).join("\n")}
  </ul>`
}

function clientRow(client: ClientSummary): string {
  const projectLabel = client.projectCount === 1 ? "1 project" : `${client.projectCount} projects`
  const submissionLabel =
    client.submissionCount === 1 ? "1 submission" : `${client.submissionCount} submissions`

  return `    <li>
      <div class="lead-row client-row" data-testid="client-row">
        <div class="row-main">
          <span class="summary" data-testid="client-name">${escapeHtml(client.displayName)}</span>
          <span class="meta">
            <span data-testid="client-email">${escapeHtml(client.email)}</span>
            &middot; <span data-testid="client-project-count">${escapeHtml(projectLabel)}</span>
            &middot; <span data-testid="client-submission-count">${escapeHtml(submissionLabel)}</span>
          </span>
        </div>
        <div class="row-side">
          <span class="meta" data-testid="client-last-activity">last activity ${escapeHtml(client.lastActivityAt)}</span>
          <a class="button secondary" href="/clients/${encodeURIComponent(client.id)}" data-testid="view-client">View</a>
        </div>
      </div>
    </li>`
}

/**
 * Present instead of `clients-list`, never alongside it — same convention as
 * `emptyInbox()` (`routes/leads.ts`) and `emptyDeliveries()`
 * (`routes/deliveries.ts`): the empty state the issue asks for, "for a
 * portal with no clients yet".
 */
function emptyClients(): string {
  return `<p class="lede" data-testid="clients-list-empty">
    No clients yet — promote a lead or have a customer save their profile to create one.
  </p>`
}

/** GET /clients/:id — one client, every project they have, and each project's submissions. */
export async function clientDetail(request: Request, env: Env, id: string): Promise<Response> {
  const operator = await readOperator(request, env)
  if (!operator) return leadsNotFound()

  const client = await getClientProfileById(env, id)
  // Same indistinguishable-404 posture as everywhere else on this surface —
  // an id that does not exist and a non-operator caller read identically.
  if (!client) return leadsNotFound()

  const projects = await listProjectsForClient(env, id)
  const projectBlocks: string[] = []
  for (const project of projects) {
    // One `listSubmissionsForProjectUnscoped` + one `getCurrentRound` per
    // submission — the same per-member D1 round-trip budget
    // `routes/project.ts`'s own combined view accepts for the identical
    // reason: a project groups few enough submissions, each a deliberate,
    // human-initiated follow-up, that this never scales with the whole table.
    const submissions = await listSubmissionsForProjectUnscoped(env, project.id)
    const rows = await Promise.all(submissions.map((submission) => submissionRow(env, submission)))
    projectBlocks.push(projectBlock(project, submissions, rows))
  }

  return html(
    page(`${client.email} — coord-portal`, clientDetailPage(operator, client, projectBlocks)),
  )
}

function clientDetailPage(operator: Operator, client: Client, projectBlocks: string[]): string {
  return `${operatorTopbar(operator.email, "clients")}
<main data-testid="client-detail">
  <a class="back-link" href="/clients" data-testid="back-to-clients">&larr; Clients</a>

  <h1 data-testid="client-detail-email">${escapeHtml(client.email)}</h1>
  <p class="meta">client since ${escapeHtml(client.createdAt)}</p>

  <dl class="card">
    <dt>Contact email</dt>
    <dd data-testid="client-detail-contact-email">${escapeHtml(client.email)}</dd>
    ${optionalField("Phone", "client-detail-phone", client.phone)}
    ${optionalField("CC emails", "client-detail-cc-emails", client.ccEmails)}
    ${optionalField("Address", "client-detail-address", client.address)}
  </dl>

  <h2>Projects</h2>
  ${projectBlocks.length > 0 ? projectBlocks.join("\n") : emptyProjects()}
</main>`
}

/** One `<dt>`/`<dd>` pair, or nothing — mirrors `routes/account.ts`'s own
 * treatment of these same three nullable columns: a value nobody has saved
 * yet is omitted, not rendered as an empty field. */
function optionalField(label: string, testId: string, value: string | null): string {
  if (!value) return ""
  return `<dt>${escapeHtml(label)}</dt><dd data-testid="${testId}">${escapeHtml(value)}</dd>`
}

function emptyProjects(): string {
  return `<p class="lede" data-testid="client-projects-empty">This client has no projects yet.</p>`
}

/**
 * One `client-project` card — title derived from its newest submission, the
 * same rule `projectTitle()` in `routes/leads.ts` uses for the reassignment
 * panel (`getNewestSubmissionForProject` there; here the newest submission is
 * already in hand from `submissions[0]`, since `listSubmissionsForProjectUnscoped`
 * orders newest-first, so there is nothing to fetch twice).
 */
function projectBlock(project: Project, submissions: Submission[], rows: string[]): string {
  const title = submissions[0] ? titleOf(submissions[0]) : "Untitled project"
  const list =
    rows.length > 0
      ? `<ul class="submission-list">\n${rows.join("\n")}\n      </ul>`
      : `<p class="lede">No submissions under this project yet.</p>`

  return `    <section class="card" data-testid="client-project">
      <div class="round-entry-head">
        <h3 data-testid="client-project-title">${escapeHtml(title)}</h3>
        <span class="round-date" data-testid="client-project-created-at">started ${escapeHtml(project.createdAt)}</span>
      </div>
      ${list}
    </section>`
}

/**
 * One submission's reference, current (derived, customer-facing) status and
 * current round number — the same derivation `routes/project.ts` uses for
 * its own combined timeline, narrowed to the one round that is "current"
 * rather than the full history: this screen answers "what is this customer's
 * work, and which project is it in", not a second `/submissions/:id/rounds`.
 */
async function submissionRow(env: Env, submission: Submission): Promise<string> {
  const round: DesignRound | null = await getCurrentRound(env, submission.reference)
  const display =
    submission.status === "awaiting-signoff"
      ? customerFacingStatus(
          derivedStatus(submission.status, round ? { round: round.round, verdict: round.verdict } : null),
        )
      : customerFacingStatus(submission.status)
  const roundLabel = round ? `Round ${round.round}` : "No rounds yet"

  return `        <li>
          <div class="submission-row" data-testid="client-project-submission">
            <div class="row-main">
              <span class="title" data-testid="client-submission-reference">${escapeHtml(submission.reference)}</span>
              <span class="meta" data-testid="client-submission-round">${escapeHtml(roundLabel)}</span>
            </div>
            <span class="status-pill" data-testid="client-submission-status" data-status="${escapeHtml(display)}">${escapeHtml(statusText(display))}</span>
          </div>
        </li>`
}
