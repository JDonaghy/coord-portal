import { getClientRecordByCcEmail, getClientRecordByEmail } from "./clients"
import type { AuthResult } from "./inboundEmail"
import { getProject, getProjectsByIds, listProjectsForClient, type Project } from "./projects"
import {
  getNewestSubmissionForProject,
  getSubmissionByReference,
  listSubmissionsForCustomer,
  type Submission,
  type SubmissionStatus,
} from "./submissions"
import type { Env } from "./types"

/**
 * The inbound router — issue #163 (EM-3 of milestone #5). "Given a parsed
 * inbound message, decide where it belongs. **Writes nothing.**"
 *
 * ── THE SPLIT: A PURE CORE, A THIN DATA-FETCHING SHELL ──────────────────────
 * #163 asks for "a pure exported function returning a decision ... so it can
 * be unit-tested exhaustively with no database" — and also for a module that
 * "reads from `src/clients.ts`, `src/projects.ts`, `src/submissions.ts`",
 * which necessarily means D1 reads somewhere. Both are true at once because
 * the module is two layers:
 *
 *   - `decideRoute` — synchronous, deterministic, zero I/O. Given the message
 *     and a `RoutingLookup` (every fact any rung could possibly need,
 *     already resolved to plain data), it walks the ladder and returns a
 *     `RoutingDecision`. This is what `test/inboundRouter.test.ts` drives
 *     directly, with hand-built `RoutingLookup` fixtures — no fake D1, no
 *     mocked bindings, exhaustive rung-by-rung coverage in milliseconds.
 *   - `routeInboundMessage` — the async shell. Fetches everything
 *     `RoutingLookup` needs via `clients.ts`/`projects.ts`/`submissions.ts`'s
 *     own read-only exports, eagerly (the ladder is cheap to evaluate fully;
 *     an inbound email is not a hot path), and hands the result to
 *     `decideRoute`. This is the one export a future EM-4/EM-5/EM-6 caller
 *     actually reaches for.
 *
 * ── NO MODEL RUNS HERE ───────────────────────────────────────────────────────
 * Every rung below is a lookup or a deterministic scoring rule over data this
 * portal already owns. Nothing here calls out to anything that could be
 * called "AI" — #163's own scope line: "the portal never runs one, and a
 * lead's text cannot cross the bridge to a fleet that could."
 *
 * ── RUNGS 3–5 REQUIRE AN AUTHENTICATED SENDER ───────────────────────────────
 * "Anyone can put any address in a `From:` header." Rungs 3, 4 and 5 resolve
 * an address into a *person* — the one thing spoofing must never buy for
 * free. `decideRoute` checks `message.authResult === "pass"` once, right
 * before those rungs, and anything else (`fail` or `none`) falls straight to
 * rung 6 as `unrouted` — never `lead`, because "unrouted" is a human's queue
 * and a wrongly-invented lead is not free to create.
 */

/** The rungs of the ladder, 1 (most trusted) through 6 (the safe default). */
export type RoutingRung = 1 | 2 | 3 | 4 | 5 | 6

/**
 * What a decision resolves to. Mirrors `inbound_emails.routed_kind`'s CHECK
 * constraint (`migrations/0020_inbound_emails.sql`) exactly, so a future
 * writer can store this value verbatim:
 *
 *  - `"message"` — a specific existing submission this inbound belongs to.
 *  - `"lead"` — nobody we know, cleanly: no reference, no client, no history.
 *    The safe default for a genuinely new contact (rung 6's own prose: "the
 *    default, and the safe one").
 *  - `"unrouted"` — we know *something* (a client, a history, a name) but
 *    not confidently enough to pick a target: a tie among equally-scored
 *    candidates, or a sender we cannot authenticate. Deliberately never
 *    `lead` — inventing a fresh lead for someone who may already be a
 *    customer is exactly the "split-brain" CLAUDE.md's ownership rule warns
 *    about, and an unauthenticated `From:` must not get the benefit of the
 *    doubt either way. A human looks at both from `/replies` (EM-6).
 */
export type RoutedKind = "lead" | "message" | "unrouted"

/**
 * Where a `"message"` decision attaches. Enough for a future writer to post a
 * reply against the right submission and for `/replies` (EM-6) to link
 * straight through — never more than that, since this router does no write
 * of its own.
 */
export interface RoutingTarget {
  submissionId: string
  submissionReference: string
  /** The project this submission belongs to, or `null` for a one-off request. */
  projectId: string | null
  /** The `clients` row behind this target, or `null` when none is known. */
  clientId: string | null
}

/**
 * The runner-up rung 4/5 scored but did not pick — #163's own words: "Return
 * the outcome, the rung, the reason, **and the runner-up** where rung 4
 * scored more than one candidate... an operator who cannot see why a match
 * was made cannot sensibly disagree with it." `null` whenever fewer than two
 * candidates were in play, or the winning rung was not 4 or 5.
 */
export interface RoutingRunnerUp {
  projectId: string | null
  submissionReference: string
  reason: string
}

/** The whole decision: what, why, at what rung, and who else was in the running. */
export interface RoutingDecision {
  kind: RoutedKind
  rung: RoutingRung
  /** Human-readable — what `/replies` (EM-6) shows an operator to justify the match. */
  reason: string
  /** Set exactly when `kind === "message"`. */
  target: RoutingTarget | null
  runnerUp: RoutingRunnerUp | null
}

/**
 * The facts about one inbound message the router needs — the fields of
 * `InboundEmailRecord` (`src/inboundEmail.ts`) that actually feed a rung.
 * A plain subset rather than the full record: the router has no use for an
 * id, a suppression reason or an attachment count.
 */
export interface InboundRoutingMessage {
  /** The `From:` header address, normalised lower-case — EM-1's `fromEmail`. */
  fromEmail: string
  /** The ENVELOPE recipient, not the `To:` header — EM-1's `toEmail`. Carries rung 1's plus-address token. */
  toEmail: string
  subject: string
  bodyText: string
  /** EM-1's DMARC verdict — gates rungs 3–5. */
  authResult: AuthResult
}

/**
 * One project-shaped option the scorer considered: a target a message could
 * attach to, plus the facts rung 4's scoring needs. Used both as the
 * "resolved" data a `RoutingLookup` carries in, and as what `decideRoute`
 * hands back as a winner or a runner-up.
 */
export interface RoutingCandidate {
  projectId: string | null
  projectName: string | null
  submissionId: string
  submissionReference: string
  status: SubmissionStatus
  createdAt: string
  clientId: string | null
}

/** Rung 2's quoted-reference outcome — a `SUB-XXXXXX` resolved (or not) against `submissions`, or a `LEAD-XXXXXX` left unresolved (see `decideRoute`'s own comment on why). */
export type QuotedReference =
  | { kind: "SUB"; token: string; submission: RoutingCandidate | null }
  | { kind: "LEAD"; token: string }

/**
 * Every fact any rung could need, already resolved to plain data — the
 * boundary between the async shell and the pure core. `routeInboundMessage`
 * builds one of these; `test/inboundRouter.test.ts` builds them by hand.
 */
export interface RoutingLookup {
  /** Rung 1: the submission the envelope recipient's plus-address token names, or `null` if there was no usable token or it named nothing real. */
  plusAddressSubmission: RoutingCandidate | null
  /** Rung 2: the first `SUB-`/`LEAD-` reference found in the subject, then the body — document order, first occurrence wins. */
  quotedReference: QuotedReference | null
  /** Rungs 3/4: the client this sender resolves to, direct or via `cc_emails` — `null` if neither matches. */
  matchedClientId: string | null
  matchedClientVia: "email" | "cc" | null
  /** How many projects that client has, *before* filtering to ones with a submission — what tells rung 3 ("one") apart from rung 4 ("several"). */
  clientProjectCount: number
  /** That client's projects that actually have a submission to attach to, each carrying its newest one — rung 4's scoring pool. */
  clientProjectCandidates: RoutingCandidate[]
  /** Rung 5: this exact sender's own prior projects/submissions where nothing links them to a `clients` row yet. Only ever populated when `matchedClientId` is `null`. */
  historyCandidates: RoutingCandidate[]
}

/**
 * The ladder itself. First match wins; every branch returns immediately, so
 * later rungs never run once an earlier one has resolved. See this module's
 * own top comment for why this function takes no `Env` and awaits nothing.
 */
export function decideRoute(message: InboundRoutingMessage, lookup: RoutingLookup): RoutingDecision {
  // Rung 1 — the address it was delivered to. No auth gate: the token is not
  // the `From:` header, it is which of *our own* minted addresses the sender
  // (or their mail server) copied back to us. This is also why it must be
  // checked before anything client- or history-based: a reply to a genuine
  // thread wins even when the `From:` identity looks like someone else
  // entirely (a forwarded copy, a delegate's mailbox) — "a plus-address
  // beating a contradictory sender identity" is #163's own acceptance case.
  if (lookup.plusAddressSubmission !== null) {
    const target = lookup.plusAddressSubmission
    return messageDecision(
      1,
      `Delivered to an address naming ${target.submissionReference} directly — this portal minted that address for this thread.`,
      target,
      null,
    )
  }

  // Rung 2 — a reference quoted in the subject or body, anywhere including
  // the quoted original. Also no auth gate, for the same reason: the
  // reference itself is the proof, not the sender's claimed identity.
  const quoted = lookup.quotedReference
  if (quoted !== null) {
    if (quoted.kind === "SUB" && quoted.submission !== null) {
      return messageDecision(
        2,
        `Quoted reference ${quoted.token} found in the subject or body.`,
        quoted.submission,
        null,
      )
    }
    if (quoted.kind === "LEAD") {
      // A `LEAD-XXXXXX` reference names a row in `leads`, which this module
      // deliberately never reads (#163's own file list). Recording the raw
      // token as the reason is enough to make good on the `/start` receipt's
      // promise ("just quote it in an email and it'll find its way back to
      // this") — resolving *what* it finds its way back to is a later
      // caller's job, one that does have `leads.ts` in scope.
      return leadDecision(2, `Quoted lead reference ${quoted.token} found in the subject or body.`)
    }
    // A `SUB-XXXXXX` was quoted but names no real submission (typo, or a
    // reference from a message this portal never sent) — not a match at this
    // rung. Fall through rather than stopping here: the ladder still has
    // rungs left that might resolve this sender by identity instead.
  }

  // Rungs 3–5 resolve an address into a person. Anyone can put any address in
  // a `From:` header, so none of them may fire without EM-1's DMARC pass.
  if (message.authResult !== "pass") {
    return unroutedDecision(
      6,
      "DMARC did not pass for this sender's address — rungs 3–5 only resolve an address into a person once EM-1 has recorded a DMARC pass, and this message carries none. Spoofing an address must not buy a match.",
    )
  }

  // Rung 3 / Rung 4 — a known client, one project or several. Both share one
  // scorer; what tells them apart is `clientProjectCount`, the client's *raw*
  // project count, not how many ended up with a submission to attach to.
  if (lookup.matchedClientId !== null) {
    const via = lookup.matchedClientVia === "cc" ? "a cc_emails entry" : "their own address"
    if (lookup.clientProjectCount === 0) {
      return unroutedDecision(
        6,
        `Sender matches a known client (via ${via}), but that client has no project yet.`,
      )
    }
    const rung: RoutingRung = lookup.clientProjectCount === 1 ? 3 : 4
    const picked = pickCandidate(lookup.clientProjectCandidates, message.subject)
    if (picked.outcome === "none") {
      return unroutedDecision(
        6,
        `Sender matches a known client (via ${via}), but none of their ${
          lookup.clientProjectCount === 1 ? "one project" : `${lookup.clientProjectCount} projects`
        } has a submission to attach to yet.`,
      )
    }
    if (picked.outcome === "tie") {
      return unroutedDecision(
        6,
        `Sender matches a known client with several projects, and more than one scored equally as the best match for this message — a tie is not a winner, so this is parked for a human.`,
        picked.second,
      )
    }
    return messageDecision(
      rung,
      rung === 3
        ? `Sender matches a known client (via ${via}) with exactly one project.`
        : `Sender matches a known client (via ${via}) with several projects; ${describeCandidate(picked.winner)} scored best.`,
      picked.winner,
      picked.runnerUp,
    )
  }

  // Rung 5 — sender wrote in before, but 0016 never backfilled a `clients`
  // row for them. Same scorer as rung 4, over whatever this address's own
  // history offers instead of a client's project list.
  const historyPicked = pickCandidate(lookup.historyCandidates, message.subject)
  if (historyPicked.outcome === "winner") {
    return messageDecision(
      5,
      `Sender has written in before (no \`clients\` row yet); ${describeCandidate(historyPicked.winner)} scored best.`,
      historyPicked.winner,
      historyPicked.runnerUp,
    )
  }
  if (historyPicked.outcome === "tie") {
    return unroutedDecision(
      6,
      "This address has written in before under more than one project, and more than one scored equally as the best match for this message — a tie is not a winner, so this is parked for a human.",
      historyPicked.second,
    )
  }

  // Rung 6 — nobody we know, and nothing ambiguous either: no reference, no
  // client, no history. The clean, safe default.
  return leadDecision(6, "No reference, no matching client, and no prior message from this address.")
}

function describeCandidate(candidate: RoutingCandidate): string {
  return candidate.projectName
    ? `the project "${candidate.projectName}"`
    : `submission ${candidate.submissionReference}`
}

function messageDecision(
  rung: RoutingRung,
  reason: string,
  candidate: RoutingCandidate,
  runnerUp: RoutingCandidate | null,
): RoutingDecision {
  return {
    kind: "message",
    rung,
    reason,
    target: {
      submissionId: candidate.submissionId,
      submissionReference: candidate.submissionReference,
      projectId: candidate.projectId,
      clientId: candidate.clientId,
    },
    runnerUp: describeRunnerUp(runnerUp),
  }
}

function leadDecision(rung: RoutingRung, reason: string): RoutingDecision {
  return { kind: "lead", rung, reason, target: null, runnerUp: null }
}

/**
 * `runnerUp` is optional and only ever supplied by the *tie* branches: a tie is
 * the one unrouted outcome where the router genuinely had a second candidate it
 * declined to pick, which is exactly the contract's presence rule for
 * `reply-route-runner-up` ("rung 4's scoring case, and the unrouted case"). A
 * DMARC failure or a client with no projects has nothing to be a runner-up to,
 * and inventing one there would tell an operator the router weighed options it
 * never saw.
 */
function unroutedDecision(
  rung: RoutingRung,
  reason: string,
  runnerUp: RoutingCandidate | null = null,
): RoutingDecision {
  return { kind: "unrouted", rung, reason, target: null, runnerUp: describeRunnerUp(runnerUp) }
}

function describeRunnerUp(candidate: RoutingCandidate | null): RoutingRunnerUp | null {
  if (candidate === null) return null
  // `describeCandidate` already renders the reference verbatim when there is
  // no project name (`submission SUB-XXXXXX`) — appending
  // `(${submissionReference})` in that case would repeat it right back,
  // e.g. "submission SUB-XXXXXX (SUB-XXXXXX)". The parenthetical is only
  // useful, and only added, when `describeCandidate` said something else
  // (the project name) that the reference itself is not already part of.
  const description = describeCandidate(candidate)
  const reason = candidate.projectName
    ? `Also scored, but not picked: ${description} (${candidate.submissionReference}).`
    : `Also scored, but not picked: ${description}.`
  return { projectId: candidate.projectId, submissionReference: candidate.submissionReference, reason }
}

// ── SCORING (rungs 4 and 5 share this) ──────────────────────────────────────

/**
 * "A project whose newest submission is in a state waiting on the customer
 * ... beats one that is not" (#163). These three are the customer-actionable
 * or customer-blocking states — not derived from `isActionableStatus`
 * (`src/submissions.ts`), which is a different, narrower set (only the two
 * states a customer can act *on*): this list is #163's own, pinned by the
 * issue text, not by that module's vocabulary.
 */
const WAITING_ON_CUSTOMER = new Set<SubmissionStatus>(["awaiting-signoff", "needs-input", "quality-check"])

function isWaitingOnCustomer(status: SubmissionStatus): boolean {
  return WAITING_ON_CUSTOMER.has(status)
}

function wordsOf(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 0),
  )
}

/** Count of distinct words the subject line and the project name share. `0` for an unnamed project — nothing to overlap with. */
function wordOverlap(subject: string, projectName: string | null): number {
  if (projectName === null) return 0
  const subjectWords = wordsOf(subject)
  let overlap = 0
  for (const word of wordsOf(projectName)) {
    if (subjectWords.has(word)) overlap++
  }
  return overlap
}

/** `[waiting-on-customer, newest-first, word-overlap]` — compared in exactly that order, per #163's own "in this order." */
type Score = readonly [waiting: 0 | 1, createdAt: string, overlap: number]

function scoreOf(candidate: RoutingCandidate, subject: string): Score {
  return [
    isWaitingOnCustomer(candidate.status) ? 1 : 0,
    candidate.createdAt,
    wordOverlap(subject, candidate.projectName),
  ]
}

/** Negative when `a` outranks `b`. `createdAt` is ISO-8601, so string comparison already sorts chronologically. */
function compareScores(a: Score, b: Score): number {
  if (a[0] !== b[0]) return b[0] - a[0]
  if (a[1] !== b[1]) return a[1] < b[1] ? 1 : -1
  return b[2] - a[2]
}

type PickResult =
  | { outcome: "none" }
  /** `second` is the other half of the tie — recorded so `/replies` can show an operator both of the things the router refused to choose between. */
  | { outcome: "tie"; second: RoutingCandidate }
  | { outcome: "winner"; winner: RoutingCandidate; runnerUp: RoutingCandidate | null }

/**
 * Ranks every candidate and picks a winner — or refuses to. "A tie is not a
 * winner" (#163): when the top two candidates score identically on all three
 * criteria, `outcome` is `"tie"`, never a coin-flip winner. Shared verbatim by
 * rungs 4 and 5, which differ only in where their candidates came from.
 */
function pickCandidate(candidates: RoutingCandidate[], subject: string): PickResult {
  if (candidates.length === 0) return { outcome: "none" }
  const ranked = [...candidates].sort((a, b) => compareScores(scoreOf(a, subject), scoreOf(b, subject)))
  const first = ranked[0]!
  const second = ranked[1]
  if (second !== undefined && compareScores(scoreOf(first, subject), scoreOf(second, subject)) === 0) {
    return { outcome: "tie", second }
  }
  return { outcome: "winner", winner: first, runnerUp: second ?? null }
}

// ── EXTRACTION (pure — no I/O, exhaustively unit-testable on its own) ──────

/**
 * `SUB-XXXXXX` / `LEAD-XXXXXX`, where `XXXXXX` is six characters of
 * `[A-Z0-9]`.
 *
 * ── WHY `[A-Z0-9]` AND NOT `[0-9A-F]` ──────────────────────────────────────
 * `generateSubmissionReference` / `generateLeadReference` (`src/ids.ts`)
 * happen to mint six upper-case *hex* characters today, and an earlier draft
 * of this pattern matched exactly that. That was a bug: hex is an
 * implementation detail of one minting function, while `[A-Z0-9]` is the
 * alphabet the *reference format itself* is pinned to — `src/ids.ts`'s own
 * doc says so ("a subset of `[A-Z0-9]`, the alphabet the contract and mock
 * both use"), the ms-5 contract writes it as `SUB-XXXXXX`, and every existing
 * spec in `e2e/` asserts `/^SUB-[A-Z0-9]{6}$/`, never `[0-9A-F]`.
 *
 * Recognising only today's narrower alphabet means the day anyone widens the
 * mint — or seeds a reference from anywhere else — the router silently stops
 * matching a reference a customer is quoting back verbatim off a receipt this
 * portal printed for them, and the failure looks like "rung 6, nobody we
 * know" rather than like a bug. Matching the pinned public format instead
 * costs nothing: an unresolvable `SUB-` token already falls through the
 * ladder rather than being treated as a match.
 *
 * Case-insensitive because a human quoting one back may not preserve the
 * case; callers normalise to upper-case.
 */
const REFERENCE_PATTERN = /\b(SUB|LEAD)-([A-Za-z0-9]{6})\b/i

export interface ExtractedReference {
  kind: "SUB" | "LEAD"
  /** Normalised: `SUB-` or `LEAD-` followed by six upper-case hex characters. */
  token: string
}

/**
 * Rung 1 — the envelope recipient's plus-address token, e.g.
 * `intake+SUB-C467AA@mail.heurontech.com`. Only the local part before the
 * first `+` is a prefix; everything after it must be *exactly* one reference,
 * not merely contain one, since this is the address the customer's mail
 * client will have copied back verbatim from what EM-8 minted.
 *
 * EM-8 only ever mints a `SUB-` plus-address for a submission thread (#163's
 * own words: "the reference is in the envelope recipient, because we minted
 * it"). A `LEAD-` token here would not be this rung's to resolve — a lead has
 * no thread to reply into — so it is treated the same as no usable token at
 * all: `null`, and the ladder moves on rather than guessing.
 */
export function extractPlusAddressReference(toEmail: string): ExtractedReference | null {
  const local = toEmail.split("@")[0] ?? ""
  const plusIndex = local.indexOf("+")
  if (plusIndex < 0) return null
  const candidate = local.slice(plusIndex + 1)
  // Anchored, not `REFERENCE_PATTERN`: everything after the first `+` must be
  // *exactly* one reference, not merely contain one — see this function's own
  // doc. Same `[A-Z0-9]` alphabet, for the same reason.
  const match = /^(SUB|LEAD)-([A-Za-z0-9]{6})$/i.exec(candidate)
  if (match === null) return null
  const kind = match[1]!.toUpperCase() as "SUB" | "LEAD"
  if (kind !== "SUB") return null
  return { kind, token: `${kind}-${match[2]!.toUpperCase()}` }
}

/**
 * Rung 2 — the first `SUB-`/`LEAD-` reference found anywhere across the given
 * texts, in the order the caller passes them (subject, then body, so a
 * reference in the subject line wins over one buried in a quoted signature).
 * "Anywhere including the quoted original" (#163) — this function does not
 * try to strip quoted text out first; a reference is a reference wherever it
 * sits.
 */
export function findQuotedReference(...texts: string[]): ExtractedReference | null {
  for (const text of texts) {
    const match = REFERENCE_PATTERN.exec(text)
    if (match !== null) {
      const kind = match[1]!.toUpperCase() as "SUB" | "LEAD"
      return { kind, token: `${kind}-${match[2]!.toUpperCase()}` }
    }
  }
  return null
}

// ── THE ASYNC SHELL ──────────────────────────────────────────────────────────

/**
 * The one export a caller actually reaches for: resolves every fact
 * `decideRoute` could need, then hands off to it. Read-only throughout — see
 * this module's own top comment.
 */
export async function routeInboundMessage(env: Env, message: InboundRoutingMessage): Promise<RoutingDecision> {
  const lookup = await buildRoutingLookup(env, message)
  return decideRoute(message, lookup)
}

async function buildRoutingLookup(env: Env, message: InboundRoutingMessage): Promise<RoutingLookup> {
  const plusAddress = extractPlusAddressReference(message.toEmail)
  const plusAddressSubmission = plusAddress !== null ? await candidateFromReference(env, plusAddress.token) : null

  const quotedRef = findQuotedReference(message.subject, message.bodyText)
  let quotedReference: RoutingLookup["quotedReference"] = null
  if (quotedRef !== null) {
    quotedReference =
      quotedRef.kind === "SUB"
        ? { kind: "SUB", token: quotedRef.token, submission: await candidateFromReference(env, quotedRef.token) }
        : { kind: "LEAD", token: quotedRef.token }
  }

  let matchedClientId: string | null = null
  let matchedClientVia: "email" | "cc" | null = null
  const direct = await getClientRecordByEmail(env, message.fromEmail)
  if (direct !== null) {
    matchedClientId = direct.id
    matchedClientVia = "email"
  } else {
    const viaCc = await getClientRecordByCcEmail(env, message.fromEmail)
    if (viaCc !== null) {
      matchedClientId = viaCc.id
      matchedClientVia = "cc"
    }
  }

  let clientProjectCount = 0
  let clientProjectCandidates: RoutingCandidate[] = []
  if (matchedClientId !== null) {
    const projects = await listProjectsForClient(env, matchedClientId)
    clientProjectCount = projects.length
    clientProjectCandidates = await candidatesFromProjects(env, projects, matchedClientId)
  }

  const historyCandidates = matchedClientId === null ? await candidatesFromHistory(env, message.fromEmail) : []

  return {
    plusAddressSubmission,
    quotedReference,
    matchedClientId,
    matchedClientVia,
    clientProjectCount,
    clientProjectCandidates,
    historyCandidates,
  }
}

async function candidateFromReference(env: Env, reference: string): Promise<RoutingCandidate | null> {
  const submission = await getSubmissionByReference(env, reference)
  return submission === null ? null : toCandidate(env, submission)
}

/**
 * A submission resolved by reference (rungs 1/2) carries no client on its
 * face — its `clientId` is resolved the same way `createSubmission`
 * (`src/submissions.ts`) already derives one at write time: via its project's
 * `client_id` first, falling back to a direct email match for a submission
 * with no project at all.
 */
async function toCandidate(env: Env, submission: Submission): Promise<RoutingCandidate> {
  let projectName: string | null = null
  let clientId: string | null = null
  if (submission.projectId !== null) {
    const project = await getProject(env, submission.projectId)
    projectName = project?.name ?? null
    clientId = project?.clientId ?? null
  }
  if (clientId === null && submission.customerEmail !== null) {
    const client = await getClientRecordByEmail(env, submission.customerEmail)
    clientId = client?.id ?? null
  }
  return {
    projectId: submission.projectId,
    projectName,
    submissionId: submission.id,
    submissionReference: submission.reference,
    status: submission.status,
    createdAt: submission.createdAt,
    clientId,
  }
}

/** Rung 3/4's candidate pool: one of the client's projects, per its newest submission. A project with no submissions yet has nothing to attach a message to and is skipped. */
async function candidatesFromProjects(
  env: Env,
  projects: Project[],
  clientId: string,
): Promise<RoutingCandidate[]> {
  const candidates: RoutingCandidate[] = []
  for (const project of projects) {
    const newest = await getNewestSubmissionForProject(env, project.id)
    if (newest === null) continue
    candidates.push({
      projectId: project.id,
      projectName: project.name,
      submissionId: newest.id,
      submissionReference: newest.reference,
      status: newest.status,
      createdAt: newest.createdAt,
      clientId,
    })
  }
  return candidates
}

/**
 * Rung 5's candidate pool: this exact address's own prior submissions, newest
 * first, grouped by project — but only a project 0016 never backfilled a
 * `clients` row for (`client_id IS NULL`). A project some *other* client
 * already owns is not rung 5's to match (and could not reach this function
 * anyway: `buildRoutingLookup` only calls it when `matchedClientId` is
 * `null`, i.e. this exact address matched no client directly or via
 * `cc_emails` — a defensive second check here costs one field read and closes
 * off a stale or shared project ever being claimed by the wrong address's
 * history). A submission with no project at all (`project_id IS NULL`, an
 * ordinary one-off ask) is its own candidate — #109's own rule that a bare
 * email match must never silently fold two unrelated asks together applies
 * here too, so it is never merged into anything.
 *
 * ── CASE-SENSITIVITY: AN UNASSERTED CROSS-MODULE ASSUMPTION ────────────────
 * `listSubmissionsForCustomer` (`src/submissions.ts`) below matches on plain
 * `customer_email = ?` — no `lower()` — whereas rungs 3/4's client match
 * (`getClientRecordByEmail`/`getClientRecordByCcEmail`, `src/clients.ts`)
 * is explicitly case-insensitive. This does not read a `RoutingLookup` field
 * of its own to compensate: `message.fromEmail` arrives here already
 * lower-cased by `normaliseAddress` (`src/inboundEmail.ts`), and every
 * `customer_email` this repo's own write paths persist is, in practice, the
 * same already-lower-cased value (the caller's Access identity, read the
 * same way `dashboard.ts`/`submission.ts` scope a customer's own rows).
 * Nothing in this module — or in `submissions.ts`, which #163 does not own
 * and adds no write path to — enforces that as an invariant, though, so a
 * `customer_email` written with mixed case by some future path would
 * silently fall through rung 5 to rung 6 rather than matching. Flagged, not
 * fixed, here: fixing it means widening `listSubmissionsForCustomer`'s own
 * query (a function with callers well outside rung 5), which is a call for
 * whoever owns `submissions.ts`, not a rung-5-local patch.
 */
async function candidatesFromHistory(env: Env, fromEmail: string): Promise<RoutingCandidate[]> {
  const submissions = await listSubmissionsForCustomer(env, fromEmail)
  if (submissions.length === 0) return []

  const projectIds = [...new Set(submissions.map((s) => s.projectId).filter((id): id is string => id !== null))]
  const projects = await getProjectsByIds(env, projectIds)

  const seenProjects = new Set<string>()
  const candidates: RoutingCandidate[] = []
  for (const submission of submissions) {
    if (submission.projectId === null) {
      candidates.push({
        projectId: null,
        projectName: null,
        submissionId: submission.id,
        submissionReference: submission.reference,
        status: submission.status,
        createdAt: submission.createdAt,
        clientId: null,
      })
      continue
    }
    if (seenProjects.has(submission.projectId)) continue // already took this project's newest — `submissions` is newest-first.
    const project = projects.get(submission.projectId)
    if (project === undefined || project.clientId !== null) continue
    seenProjects.add(submission.projectId)
    candidates.push({
      projectId: project.id,
      projectName: project.name,
      submissionId: submission.id,
      submissionReference: submission.reference,
      status: submission.status,
      createdAt: submission.createdAt,
      clientId: null,
    })
  }
  return candidates
}
