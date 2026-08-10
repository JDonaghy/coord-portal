import { generateEventId } from "./ids"
import type { Env } from "./types"
import type { SubmissionStatus } from "./submissions"

/**
 * Design rounds and the versioned sign-off loop — issue #13.
 *
 *   In design -> Awaiting sign-off -> (changes requested) -> In design -> ... -> Signed off
 *
 * A round carries a plain-language outcome definition, a proposed decomposition
 * and a mock bundle link. The customer approves it or requests changes with a
 * comment; requesting changes opens round N+1 and never touches round N. Every
 * round stays readable at `/submissions/:id/rounds` — that history is the audit
 * trail of what was agreed, so nothing here deletes, hides or rewrites a round
 * once it has a verdict.
 *
 * ── WHO WRITES WHAT ────────────────────────────────────────────────────────
 * The round's *content* is coord-owned (`design_round`, `decomposition`,
 * `artifacts` in `src/bridge/ownership.ts`) and arrives over the bridge. The
 * *verdict* is portal-owned (`signoff_verdict`, `signoff_comment`) and is
 * written only by the customer pressing a button. Nothing is co-written, which
 * is why there is no merge rule in this file.
 *
 * ── AND WHY NOTHING HERE WRITES `submissions.status` ───────────────────────
 * The contract says request-changes "returns the submission to In design" and
 * approve "is the only action that can move a submission past Awaiting your
 * sign-off toward Planned". `status` is coord-owned, so the portal writing it
 * would be exactly the two-writer field CLAUDE.md forbids. Both statements hold
 * anyway, by *derivation*: see `derivedStatus` below. This is the same shape the
 * question channel already uses to decide whether a question is open — a
 * portal-owned row answered against a coord-owned fact, never a portal write on
 * top of one.
 */

/** The pinned verdict vocabulary (Gate-A contract, § round history hooks). */
export const ROUND_VERDICTS = ["pending", "approved", "changes-requested"] as const

export type RoundVerdict = (typeof ROUND_VERDICTS)[number]

/** Verdict slug -> the customer-visible text, per `mocks/07-round-history.html`. */
export const VERDICT_TEXT: Record<RoundVerdict, string> = {
  pending: "Awaiting your sign-off",
  approved: "Approved",
  "changes-requested": "Changes requested",
}

/** A verdict the customer can actually give. `pending` is the absence of one. */
export type DecidedVerdict = Exclude<RoundVerdict, "pending">

export interface DesignRound {
  round: number
  outcomeDefinition: string
  decomposition: string[]
  /** Absolute URL, or an R2 key under the ARTIFACTS bucket. `null` if coord pushed none. */
  mockBundle: string | null
  openedAt: string
  verdict: RoundVerdict
  /** Only ever set on `changes-requested` — approving asks for no comment. */
  comment: string | null
  decidedAt: string | null
}

interface RoundRow {
  round: number
  outcome_definition: string
  decomposition: string
  mock_bundle: string | null
  opened_at: string
  verdict: string | null
  comment: string | null
  decided_at: string | null
}

const ROUND_SELECT = `
  SELECT r.round, r.outcome_definition, r.decomposition, r.mock_bundle, r.opened_at,
         s.verdict, s.comment, s.decided_at
    FROM design_rounds r
    LEFT JOIN signoffs s
      ON s.submission_id = r.submission_id AND s.round = r.round
`

function fromRow(row: RoundRow): DesignRound {
  return {
    round: row.round,
    // Scrubbed on the way in *and* on the way out. Belt and braces: the wall
    // between customer copy and engineer-side identifiers is an "ever", and a
    // row written before a scrubber fix should not keep leaking because of when
    // it happened to arrive.
    outcomeDefinition: scrubEngineerIdentifiers(row.outcome_definition),
    decomposition: parseItems(row.decomposition),
    mockBundle: row.mock_bundle,
    openedAt: row.opened_at,
    verdict: isDecidedVerdict(row.verdict) ? row.verdict : "pending",
    comment: row.comment,
    decidedAt: row.decided_at,
  }
}

function isDecidedVerdict(value: unknown): value is DecidedVerdict {
  return value === "approved" || value === "changes-requested"
}

function parseItems(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return parsed
        .filter((item): item is string => typeof item === "string")
        .map(scrubEngineerIdentifiers)
        .filter((item) => item.length > 0)
    }
  } catch {
    // fall through
  }
  return []
}

/** Every round for a submission, newest first — the order `mocks/07` renders. */
export async function listRounds(env: Env, submissionReference: string): Promise<DesignRound[]> {
  const { results } = await env.DB.prepare(
    `${ROUND_SELECT} WHERE r.submission_id = ? ORDER BY r.round DESC`,
  )
    .bind(submissionReference)
    .all<RoundRow>()
  return (results ?? []).map(fromRow)
}

/**
 * The newest round, or `null` if coord has never published one.
 *
 * "Newest" is the only round the customer can act on: an older one either has a
 * verdict already or was superseded by the round that replaced it.
 */
export async function getCurrentRound(
  env: Env,
  submissionReference: string,
): Promise<DesignRound | null> {
  const row = await env.DB.prepare(
    `${ROUND_SELECT} WHERE r.submission_id = ? ORDER BY r.round DESC LIMIT 1`,
  )
    .bind(submissionReference)
    .first<RoundRow>()
  return row ? fromRow(row) : null
}

async function getRound(
  env: Env,
  submissionReference: string,
  round: number,
): Promise<DesignRound | null> {
  const row = await env.DB.prepare(`${ROUND_SELECT} WHERE r.submission_id = ? AND r.round = ?`)
    .bind(submissionReference, round)
    .first<RoundRow>()
  return row ? fromRow(row) : null
}

/** Just enough of the newest round to derive a status from. */
export interface SignoffState {
  round: number
  verdict: RoundVerdict
}

/**
 * The newest round + verdict for many submissions in one query — the dashboard
 * renders a derived status per row, and a per-row lookup would spend one D1
 * subrequest per submission for a fact that fits in a single statement.
 */
export async function loadSignoffStates(
  env: Env,
  submissionReferences: string[],
): Promise<Map<string, SignoffState>> {
  const states = new Map<string, SignoffState>()
  if (submissionReferences.length === 0) return states

  const placeholders = submissionReferences.map(() => "?").join(", ")
  const { results } = await env.DB.prepare(
    `SELECT r.submission_id, r.round, s.verdict
       FROM design_rounds r
       LEFT JOIN signoffs s
         ON s.submission_id = r.submission_id AND s.round = r.round
      WHERE r.submission_id IN (${placeholders})
        AND r.round = (SELECT MAX(round) FROM design_rounds x WHERE x.submission_id = r.submission_id)`,
  )
    .bind(...submissionReferences)
    .all<{ submission_id: string; round: number; verdict: string | null }>()

  for (const row of results ?? []) {
    states.set(row.submission_id, {
      round: row.round,
      verdict: isDecidedVerdict(row.verdict) ? row.verdict : "pending",
    })
  }
  return states
}

/**
 * The customer-visible status, derived — never stored.
 *
 * Only `awaiting-signoff` is derived at all, because it is the only stored
 * status whose truth depends on a portal-owned fact: whether the customer has
 * already decided the round in front of them.
 *
 *   no round published yet   -> Awaiting your sign-off (nothing to show, nothing
 *                               to press — see `actionableDetail`)
 *   round is pending         -> Awaiting your sign-off
 *   changes requested        -> In design      (the ball is back with the team)
 *   approved                 -> Planned        ("past Awaiting your sign-off
 *                               toward Planned", per the contract)
 *
 * Once the coordinator pushes its own next status the stored value moves off
 * `awaiting-signoff` and this function stops having an opinion — which is the
 * point: the derivation is a stop-gap for the round trip between the customer
 * pressing a button and the fleet noticing, not a second source of truth.
 */
export function derivedStatus(
  stored: SubmissionStatus,
  state: SignoffState | null,
): SubmissionStatus {
  if (stored !== "awaiting-signoff" || state === null) return stored
  if (state.verdict === "changes-requested") return "in-design"
  if (state.verdict === "approved") return "planned"
  return stored
}

/* ───────────────────────── coord's half: reading a push ───────────────────── */

/** What one bridge push says about a round. `null` fields mean "not mentioned". */
export interface RoundPatch {
  /** An explicit round number, if coord named one. Otherwise this module assigns it. */
  round: number | null
  outcomeDefinition: string | null
  decomposition: string[] | null
  mockBundle: string | null
}

/**
 * The fields of a push that describe a design round.
 *
 * The `design_round` payload shape is deliberately NOT pinned by the Gate-A
 * contract (note 3: "Portal-internal API shapes are not specified anywhere in
 * issues #8, #9, #11, #13"), and `decomposition` and `artifacts` are separate
 * coord-owned fields the daemon may push alongside it or on their own. So this
 * reads liberally — several spellings per fact, objects or bare strings, arrays
 * of strings or of `{title}`-ish objects — and returns `null` only when the push
 * says nothing about a round at all.
 *
 * Being liberal here is not sloppiness: a shape this side failed to anticipate
 * would otherwise be acknowledged by the bridge (200 `applied`) and then
 * silently render as an empty round, which is the one failure mode a sync
 * bridge must never have.
 */
export function readRoundPatch(fields: Record<string, unknown>): RoundPatch | null {
  const hasRound = "design_round" in fields
  const hasDecomposition = "decomposition" in fields
  const hasArtifacts = "artifacts" in fields
  if (!hasRound && !hasDecomposition && !hasArtifacts) return null

  const raw = hasRound ? fields["design_round"] : null
  const round = asObject(raw)

  let outcomeDefinition: string | null = null
  let decomposition: string[] | null = null
  let mockBundle: string | null = null
  let number: number | null = null

  if (typeof raw === "string") {
    // A bare string is the outcome definition — the smallest thing a round can be.
    outcomeDefinition = raw.trim() || null
  } else if (round) {
    number = asRoundNumber(
      firstDefined(round, ["round", "round_number", "roundNumber", "number", "n", "version"]),
    )
    outcomeDefinition = firstString(round, [
      "outcome_definition",
      "outcomeDefinition",
      "outcome",
      "definition",
      "summary",
      "what_we_understood",
    ])
    decomposition = asItems(
      firstDefined(round, ["decomposition", "items", "work_items", "workItems", "epics", "plan"]),
    )
    mockBundle = asBundle(
      firstDefined(round, [
        "mock_bundle",
        "mockBundle",
        "mock_bundle_url",
        "mockBundleUrl",
        "mocks",
        "mock",
        "bundle",
        "artifacts",
      ]),
    )
  }

  // `decomposition` and `artifacts` are coord-owned fields in their own right.
  // A push that carries them beside (or instead of) `design_round` is describing
  // the same round, so they win over whatever the nested object said — they are
  // the more specific statement.
  if (hasDecomposition) {
    decomposition = asItems(fields["decomposition"]) ?? decomposition
  }
  if (hasArtifacts) {
    mockBundle = asBundle(fields["artifacts"]) ?? mockBundle
  }

  return { round: number, outcomeDefinition, decomposition, mockBundle }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function firstDefined(source: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = source[key]
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

function firstString(source: Record<string, unknown>, keys: string[]): string | null {
  const value = firstDefined(source, keys)
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function asRoundNumber(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 1) return null
  return parsed
}

/**
 * A decomposition, as a list of plain-language work items.
 *
 * Accepts an array of strings, an array of `{title}`-ish objects, or a single
 * newline- (or bullet-) separated string. Returns `null` for "coord did not say"
 * so a push that only carries a mock bundle does not blank out the list.
 */
export function asItems(value: unknown): string[] | null {
  if (value === undefined || value === null) return null

  const raw: unknown[] = Array.isArray(value) ? value : typeof value === "string" ? value.split("\n") : [value]

  const items = raw
    .map((entry) => {
      if (typeof entry === "string") return entry
      const object = asObject(entry)
      if (!object) return ""
      return (
        firstString(object, ["title", "name", "text", "summary", "label", "item", "description"]) ??
        ""
      )
    })
    // Strip list markers a daemon may have pasted in from Markdown.
    .map((entry) => entry.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim())
    .map(scrubEngineerIdentifiers)
    .filter((entry) => entry.length > 0)

  return items
}

/** A mock bundle: an absolute URL, a root-relative path, or a bare R2 key. */
export function asBundle(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = asBundle(entry)
      if (found) return found
    }
    return null
  }
  const object = asObject(value)
  if (!object) return null
  return firstString(object, [
    "url",
    "href",
    "link",
    "mock_bundle",
    "mockBundle",
    "mock_bundle_url",
    "path",
    "key",
    "index",
  ])
}

/* ────────────────────────────── the wall ──────────────────────────────────── */

/**
 * Engineer-side identifiers, removed from anything coord-authored before it
 * reaches a customer screen.
 *
 * Issue #16: customers "never see a branch, an issue number, or a live agent",
 * and the Gate-A contract restates it for the decomposition specifically — "no
 * issue numbers, no branch names, no agent identifiers, **ever**". "Ever" is a
 * property of the surface, not a hope about what the daemon happens to send, so
 * it is enforced here rather than assumed upstream.
 *
 * Applied to coord-authored text only. A customer's own sign-off comment is
 * never scrubbed: those are their words, quoted back to them.
 */
const ENGINEER_IDENTIFIER_PATTERNS: RegExp[] = [
  // A link straight into the engineer's world.
  /https?:\/\/(?:www\.)?github\.com\/\S*/gi,
  // owner/repo#123 — before the bare `#123` rule, which would leave the repo.
  /\b[\w.-]+\/[\w.-]+#\d+\b/g,
  // "issue 12", "PR #4", "ticket 88", "epic #836"
  /\b(?:issues?|prs?|pull requests?|tickets?|epics?|milestones?)\s*#?\s*\d+\b/gi,
  // A bare cross-reference.
  /#\d+\b/g,
  // Branch names: `issue-13-design-rounds`, `feat/foo`, `release/2026-08`.
  /\bissue-\d+[\w-]*/gi,
  /\b(?:feat|feature|fix|hotfix|chore|docs|refactor|perf|test|build|ci|style|release)\/[\w./-]+/gi,
  // Agent and worker identifiers.
  /\b(?:agent|worker|subagent)-[\w.]+(?:-[\w.]+)*\b/gi,
]

export function scrubEngineerIdentifiers(value: string): string {
  let out = value
  for (const pattern of ENGINEER_IDENTIFIER_PATTERNS) {
    out = out.replace(pattern, " ")
  }
  return (
    out
      // Tidy what the removals left behind: empty brackets, doubled spaces,
      // orphaned punctuation. A scrub that leaves "Add CSV import ( )" is only
      // half a wall.
      .replace(/\(\s*\)/g, "")
      .replace(/\[\s*\]/g, "")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/[ \t]+([,.;:!?])/g, "$1")
      .replace(/[ \t]+$/gm, "")
      .replace(/^[\s\-–—,;:]+/, "")
      .replace(/[\s\-–—,;:]+$/, "")
      .trim()
  )
}

/* ──────────────────── writing: coord publishes, customer decides ──────────── */

/**
 * The statements that record what one bridge push says about a design round —
 * returned, not executed, so the caller can commit them in the same
 * `DB.batch()` as the rest of the update (`src/bridge/updates.ts`). A round
 * stored without the push that authorised it, or vice versa, is a state neither
 * side can explain afterwards.
 *
 * Which round it lands on:
 *
 *   * an explicitly named round, if coord named one **and it has no verdict**;
 *   * otherwise the newest round, if that one is still pending — coord revising
 *     its own unsigned proposal is not a new round;
 *   * otherwise round N+1 — the first push after a verdict opens the next round,
 *     which is exactly "request changes always opens round N+1".
 *
 * A decided round is never the target. That is enforced twice: once here, and
 * once in SQL by the `WHERE NOT EXISTS (... signoffs ...)` on the upsert, so a
 * concurrent verdict landing between the read and the write still cannot rewrite
 * history.
 */
export async function roundStatementsForPush(
  env: Env,
  submissionReference: string,
  fields: Record<string, unknown>,
  revision: number,
  now: string,
): Promise<D1PreparedStatement[]> {
  const patch = readRoundPatch(fields)
  if (patch === null) return []

  const current = await getCurrentRound(env, submissionReference)

  let target = patch.round
  let base: DesignRound | null = null

  if (target !== null) {
    base = current && current.round === target ? current : await getRound(env, submissionReference, target)
  } else if (current && current.verdict === "pending") {
    target = current.round
    base = current
  }

  if (base !== null && base.verdict !== "pending") {
    // Coord aimed at a round the customer has already decided. Open the next one
    // instead of editing the record of what was agreed.
    target = Math.max(current?.round ?? base.round, base.round) + 1
    base = null
  }

  if (target === null) target = (current?.round ?? 0) + 1

  const outcomeDefinition = scrubEngineerIdentifiers(
    patch.outcomeDefinition ?? base?.outcomeDefinition ?? "",
  )
  const decomposition = patch.decomposition ?? base?.decomposition ?? []
  const mockBundle = patch.mockBundle ?? base?.mockBundle ?? null
  const openedAt = base?.openedAt ?? now

  return [
    env.DB.prepare(
      `INSERT INTO design_rounds
         (submission_id, round, outcome_definition, decomposition, mock_bundle, opened_at, coord_revision)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(submission_id, round) DO UPDATE SET
         outcome_definition = excluded.outcome_definition,
         decomposition      = excluded.decomposition,
         mock_bundle        = excluded.mock_bundle,
         coord_revision     = excluded.coord_revision
       WHERE NOT EXISTS (
         SELECT 1 FROM signoffs s
          WHERE s.submission_id = design_rounds.submission_id AND s.round = design_rounds.round
       )`,
    ).bind(
      submissionReference,
      target,
      outcomeDefinition,
      JSON.stringify(decomposition.map(scrubEngineerIdentifiers).filter((item) => item.length > 0)),
      mockBundle,
      openedAt,
      revision,
    ),
  ]
}

/**
 * Records the customer's verdict on one round and publishes it to the
 * coordinator as a `signoff.approved` / `signoff.changes_requested` bridge
 * event — in one `DB.batch()`, and idempotently against a doubled submit.
 *
 * Exactly the pattern `recordAnswer` uses (`src/questions.ts`), for exactly the
 * same reasons: the event insert is guarded by `WHERE NOT EXISTS (... signoffs
 * ...)`, evaluated before the verdict row below it lands, so a retry records
 * nothing and emits nothing while the first attempt records and emits both or
 * neither. One decision, one event — "replay-safe" is a property of the write,
 * not of the caller remembering to check first.
 *
 * Never touches `submissions.status`. Moving a submission off
 * `Awaiting your sign-off` for real is the coordinator's call, made the next
 * time it pushes a status; until then the screen derives what the customer
 * needs to see (see `derivedStatus`).
 */
export async function recordSignoff(
  env: Env,
  submissionReference: string,
  round: number,
  verdict: DecidedVerdict,
  comment: string | null,
): Promise<{ recorded: boolean }> {
  const decidedAt = new Date().toISOString()
  const type = verdict === "approved" ? "signoff.approved" : "signoff.changes_requested"

  const [eventInsert] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO bridge_events (id, type, submission_id, occurred_at, payload)
       SELECT ?, ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM signoffs WHERE submission_id = ? AND round = ?
        )`,
    ).bind(
      generateEventId(),
      type,
      submissionReference,
      decidedAt,
      JSON.stringify({ round, verdict, comment }),
      submissionReference,
      round,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO signoffs (submission_id, round, verdict, comment, decided_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(submissionReference, round, verdict, comment, decidedAt),
  ])

  return { recorded: (eventInsert?.meta.changes ?? 0) > 0 }
}
