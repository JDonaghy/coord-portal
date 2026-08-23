import {
  ClientMergeError,
  getClientById,
  getClientProfileById,
  getClientRecordByEmail,
  listClients,
  listMergedClients,
  mergeClients,
  type Client,
  type ClientRecord,
  type ClientSummary,
  type MergedClient,
} from "../clients"
import { parseFormData } from "../formData"
import { readOperator, type Operator } from "../operators"
import { getProject, listProjectsForClient, renameProject, type Project } from "../projects"
import { escapeHtml, html, operatorTopbar, page } from "../render"
import { derivedStatus, getCurrentRound, type DesignRound } from "../rounds"
import {
  customerFacingStatus,
  listSubmissionsForProjectUnscoped,
  statusText,
  type Submission,
} from "../submissions"
import type { Env } from "../types"
import { leadsNotFound, projectTitleFromNewest, renameProjectPanel } from "./leads"
import { isFormContentType } from "./submission"

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
 * ── READ-ONLY, EXCEPT TWO WRITES (issues #150, #156) ─────────────────────────
 * `/clients` and `GET /clients/:id` are still pure reads, same as
 * `/projects/:id` — a client and a project are both facts derived from the
 * submissions and lead promotions that created them. `POST /clients/:id
 * /merge` is one write this file owns: "two addresses, one person" (#150)
 * — an operator's only way, until this issue, to say two `clients` rows are
 * the same relationship was to edit D1 by hand. See `mergeClients`
 * (`src/clients.ts`) for the actual write and everything it deliberately does
 * *not* touch (`submissions.customer_email`, `projects.customer_email`,
 * `isOwnedBy` — this is operator-side grouping only, never customer-side
 * visibility).
 *
 * ── THE SECOND WRITE, AND WHY IT LIVES HERE TOO (issue #156) ────────────────
 * `POST /clients/:clientId/projects/:projectId/rename` names or renames one
 * of this client's projects directly, by the project's own id — the
 * project-keyed counterpart to `routes/leads.ts`'s lead-keyed
 * `POST /leads/:id/project/rename` (#149). It exists because that route is
 * unreachable for two cases this screen is the only way to fix: a project
 * behind a submission that came straight through `/intake` and never passed
 * through lead promotion at all (no `/leads/:id` for it, ever), and simply
 * the operator already looking at this project's own card and wanting to
 * rename it without first finding which lead, if any, minted it. Same
 * `renameProjectPanel` markup #149 already shipped (`routes/leads.ts`,
 * `rename-project-*` `data-testid` hooks unchanged), same `renameProject`
 * write (`src/projects.ts`) — only the action URL and the lookup that finds
 * the project are new. See `postClientProjectRename` below for the ownership
 * check that keeps a `projectId` scoped to the `clientId` in its own URL.
 */

const CLIENTS_PATH = "/clients"
const CLIENT_PATH = /^\/clients\/([^/?#]+)$/
const CLIENT_MERGE_PATH = /^\/clients\/([^/?#]+)\/merge$/
const CLIENT_PROJECT_RENAME_PATH = /^\/clients\/([^/?#]+)\/projects\/([^/?#]+)\/rename$/

/** What `handlePages` needs to know about a `/clients…` URL, or `null`. */
export function matchClientsPath(
  pathname: string,
):
  | { kind: "index" }
  | { kind: "detail"; id: string }
  | { kind: "merge"; id: string }
  | { kind: "rename-project"; clientId: string; projectId: string }
  | null {
  if (pathname === CLIENTS_PATH) return { kind: "index" }

  const merge = pathname.match(CLIENT_MERGE_PATH)
  if (merge?.[1]) return { kind: "merge", id: merge[1] }

  // Anchored end and no `/` inside either capture group, so this never
  // shadows the bare `CLIENT_PATH` below — a plain `/clients/:id` has
  // nowhere for a second segment to hide.
  const renameProjectMatch = pathname.match(CLIENT_PROJECT_RENAME_PATH)
  if (renameProjectMatch?.[1] && renameProjectMatch?.[2]) {
    return { kind: "rename-project", clientId: renameProjectMatch[1], projectId: renameProjectMatch[2] }
  }

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
          ${mergedIntoBadge(client.mergedIntoEmail)}
        </div>
        <div class="row-side">
          <span class="meta" data-testid="client-last-activity">last activity ${escapeHtml(client.lastActivityAt)}</span>
          <a class="button secondary" href="/clients/${encodeURIComponent(client.id)}" data-testid="view-client">View</a>
        </div>
      </div>
    </li>`
}

/**
 * Issue #150 — "the merge is visible after the fact": a merged-away client
 * stays on `/clients` (its counts fall to zero on their own, since the join
 * this list already runs no longer finds any project pointing at it — see
 * `listClients`'s own doc comment), badged rather than hidden, so an operator
 * scanning the list is not left wondering where a row went.
 */
function mergedIntoBadge(mergedIntoEmail: string | null): string {
  if (!mergedIntoEmail) return ""
  return `<span class="status-pill" data-testid="client-merged-badge" data-status="merged">Merged into ${escapeHtml(mergedIntoEmail)}</span>`
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

/**
 * Everything `clientDetailPage` needs, gathered once so both the plain `GET`
 * and the merge form's failure re-render (`postClientMerge` below) build the
 * identical page from the identical read — never a stale copy of `client`
 * left over from before a merge that just changed it.
 */
interface ClientDetailContext {
  client: Client
  projectBlocks: string[]
  /** Issue #150 — every client folded into this one, for the "merged
   * clients" section on a surviving client's own page. Always empty for a
   * client that was itself merged away — a merge chain is not a case this
   * issue's contract describes (see `mergeClients`'s own doc comment). */
  mergedAway: MergedClient[]
  /** The row `client.mergedInto` names, or `null` — only set when `client`
   * was itself merged away, for `mergedBanner`'s link back to the survivor. */
  survivor: ClientRecord | null
}

async function loadClientDetailContext(env: Env, id: string): Promise<ClientDetailContext | null> {
  const client = await getClientProfileById(env, id)
  // Same indistinguishable-404 posture as everywhere else on this surface —
  // an id that does not exist and a non-operator caller read identically.
  if (!client) return null

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
    projectBlocks.push(projectBlock(id, project, submissions, rows))
  }

  const [mergedAway, survivor] = await Promise.all([
    listMergedClients(env, id),
    client.mergedInto ? getClientById(env, client.mergedInto) : Promise.resolve(null),
  ])

  return { client, projectBlocks, mergedAway, survivor }
}

/** GET /clients/:id — one client, every project they have, and each project's submissions. */
export async function clientDetail(request: Request, env: Env, id: string): Promise<Response> {
  const operator = await readOperator(request, env)
  if (!operator) return leadsNotFound()

  const context = await loadClientDetailContext(env, id)
  if (!context) return leadsNotFound()

  return html(page(`${context.client.email} — coord-portal`, clientDetailPage(operator, context, null)))
}

function clientDetailPage(
  operator: Operator,
  context: ClientDetailContext,
  mergeError: string | null,
): string {
  const { client, projectBlocks, mergedAway, survivor } = context
  return `${operatorTopbar(operator.email, "clients")}
<main data-testid="client-detail">
  <a class="back-link" href="/clients" data-testid="back-to-clients">&larr; Clients</a>

  <h1 data-testid="client-detail-email">${escapeHtml(client.email)}</h1>
  <p class="meta">client since ${escapeHtml(client.createdAt)}</p>

  ${client.mergedInto ? mergedBanner(survivor) : ""}

  <dl class="card">
    <dt>Contact email</dt>
    <dd data-testid="client-detail-contact-email">${escapeHtml(client.email)}</dd>
    ${optionalField("Phone", "client-detail-phone", client.phone)}
    ${optionalField("CC emails", "client-detail-cc-emails", client.ccEmails)}
    ${optionalField("Address", "client-detail-address", client.address)}
  </dl>

  ${mergedAway.length > 0 ? mergedFromSection(mergedAway) : ""}
  ${client.mergedInto ? "" : mergeForm(client, mergeError)}

  <h2>Projects</h2>
  ${projectBlocks.length > 0 ? projectBlocks.join("\n") : emptyProjects()}
</main>`
}

/**
 * Issue #150 — shown on a merged-away client's own page instead of the merge
 * form (there is nothing left here to merge again — see `mergeClients`'s
 * "chains" reasoning), pointing an operator who lands here straight at the
 * row that now actually owns everything.
 */
function mergedBanner(survivor: ClientRecord | null): string {
  if (!survivor) {
    // Defensive only: `merged_into` is stamped in the same batch that
    // creates the survivor's own row link, and neither is ever deleted — see
    // `mergeClients` in `src/clients.ts`.
    return `<p class="lede" data-testid="client-merged-banner">This client was merged into another client.</p>`
  }
  return `<p class="lede" data-testid="client-merged-banner">
    This client was merged into
    <a href="/clients/${encodeURIComponent(survivor.id)}" data-testid="client-merged-into-link">${escapeHtml(survivor.email)}</a>.
  </p>`
}

/**
 * Issue #150's "an operator should be able to tell a merged client from one
 * that was always a single row" — the structured list, built from
 * `merged_into` (only `mergeClients` ever writes it), not from `cc_emails`
 * (which a customer can also write themselves via `saveClientProfile`, #131,
 * and which cannot be told apart from a merge-sourced address once both are
 * joined into one string).
 */
function mergedFromSection(mergedAway: MergedClient[]): string {
  return `<section class="card" data-testid="client-merged-from">
    <h2>Merged clients</h2>
    <ul>
      ${mergedAway
        .map(
          (row) =>
            `<li data-testid="client-merged-from-row"><span data-testid="client-merged-from-email">${escapeHtml(row.email)}</span> &middot; merged ${escapeHtml(row.mergedAt)}</li>`,
        )
        .join("\n      ")}
    </ul>
  </section>`
}

/**
 * Issue #150's actual write, offered from the client being merged *away* —
 * an operator looking at the duplicate address types the surviving client's
 * email and this client folds into it. `mergeClients` (`src/clients.ts`)
 * resolves that email the same case-insensitive way lead promotion's own
 * match does (`getClientRecordByEmail`), so casing is never the reason a
 * merge fails to find its target.
 */
function mergeForm(client: Client, error: string | null): string {
  return `<section class="card" data-testid="client-merge-card">
    <h2>Merge into another client</h2>
    <p class="hint">
      Same person under a different address? Merging moves every project onto the other client and
      keeps this address on record there — nothing here is deleted.
    </p>
    ${error ? `<p class="client-merge-error" data-testid="client-merge-error" role="alert">${escapeHtml(error)}</p>` : ""}
    <form class="client-merge" method="POST" action="/clients/${encodeURIComponent(client.id)}/merge" data-testid="client-merge-form">
      <div class="field">
        <label for="into-email">Merge into (their email)</label>
        <input type="email" id="into-email" name="intoEmail" data-testid="client-merge-email-input" required>
      </div>
      <div class="actions">
        <button type="submit" class="primary" data-testid="client-merge-submit">Merge</button>
      </div>
    </form>
  </section>`
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
 * One `client-project` card — titled with issue #149's `project.name` when
 * an operator has set one, otherwise the pre-#149 derivation from its
 * newest submission, the same rule `projectTitle()` in `routes/leads.ts`
 * uses for the reassignment panel. This is the primary screen #149 exists
 * for: an operator holding many clients' many projects needs the stable,
 * chosen name here first, not just on `/projects/:id`. Uses
 * `projectTitleFromNewest` rather than `projectTitle` itself because the
 * newest submission is already in hand from `submissions[0]`, since
 * `listSubmissionsForProjectUnscoped` orders newest-first, so there is
 * nothing to fetch twice.
 *
 * Issue #156 — every card also gets its own `renameProjectPanel`
 * (`routes/leads.ts`), posting to this project's own
 * `/clients/:clientId/projects/:projectId/rename`. This is, deliberately,
 * the *only* reachable rename form for a project with no promoted lead
 * behind it (an `/intake`-only submission) — see this file's module comment.
 * A page with several `client-project` cards therefore renders several
 * `rename-project-card`s, one per project, each scoped to its own project by
 * the surrounding `<section>` — a black-box test picking one must scope
 * through `client-project` the same way, not assume a single match the way
 * `/leads/:id` (one project at a time) safely could.
 */
function projectBlock(
  clientId: string,
  project: Project,
  submissions: Submission[],
  rows: string[],
): string {
  const title = projectTitleFromNewest(project, submissions[0] ?? null)
  const list =
    rows.length > 0
      ? `<ul class="submission-list">\n${rows.join("\n")}\n      </ul>`
      : `<p class="lede">No submissions under this project yet.</p>`
  const renameAction = `/clients/${encodeURIComponent(clientId)}/projects/${encodeURIComponent(project.id)}/rename`

  return `    <section class="card" data-testid="client-project">
      <div class="round-entry-head">
        <h3 data-testid="client-project-title">${escapeHtml(title)}</h3>
        <span class="round-date" data-testid="client-project-created-at">started ${escapeHtml(project.createdAt)}</span>
      </div>
      ${renameProjectPanel(renameAction, project)}
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

/**
 * POST /clients/:id/merge — issue #150. `:id` is the client being merged
 * *away*; the form's `intoEmail` names the surviving client. See `mergeForm`'s
 * own doc comment for why the form lives on the duplicate's own page rather
 * than the survivor's, and `mergeClients` (`src/clients.ts`) for the actual
 * write, its idempotency, and everything it refuses.
 *
 * Any refusal — a blank email, an email matching no client, self-merge, or a
 * merge `mergeClients` rejects as a would-be chain — re-renders this same
 * page with `error.message` in the merge form, the same "malformed input
 * gets a message, not a 500 or a silent no-op" posture `postLeadMessage`
 * already takes for a blank message body. An operator who mistypes an
 * address should be told why nothing moved, not left guessing.
 */
export async function postClientMerge(request: Request, env: Env, id: string): Promise<Response> {
  const operator = await readOperator(request, env)
  if (!operator) return leadsNotFound()

  const context = await loadClientDetailContext(env, id)
  if (!context) return leadsNotFound()

  const contentType = request.headers.get("content-type") ?? ""
  if (!isFormContentType(contentType)) return leadsNotFound()

  const form = await parseFormData(request)
  if (!form) return leadsNotFound()

  const rawEmail = form.get("intoEmail")
  const intoEmail = typeof rawEmail === "string" ? rawEmail.trim() : ""

  const renderError = async (message: string): Promise<Response> => {
    // Re-read rather than reusing `context`: on the "already merged into a
    // different client" refusal, the caller's own prior attempt may have
    // partly raced with another request — reading fresh means the error
    // page always reflects what is actually stored, not a stale guess.
    const fresh = (await loadClientDetailContext(env, id)) ?? context
    return html(page(`${fresh.client.email} — coord-portal`, clientDetailPage(operator, fresh, message)), {
      status: 400,
    })
  }

  if (!intoEmail) return renderError("Enter the other client's email to merge into.")

  const target = await getClientRecordByEmail(env, intoEmail)
  if (!target) return renderError(`No client found for ${intoEmail}.`)

  try {
    await mergeClients(env, target.id, id)
  } catch (err) {
    if (err instanceof ClientMergeError) return renderError(err.message)
    throw err
  }

  return new Response(null, {
    status: 303,
    headers: { location: `/clients/${encodeURIComponent(target.id)}` },
  })
}

/**
 * POST /clients/:clientId/projects/:projectId/rename — issue #156. The
 * project-keyed counterpart to `routes/leads.ts`'s
 * `POST /leads/:id/project/rename` (#149): calls the identical
 * `renameProject` (`src/projects.ts`), which already normalizes a blank
 * `name` to `null` — "go back to the automatic title" — the same way that
 * route's own refusal-free blank submit does.
 *
 * The ownership check is `project.clientId === clientId`, not merely
 * "does a project with this id exist": `:projectId` and `:clientId` both
 * come from the same `/clients/:id` page (`projectBlock`'s own `renameAction`
 * above always pairs a project with the client it was loaded under), so a
 * `projectId` copied onto a *different* `clientId` in the URL must not rename
 * a project that page never showed for that client — same posture as every
 * other refusal on this operator surface: the caller gets the one
 * indistinguishable 404 (`leadsNotFound()`), never a hint about which of
 * "wrong client", "unknown project" or "not an operator" was true.
 */
export async function postClientProjectRename(
  request: Request,
  env: Env,
  clientId: string,
  projectId: string,
): Promise<Response> {
  const operator = await readOperator(request, env)
  if (!operator) return leadsNotFound()

  const project = await getProject(env, projectId)
  if (!project || project.clientId !== clientId) return leadsNotFound()

  const contentType = request.headers.get("content-type") ?? ""
  if (!isFormContentType(contentType)) return leadsNotFound()

  const form = await parseFormData(request)
  if (!form) return leadsNotFound()

  const rawName = form.get("name")
  await renameProject(env, project.id, typeof rawName === "string" ? rawName : null)

  return new Response(null, {
    status: 303,
    headers: { location: `/clients/${encodeURIComponent(clientId)}` },
  })
}
