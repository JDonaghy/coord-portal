import { appendEventStatement } from "./bridge/events"
import { chunkForBinding } from "./d1"
import type { SubmissionStatus } from "./submissions"
import type { Env } from "./types"

/**
 * The operator "start work" override — issue #132.
 *
 * "The operator already agreed the work out-of-band (a known client, a small
 * well-understood ask) and running a design round would only add latency for
 * no benefit — this is an override, not a fast-tracked design round." One
 * operator action, reachable from `/leads/:id` (`src/routes/leads.ts`), skips
 * the whole `Describing -> In design -> Awaiting sign-off -> Signed off` loop
 * and lands the submission on the customer-visible equivalent of `Planned`.
 *
 * ── WHO WRITES WHAT, AND WHY NOTHING HERE WRITES `submissions.status` ──────
 * `status` is coord-owned (`src/bridge/ownership.ts`) — there is no portal
 * code path that writes it, and this module does not add one. `start_work`
 * (`migrations/0017_start_work.sql`) records the operator's decision, and
 * `derivedStartWorkStatus` below derives a customer-visible `planned` from it
 * — the identical trick `derivedStatus` (`src/rounds.ts`) plays for an
 * approved design round and `derivedQualityCheckStatus`
 * (`src/previewReviews.ts`) plays for a preview review: a portal-owned fact
 * plus the stored coord status produces the screen, never a second writer on
 * the column the coordinator owns.
 *
 * ── THE BRIDGE EVENT DECISION (issue #132's "one real design decision") ────
 * #132 lays out two options for making this bridge-visible and asks the
 * implementer to pick one and document the choice here:
 *
 *   1. Reuse `signoff.approved`'s shape, emitted by the operator action
 *      instead of a customer's sign-off click.
 *   2. A new `work.requested` bridge event kind, which needs a matching
 *      handling note added to `coord/skills/portal-followup/SKILL.md` on the
 *      `claude-coordinator` side.
 *
 * **This module picks option 1.** `recordStartWork` emits `signoff.approved`
 * — the exact event kind `src/rounds.ts`'s `recordSignoff` already emits for
 * an approved design round. Reasoning:
 *
 *   * It ships working, end-to-end, from this repo alone. `coord portal
 *     events` (`coord/skills/portal-followup/SKILL.md`, per issue #132's own
 *     text) already treats `signoff.approved` as "move toward
 *     planned/in-progress" — precisely the outcome this override wants — so
 *     no companion change to the `claude-coordinator` repo is required before
 *     this is useful to the fleet.
 *   * Option 2 is not a smaller change wearing a different name: it needs a
 *     handling note on the *other* repo's skill doc, "coordinate with the
 *     companion TUI-bridge epic in that repo" per #132's own text — real
 *     cross-repo coordination this change, scoped to `coord-portal` alone,
 *     cannot responsibly do in the same breath. Shipping a new event kind
 *     nothing on the daemon side recognises yet would be a bridge-visible
 *     event that is bridge-invisible in practice until that follow-up lands.
 *
 * The acknowledged trade-off — "the event no longer always means a customer
 * approved a design round," which `coord/skills/portal-followup/SKILL.md`
 * currently assumes — is real, and this module does not pretend otherwise.
 * It is mitigated, not solved: the payload below sets `round: null` (there is
 * no round) and carries an explicit `source: "operator_start_work"` marker,
 * additive to the shape `recordSignoff` already emits, so a coord-side reader
 * that wants to tell the two apart can, without this portal needing to grow
 * a new `BRIDGE_EVENT_TYPES` member to make that possible. If the fleet later
 * decides the ambiguity is not tolerable, option 2 is still there, unblocked
 * by anything this migration or module did.
 *
 * ── THE #835 ORDERING GUARD ─────────────────────────────────────────────────
 * "If 'start work' is itself an announcing status, don't let the announcement
 * outrun whatever it announces" — the same pattern already in place for
 * `awaiting-signoff`/`design_round` (`src/bridge/updates.ts`, one `DB.batch()`
 * per push) and `quality-check`/`preview` (`preview_url` alongside `status` in
 * that same batch). There is no coordinator push here to order against — the
 * operator's own action *is* the announcement — so the guard takes the shape
 * `recordSignoff`/`recordPreviewReview` already use for exactly this
 * situation (a portal-side write plus the event that announces it): the
 * `start_work` row and its `bridge_events` row land in one `DB.batch()`,
 * guarded by the identical `WHERE NOT EXISTS` shape, so the event can never be
 * recorded without the fact that authorises it landing in the same
 * transaction, or vice versa.
 *
 * Separately: no email is sent for this transition. `planned` is not in
 * `src/notifications.ts`'s `SENDING_TYPES` — the sealed acceptance contract
 * pins no notification, `outbox` row or `email-preview` for this action, and
 * this module does not invent one. With nothing announced to the customer by
 * email, there is no send to order against either.
 */

export interface StartWorkRecord {
  startedAt: string
}

interface StartWorkRow {
  submission_id: string
  started_at: string
}

/** Has an operator ever used the override on this submission? */
export async function getStartWork(
  env: Env,
  submissionReference: string,
): Promise<StartWorkRecord | null> {
  const row = await env.DB.prepare(`SELECT started_at FROM start_work WHERE submission_id = ?`)
    .bind(submissionReference)
    .first<{ started_at: string }>()
  return row ? { startedAt: row.started_at } : null
}

/**
 * The same lookup as `getStartWork`, for many submissions at once — mirrors
 * `loadSignoffStates` (`src/rounds.ts`): the dashboard renders a derived
 * status per row, and a per-row lookup would spend one D1 subrequest per
 * submission for a fact that fits in a single statement.
 *
 * Chunked at `D1_MAX_BOUND_PARAMS` for the same reason and with the same
 * guarantees as that function — see `src/d1.ts` for the limit this is dodging.
 */
export async function loadStartWorkStates(
  env: Env,
  submissionReferences: string[],
): Promise<Map<string, StartWorkRecord>> {
  const states = new Map<string, StartWorkRecord>()
  if (submissionReferences.length === 0) return states

  const batches = await Promise.all(
    chunkForBinding(submissionReferences).map(async (references) => {
      const placeholders = references.map(() => "?").join(", ")
      const { results } = await env.DB.prepare(
        `SELECT submission_id, started_at FROM start_work WHERE submission_id IN (${placeholders})`,
      )
        .bind(...references)
        .all<StartWorkRow>()
      return results ?? []
    }),
  )

  for (const row of batches.flat()) {
    states.set(row.submission_id, { startedAt: row.started_at })
  }
  return states
}

/**
 * The customer-visible status, derived — never stored. Mirrors `derivedStatus`
 * (`src/rounds.ts`): only `describing` is derived at all, because it is the
 * only stored status whose truth can depend on this portal-owned fact — a
 * submission the override has already moved past `describing` has, by
 * definition, had the coordinator push some later status of its own, and
 * this function stops having an opinion the moment that happens, the same way
 * `derivedStatus` stops overriding `awaiting-signoff` once the coordinator's
 * own next push moves the stored value on.
 */
export function derivedStartWorkStatus(
  stored: SubmissionStatus,
  state: StartWorkRecord | null,
): SubmissionStatus {
  if (stored !== "describing" || state === null) return stored
  return "planned"
}

/**
 * Records the operator's "start work" decision and publishes it to the
 * coordinator as a `signoff.approved` bridge event — in one `DB.batch()`,
 * idempotently against a doubled or concurrent POST.
 *
 * Exactly `recordSignoff`'s shape (`src/rounds.ts`) and for exactly the same
 * reasons: the event insert is guarded by `WHERE NOT EXISTS (... start_work
 * ...)`, evaluated before the `start_work` row lands, so a retry records
 * nothing and emits nothing while the first attempt records and emits both or
 * neither. `start_work.submission_id`'s own `PRIMARY KEY` is the second line
 * of defence — `INSERT OR IGNORE` is then a true no-op on a genuine repeat,
 * not merely conditional on the guard above having run first.
 *
 * Safe to call on a submission the override has already been used on: it
 * simply reports `recorded: false` and changes nothing, which is what makes
 * `POST /leads/:id/start-work` safe to retry or race (see
 * `src/routes/leads.ts`).
 */
export async function recordStartWork(
  env: Env,
  submissionReference: string,
): Promise<{ recorded: boolean }> {
  const startedAt = new Date().toISOString()
  const guard = {
    clause: "WHERE NOT EXISTS (SELECT 1 FROM start_work WHERE submission_id = ?)",
    bindings: [submissionReference],
  }

  const [eventInsert] = await env.DB.batch([
    appendEventStatement(
      env,
      {
        type: "signoff.approved",
        submissionReference,
        occurredAt: startedAt,
        // See this module's doc comment: reuses `signoff.approved`'s shape
        // (`round`, `verdict`, `comment`) with `round: null` (there is no
        // round to name) and an additive `source` marker distinguishing an
        // operator override from a genuine customer decision.
        payload: { round: null, verdict: "approved", comment: null, source: "operator_start_work" },
      },
      guard,
    ),
    env.DB.prepare(`INSERT OR IGNORE INTO start_work (submission_id, started_at) VALUES (?, ?)`).bind(
      submissionReference,
      startedAt,
    ),
  ])

  return { recorded: (eventInsert?.meta.changes ?? 0) > 0 }
}
