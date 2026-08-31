import { getClientRecordByEmail, clientCreationStatement } from "./clients"
import {
  generateClientId,
  generateLeadId,
  generateLeadReference,
  generateProjectId,
  generateSubmissionId,
  generateSubmissionReference,
} from "./ids"
import {
  listProjectsForClient,
  projectCreationForEmailResolvedClient,
  projectCreationForKnownClient,
} from "./projects"
import { createSubmissionStatements, type CreateGuard } from "./submissions"
import type { Env } from "./types"

/**
 * A lead — first contact from a stranger with no account (issue #31), and the
 * operator act that turns one into a customer (issue #33).
 *
 * "leads is its own table, not a submissions row with a flag ... it is what
 * makes 'a stranger cannot reach the pipeline' a structural fact rather than
 * a policy someone has to remember." Creating one writes exactly one row: no
 * `submissions` row, no `bridge_events` entry, no dispatch of any kind —
 * "nothing a stranger posts can cost compute" (issue #31).
 *
 * Promotion is the only path out of that inertness, and it is a deliberate
 * human act: `promoteLead` below, reachable only from the operator surface. A
 * lead nobody promotes stays `new` forever — there is no timeout that promotes,
 * no batch job, and nothing in this module that runs on its own.
 */
export interface Lead {
  id: string
  reference: string
  summary: string
  email: string
  name: string | null
  createdAt: string
  /** ISO-8601, or `null` while the lead is still `new`. */
  promotedAt: string | null
  /** The `sub_…` URL id of what promotion produced, or `null`. */
  promotedSubmissionId: string | null
  /** The `SUB-XXXXXX` reference of what promotion produced, or `null`. */
  promotedSubmissionReference: string | null
}

/**
 * The two states a lead can be in (Gate-A contract, § Lead lifecycle). There
 * is deliberately no `declined`, `archived` or `spam` — issue #33 scopes those
 * out, and a lead that is never promoted simply stays `new`.
 *
 * Derived, never stored: `promoted_at` already records the fact, and a status
 * column beside it would be the same fact stored twice with no way to tell
 * which copy is right on the day they disagree.
 */
export type LeadStatus = "new" | "promoted"

export const LEAD_STATUS_TEXT: Record<LeadStatus, string> = {
  new: "New",
  promoted: "Promoted",
}

export function leadStatus(lead: Lead): LeadStatus {
  return lead.promotedAt === null ? "new" : "promoted"
}

export interface NewLeadInput {
  summary: string
  email: string
  name: string | null
}

interface LeadRow {
  id: string
  reference: string
  summary: string
  email: string
  name: string | null
  created_at: string
  promoted_at: string | null
  promoted_submission_id: string | null
  promoted_submission_reference: string | null
}

function fromRow(row: LeadRow): Lead {
  return {
    id: row.id,
    reference: row.reference,
    summary: row.summary,
    email: row.email,
    name: row.name,
    createdAt: row.created_at,
    promotedAt: row.promoted_at,
    promotedSubmissionId: row.promoted_submission_id,
    promotedSubmissionReference: row.promoted_submission_reference,
  }
}

/**
 * Mint one lead's identity — id, reference, `created_at` — without writing it.
 *
 * Split out of `createLead` for issue #164 (EM-4), whose caller must know the
 * `leads.id` and `LEAD-XXXXXX` reference *before* the write, so both can be
 * recorded on the `inbound_emails` row and rendered into the drafted
 * acknowledgement inside the same transaction. Same rule as before the split:
 * the id and reference are generated here, never accepted from a caller —
 * which lead this is is not something a request gets to assert about itself.
 */
export function mintLead(input: NewLeadInput): Lead {
  return fromRow({
    id: generateLeadId(),
    reference: generateLeadReference(),
    summary: input.summary,
    email: input.email,
    name: input.name,
    created_at: new Date().toISOString(),
    promoted_at: null,
    promoted_submission_id: null,
    promoted_submission_reference: null,
  })
}

/**
 * The one `INSERT` every lead in this app is written by — returned rather than
 * executed, so a caller that must write a lead *atomically alongside other
 * rows* can put it in its own `DB.batch()`. `createLead` below is the ordinary
 * "just do it" wrapper, and `POST /start` is its caller.
 *
 * `INSERT … SELECT` rather than `INSERT … VALUES` so the guarded and unguarded
 * forms are one statement with one column list, not two that can drift apart —
 * `createSubmissionStatements` (`src/submissions.ts`) established that shape
 * and this follows it. With no guard the `SELECT` has no `FROM` and yields
 * exactly one row, which is what `VALUES` did.
 *
 * ── A SECOND CALLER (ISSUE #164, EM-4 OF MILESTONE #5) ──────────────────────
 * `src/routes/start.ts`'s `POST /start` is no longer the only path that mints a
 * lead: `src/inboundEmail.ts` writes one too, for rung 6 of EM-3's router
 * ("nobody we know, or ambiguous → a lead") — "the *same function* `POST
 * /start` calls, producing the same inert row on the same triage screen,
 * promotable by the same button. A stranger's email is a stranger's form
 * submission that happened to arrive over SMTP." That sameness is what this
 * split preserves: both callers write this one statement, with these columns,
 * from an identity minted by `mintLead` above. What EM-4 adds is a `guard`,
 * because its lead must not exist unless the `inbound_emails` row that
 * justifies it landed in the same batch.
 */
export function leadCreationStatement(
  env: Env,
  lead: Lead,
  guard?: CreateGuard,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO leads (id, reference, summary, email, name, created_at)
     SELECT ?, ?, ?, ?, ?, ?
     ${guard ? guard.clause : ""}`,
  ).bind(
    lead.id,
    lead.reference,
    lead.summary,
    lead.email,
    lead.name,
    lead.createdAt,
    ...(guard ? guard.bindings : []),
  )
}

/**
 * Inserts one lead row and nothing else.
 *
 * Deliberately a single `INSERT`, not a `DB.batch()` alongside a bridge event
 * the way `createSubmission` pairs its insert with `submission.created` —
 * there is no event to pair it with. "Coord never sees leads; they are
 * pre-pipeline by construction, and the sync bridge must not learn about
 * them."
 */
export async function createLead(env: Env, input: NewLeadInput): Promise<Lead> {
  const lead = mintLead(input)
  await leadCreationStatement(env, lead).run()
  return lead
}

/**
 * Every lead, newest first — the operator's inbox (issue #33: "an
 * operator-facing list of leads with enough of each to decide").
 *
 * Unscoped on purpose, and the one query in this repo that is: a lead belongs
 * to nobody. It has no owner to scope by (the person who sent it has no
 * account, which is the entire point of `/start`), so the gate is the operator
 * allowlist in front of the route (`src/operators.ts`), not a `WHERE` clause
 * here.
 *
 * `rowid` breaks the ordering tie. `created_at` is ISO-8601 with milliseconds
 * so a collision is unlikely, but "unlikely" would show up as an inbox that
 * shuffles two leads between reloads, which reads as a bug in the list rather
 * than as a coincidence in the clock.
 */
export async function listLeads(env: Env): Promise<Lead[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM leads ORDER BY created_at DESC, rowid DESC`,
  ).all<LeadRow>()
  return (results ?? []).map(fromRow)
}

export async function getLead(env: Env, id: string): Promise<Lead | null> {
  const row = await env.DB.prepare(`SELECT * FROM leads WHERE id = ?`)
    .bind(id)
    .first<LeadRow>()
  return row ? fromRow(row) : null
}

/**
 * What a promoted lead becomes, in the fields `submissions` requires.
 *
 * `/start` asks for three things and `/intake` asks for five, so two of the
 * five have no answer at first contact. They are filled with a plain statement
 * that they were not captured rather than with a guess: an invented "audience"
 * would be indistinguishable, downstream, from one the customer actually gave,
 * and the fleet would plan against something nobody said. Neither field is
 * rendered on any customer screen (see `detailFor` in `routes/submission.ts`);
 * both cross the bridge, where the honest version is the useful one.
 */
const NOT_CAPTURED_AT_FIRST_CONTACT =
  "Not captured at first contact — this came in through the contact form, so it still needs to be agreed with the customer."

/**
 * Promotes a lead: one submission, owned by the lead's email, attached to a
 * client-linked project, and the lead recording what it produced. Idempotent.
 *
 * ── HOW IT IS IDEMPOTENT ───────────────────────────────────────────────────
 * "Promoting the same lead twice creates one submission, not two. A
 * double-click, a retried request, or an operator who forgot they already did
 * it must all converge on the same submission" (issue #33) — and, per #129,
 * "does not double-create a client" either.
 *
 * A read-then-write would not survive that: two concurrent promotes both read a
 * `new` lead and both write. So every statement this function can produce goes
 * into one `DB.batch()` — which D1 runs as a single transaction — and every one
 * of them is guarded on the same predicate, `this lead is still unpromoted`
 * (`leads.id = ? AND leads.promoted_at IS NULL`, `lead.id` bound as `leadId`
 * below): the client insert (no-match branch only), the project insert
 * (whichever branch needs one), the submission insert, its `submission.created`
 * event, and finally the lead's own `UPDATE`. On the losing side of a race —
 * the double-click, the retry — every one of them matches zero rows: nothing
 * errors, nothing duplicates, and the caller reads back exactly what the first
 * promote produced, which is what "converge" has to mean for an operator who
 * cannot tell which of their two clicks landed.
 *
 * The submission itself is built by `createSubmissionStatements`, the same
 * function `POST /intake` uses — so the `submission.created` event this emits
 * is byte-identical in shape to the one a customer filling in the intake form
 * produces. From the daemon's side promotion is indistinguishable from ordinary
 * intake, and the daemon never learns a lead was involved.
 *
 * ── WHY THIS *IS* WHERE A PROJECT GETS CREATED NOW (ISSUE #129) ────────────
 * Until #129, this function deliberately left every promoted submission
 * project-less — see git history for the reasoning that used to live here,
 * built on #109's own constraint that a matching email alone must never
 * silently fold one customer's history into another's. #129 changes the
 * requirement itself, not that reasoning: an operator who promotes a lead from
 * an address `clients` already knows now *resolves* that match — explicitly,
 * on the promotion screen itself (`client-match-card`, `src/routes/leads.ts`),
 * never inferred silently — and either attaches the new submission to a
 * project the operator picked, or (an address nothing matches) mints a brand
 * new client and a first project in the same transaction. This is no longer
 * the #109 "guess from a bare email match" case #109's own sealed suite rules
 * out — it is an operator's explicit, informed choice, made once per
 * promotion, the same way `NewSubmissionInput.followUpFrom` is a customer's
 * own explicit choice on `/submissions/:id`. See `src/clients.ts`'s module
 * comment for the still-open tension this creates with a *different* sealed
 * suite (ms-2's), which this function's own output cannot avoid triggering.
 *
 * ── THE THREE SHAPES `projectChoice` CAN TAKE ───────────────────────────────
 * `projectChoice` is untrusted input straight off `promote-lead-form`
 * (`src/routes/leads.ts`), validated here, never in the route:
 *
 *   1. No client matches `lead.email` at all — `projectChoice` is ignored
 *      outright (there is nothing it could name); a client and a first
 *      project are minted together.
 *   2. A client matches, and `projectChoice` names one of *that* client's own
 *      projects (`listProjectsForClient` — never a project belonging to
 *      someone else, and never a project with `client_id IS NULL`, e.g. one
 *      born from a customer's own "Start a follow-up" action) — the
 *      submission joins it, no INSERT beyond the submission itself.
 *   3. A client matches, but `projectChoice` is `"new"`, absent, or names
 *      nothing real — a new project is minted for that *same* client (`"new"`
 *      is the operator's explicit choice; absent-or-garbage falls back to the
 *      newest project when the client has one, matching what the match card
 *      pre-selects, and only mints a new one when even that fallback has
 *      nothing to offer).
 */
export async function promoteLead(
  env: Env,
  lead: Lead,
  projectChoice: string | null = null,
): Promise<Lead> {
  if (lead.promotedAt !== null) return lead

  const promotedAt = new Date().toISOString()
  const leadId = lead.id
  const guard = {
    clause: "FROM leads WHERE leads.id = ? AND leads.promoted_at IS NULL",
    bindings: [leadId],
  }

  const matchedClient = await getClientRecordByEmail(env, lead.email)
  const preparatory: D1PreparedStatement[] = []
  let projectId: string
  // The matched branch already read an *existing* client row back — no race
  // to resolve, so `clientId` (the trusted, synchronously-known shape,
  // `CreateSubmissionOptions` in `src/submissions.ts`) is safe. The no-match
  // branch is different: it mints the client row in this same batch via
  // `clientCreationStatement`, and that insert's own `NOT EXISTS` guard can
  // lose to a concurrent promotion of a *different* lead sharing this email
  // (see that statement's doc comment in `src/clients.ts`) — so the candidate
  // id generated below is not safe to trust for the event either, only for
  // this branch's own guarded INSERT. It instead sets `clientEmailToResolve`,
  // which makes `createSubmissionStatements` read the real winner back via a
  // live subquery in the same transaction — the same trick
  // `projectCreationForEmailResolvedClient` (`src/projects.ts`) already uses
  // for the project row's own `client_id`.
  //
  // Either way what reaches the bridge is an opaque `client_id`: the lead's
  // contact address stays on this side (ms-2 contract note 7 / issue #33 —
  // "coord never sees leads").
  let submissionClientOptions: { clientId: string | null } | { clientEmailToResolve: string }

  if (matchedClient) {
    submissionClientOptions = { clientId: matchedClient.id }
    const projects = await listProjectsForClient(env, matchedClient.id)
    const chosen =
      projectChoice && projectChoice !== "new"
        ? projects.find((candidate) => candidate.id === projectChoice)
        : undefined

    if (chosen) {
      projectId = chosen.id
    } else if (projectChoice !== "new" && projects.length > 0) {
      // No usable choice came in — the match card always pre-selects the
      // newest project, so an ordinary form submit already carries its id;
      // this branch only covers a malformed or omitted `projectChoice`.
      projectId = projects[0]!.id
    } else {
      projectId = generateProjectId()
      preparatory.push(
        projectCreationForKnownClient(env, projectId, lead.email, matchedClient.id, promotedAt, leadId),
      )
    }
  } else {
    // A candidate id, minted here only for this branch's own guarded INSERT
    // below — never trusted for the event (see the comment above
    // `submissionClientOptions`'s declaration for why).
    const candidateClientId = generateClientId()
    projectId = generateProjectId()
    submissionClientOptions = { clientEmailToResolve: lead.email }
    preparatory.push(clientCreationStatement(env, candidateClientId, lead.email, promotedAt, leadId))
    preparatory.push(projectCreationForEmailResolvedClient(env, projectId, lead.email, promotedAt, leadId))
  }

  const { submission, statements } = createSubmissionStatements(
    env,
    {
      // The lead's email *is* the customer's identity from here on — it is what
      // scopes every authenticated screen (#12) and what an Access seat has to
      // be issued to. See the operator-facing warning in `routes/leads.ts`.
      customerEmail: lead.email,
      outcome: lead.summary,
      audience: NOT_CAPTURED_AT_FIRST_CONTACT,
      doneDefinition: NOT_CAPTURED_AT_FIRST_CONTACT,
      constraints: null,
      projectScope: null,
    },
    {
      id: generateSubmissionId(),
      reference: generateSubmissionReference(),
      guard,
      projectId,
      ...submissionClientOptions,
    },
  )

  await env.DB.batch([
    ...preparatory,
    ...statements,
    env.DB.prepare(
      `UPDATE leads
          SET promoted_at = ?, promoted_submission_id = ?, promoted_submission_reference = ?
        WHERE id = ? AND promoted_at IS NULL`,
    ).bind(promotedAt, submission.id, submission.reference, leadId),
  ])

  // Read back rather than assuming we won the race: on the losing side of a
  // double-click every statement above matched nothing, and the row already
  // names the submission the other request created.
  return (await getLead(env, lead.id)) ?? lead
}
