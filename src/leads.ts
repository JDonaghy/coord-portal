import { generateLeadId, generateLeadReference } from "./ids"
import type { Env } from "./types"

/**
 * A lead — first contact from a stranger with no account (issue #31).
 *
 * "leads is its own table, not a submissions row with a flag ... it is what
 * makes 'a stranger cannot reach the pipeline' a structural fact rather than
 * a policy someone has to remember." Creating one writes exactly one row: no
 * `submissions` row, no `bridge_events` entry, no dispatch of any kind —
 * "nothing a stranger posts can cost compute" (issue #31). Promotion to a
 * real submission is a deliberate operator act that is its own issue (#33)
 * and has no code path here.
 */
export interface Lead {
  id: string
  reference: string
  summary: string
  email: string
  name: string | null
  createdAt: string
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
}

function fromRow(row: LeadRow): Lead {
  return {
    id: row.id,
    reference: row.reference,
    summary: row.summary,
    email: row.email,
    name: row.name,
    createdAt: row.created_at,
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

  const lead: LeadRow = {
    id,
    reference,
    summary: input.summary,
    email: input.email,
    name: input.name,
    created_at: createdAt,
  }
  return fromRow(lead)
}
