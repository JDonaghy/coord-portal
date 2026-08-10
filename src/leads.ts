import { generateLeadId, generateLeadReference, generateSubmissionId, generateSubmissionReference } from "./ids"
import { createSubmissionStatements } from "./submissions"
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
 * Inserts one lead row and nothing else.
 *
 * Deliberately a single `INSERT`, not a `DB.batch()` alongside a bridge event
 * the way `createSubmission` pairs its insert with `submission.created` —
 * there is no event to pair it with. "Coord never sees leads; they are
 * pre-pipeline by construction, and the sync bridge must not learn about
 * them." The id and reference are generated here, never accepted from the
 * caller, for the same reason `createSubmission` does it this way: which lead
 * this is is not something a request gets to assert about itself.
 */
export async function createLead(env: Env, input: NewLeadInput): Promise<Lead> {
  const id = generateLeadId()
  const reference = generateLeadReference()
  const createdAt = new Date().toISOString()

  await env.DB.prepare(
    `INSERT INTO leads (id, reference, summary, email, name, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, reference, input.summary, input.email, input.name, createdAt)
    .run()

  return fromRow({
    id,
    reference,
    summary: input.summary,
    email: input.email,
    name: input.name,
    created_at: createdAt,
    promoted_at: null,
    promoted_submission_id: null,
    promoted_submission_reference: null,
  })
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
 * Promotes a lead: one submission, owned by the lead's email, and the lead
 * recording what it produced. Idempotent.
 *
 * ── HOW IT IS IDEMPOTENT ───────────────────────────────────────────────────
 * "Promoting the same lead twice creates one submission, not two. A
 * double-click, a retried request, or an operator who forgot they already did
 * it must all converge on the same submission" (issue #33).
 *
 * A read-then-write would not survive that: two concurrent promotes both read a
 * `new` lead and both write. So all three statements go into one `DB.batch()`
 * — which D1 runs as a single transaction — and all three are guarded on the
 * same predicate, `this lead is still unpromoted`:
 *
 *   1. INSERT the submission   ┐ guarded: `FROM leads WHERE id = ? AND
 *   2. INSERT submission.created ┘          promoted_at IS NULL`
 *   3. UPDATE the lead to point at them, `WHERE id = ? AND promoted_at IS NULL`
 *
 * The guard is evaluated before (3) commits, so within one transaction all
 * three fire or none do. A second transaction — the double-click, the retry —
 * sees a non-NULL `promoted_at` and every statement matches zero rows. Nothing
 * errors, nothing duplicates, and the caller reads back the same submission the
 * first promote created, which is what "converge" has to mean for an operator
 * who cannot tell which of their two clicks landed.
 *
 * The submission is built by `createSubmissionStatements`, the same function
 * `POST /intake` uses — so the `submission.created` event this emits is
 * byte-identical in shape to the one a customer filling in the intake form
 * produces. From the daemon's side promotion is indistinguishable from ordinary
 * intake, and the daemon never learns a lead was involved.
 */
export async function promoteLead(env: Env, lead: Lead): Promise<Lead> {
  if (lead.promotedAt !== null) return lead

  const promotedAt = new Date().toISOString()
  const guard = {
    clause: "FROM leads WHERE leads.id = ? AND leads.promoted_at IS NULL",
    bindings: [lead.id],
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
    },
  )

  await env.DB.batch([
    ...statements,
    env.DB.prepare(
      `UPDATE leads
          SET promoted_at = ?, promoted_submission_id = ?, promoted_submission_reference = ?
        WHERE id = ? AND promoted_at IS NULL`,
    ).bind(promotedAt, submission.id, submission.reference, lead.id),
  ])

  // Read back rather than assuming we won the race: on the losing side of a
  // double-click every statement above matched nothing, and the row already
  // names the submission the other request created.
  return (await getLead(env, lead.id)) ?? lead
}
