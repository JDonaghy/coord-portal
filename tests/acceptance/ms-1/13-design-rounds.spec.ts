import { expect, test, type APIRequestContext, type Page } from "@playwright/test"

/**
 * ms-1 sealed acceptance slice — issue #13
 * "[portal] Design rounds + versioned sign-off loop (mocks)"
 *
 * Written from `tests/acceptance/ms-1/contract.md` (§ "Design-round / sign-off
 * loop (pinned, from issue #13)", the `Awaiting-sign-off (05)` /
 * `Request-changes composer (06)` / `Round history (07)` hook blocks, the status
 * vocabulary table and the sole-writer ownership table) and from the three mocks
 * it pins — `mocks/05-submission-awaiting-signoff.html`,
 * `mocks/06-request-changes.html`, `mocks/07-round-history.html` — without sight
 * of any implementation.
 *
 * THE SHAPE UNDER TEST. Issue #13 is an iteration loop with a memory:
 *
 *   PROPOSE   coord authors a design round — a plain-language outcome
 *             definition, a proposed decomposition, and a mock bundle where the
 *             change is visible — and parks the submission at
 *             `Awaiting your sign-off`. All three are coord-owned facts
 *             (`design_round`, `decomposition`, `artifacts`) and arrive over the
 *             bridge; the portal never invents a proposal.
 *   DECIDE    the customer approves, or requests changes with a comment.
 *             `signoff_verdict` / `signoff_comment` are portal-owned, so the
 *             decision is a customer-authored fact and leaves as a
 *             `signoff.approved` / `signoff.changes_requested` event.
 *   REMEMBER  requesting changes opens round N+1 and returns the submission to
 *             `In design`. It "never mutates round N in place", and "every
 *             previous round stays readable" at `/submissions/:id/rounds` —
 *             the contract calls this "the audit trail of what was agreed", so
 *             a round that quietly rewrites itself is the central failure this
 *             slice exists to catch.
 *
 * MECHANISM. A design round is coord-owned, so the only black-box way to put one
 * on screen is a bridge push (#15's surface); the only way to author a
 * submission is #9's pinned intake form; and the only black-box read-back of the
 * customer's decision is #15's event stream. Those are instruments here, not
 * subjects — the same arrangement `11-question-channel.spec.ts` uses, and for
 * the same reason.
 *
 * NOT COVERED HERE, deliberately:
 *  - **Whether #13 reuses #11's raise -> pause -> resume substrate.** Issue #11
 *    asks for it and the contract explicitly declines to make it a black-box
 *    constraint ("This contract does not force a single shared DOM structure
 *    between `08-submission-needs-input.html` and the sign-off screens"). Shared
 *    components are invisible from outside, so nothing below asserts them.
 *  - **What happens engineer-side on sign-off** — the outcome definition
 *    becoming a Gate-A contract, the epic and `status:ready` issues being minted
 *    through the forge seam. That is entirely coord-side; from this repo it is
 *    only ever "a `signoff.approved` event was published".
 *  - **Emails.** Whether a round opening or a sign-off lands in the digest is
 *    issue #14's slice.
 *  - **Generic bridge mechanics** (401s, cursors, batch ordering) — #15's slice
 *    owns those. Only the `signoff_*` ownership pair, which is #13's own delta,
 *    is asserted here.
 *
 * SYNTHETIC DATA. Per CLAUDE.md rule 1, the contract's "Synthetic data" section
 * and issue #13's own "The repo is public … no real customer material may be
 * committed", every submission, round, decomposition and comment below is
 * invented.
 */

const CUSTOMER_EMAIL = "ada@example.test"

/**
 * The daemon's service-token credential.
 *
 * TODO(test-author): identical to the note in `15-sync-bridge.spec.ts` and
 * `11-question-channel.spec.ts` — the contract pins the two header names and
 * pins missing/invalid ⇒ 401, but not how a Worker booted by
 * `npm run serve:acceptance` (no Access in front of it) learns which pair is
 * valid. Same escape hatch: export `COORD_BRIDGE_CLIENT_ID` /
 * `COORD_BRIDGE_CLIENT_SECRET` and this suite presents those instead. The
 * defaults are invented, not a credential.
 */
const SERVICE_TOKEN = {
  "CF-Access-Client-Id":
    process.env.COORD_BRIDGE_CLIENT_ID ?? "9f2c17b4a8de40518c6b3ad0e75f1c62.access",
  "CF-Access-Client-Secret":
    process.env.COORD_BRIDGE_CLIENT_SECRET ??
    "4d1e9c07b35a2f68e4c81079ba6d35f2c9017e4ab8d562309fc71ea48b0d63a5",
}

const REFERENCE = /^SUB-[A-Z0-9]{6}$/

/** Contract § status vocabulary: slug → exact customer-visible text. */
const AWAITING_SIGNOFF_TEXT = "Awaiting your sign-off"
const IN_DESIGN_TEXT = "In design"

/**
 * Contract § "Design-round / sign-off loop": "Approve is the only action that
 * can move a submission past `Awaiting your sign-off` toward `Planned`."
 *
 * TODO(test-author): "toward `Planned`" is deliberately hedged — the contract
 * does not pin that approving lands exactly on `planned` rather than somewhere
 * further along the ordered vocabulary. So approval is asserted to leave
 * `awaiting-signoff` for a state that is FORWARD of it in the contract's ordered
 * table, not to equal one specific slug.
 */
const FORWARD_OF_SIGNOFF = ["planned", "in-progress", "quality-check", "shipped"]

/** Contract § `data-testid` hooks — the pinned hooks of screen 05. */
const SIGNOFF_TESTIDS = [
  "design-round",
  "round-number",
  "round-history-link",
  "outcome-definition",
  "decomposition-list",
  "mock-bundle-link",
  "approve-button",
  "request-changes-button",
]

/** Contract § `data-testid` hooks — the pinned hooks of the composer, screen 06. */
const COMPOSER_TESTIDS = [
  "request-changes-form",
  "changes-comment",
  "next-round-note",
  "cancel-changes",
  "submit-changes",
]

/** The two decisions this milestone lets a customer make about a round. */
const DECISION_TESTIDS = ["approve-button", "request-changes-button"]

/** Contract § Round history (07): the pinned verdict vocabulary. */
const VERDICTS = ["pending", "approved", "changes-requested"]

interface BridgeEvent {
  id: string
  revision: number
  type: string
  submission_id: string
  occurred_at: string
  payload: unknown
}

interface PullPage {
  events: BridgeEvent[]
  cursor: string | null
  has_more: boolean
}

interface PushResult {
  submission_id: string
  outcome: string
  reason?: string
}

// ── bridge transport (the instrument, not the subject) ──────────────────────

async function pullPage(
  request: APIRequestContext,
  opts: { cursor?: string | null; limit?: number } = {},
): Promise<PullPage> {
  const params: Record<string, string> = {}
  if (opts.cursor != null) params.cursor = opts.cursor
  if (opts.limit != null) params.limit = String(opts.limit)
  const res = await request.get("/api/bridge/pull", { params, headers: SERVICE_TOKEN })
  expect(res.status(), "a pull with a valid service token is 200").toBe(200)
  const body = (await res.json()) as PullPage
  expect(Array.isArray(body.events), "`events` is an array").toBe(true)
  return body
}

/**
 * Read the stream to its end and return the cursor that now points past every
 * event, so each test can establish its own baseline. The acceptance database is
 * wiped per *run*, not per *test* (tests/acceptance/README.md § Determinism).
 */
async function drainToCursor(request: APIRequestContext): Promise<string | null> {
  let cursor: string | null = null
  for (let page = 0; page < 100; page++) {
    const body = await pullPage(request, { cursor, limit: 200 })
    if (typeof body.cursor === "string" && body.cursor.length > 0) cursor = body.cursor
    if (!body.has_more) return cursor
    expect(
      body.events.length,
      "`has_more: true` with no events would page forever",
    ).toBeGreaterThan(0)
  }
  throw new Error("pull never reported has_more:false — the cursor is not advancing")
}

/** Every event after `cursor`, paged to exhaustion. */
async function eventsSince(
  request: APIRequestContext,
  cursor: string | null,
): Promise<BridgeEvent[]> {
  const collected: BridgeEvent[] = []
  let at = cursor
  for (let page = 0; page < 100; page++) {
    const body = await pullPage(request, { cursor: at, limit: 200 })
    collected.push(...body.events)
    if (!body.has_more) return collected
    at = body.cursor
  }
  throw new Error("pull never reported has_more:false — the cursor is not advancing")
}

async function pushFields(
  request: APIRequestContext,
  submissionId: string,
  revision: number,
  fields: Record<string, unknown>,
): Promise<PushResult> {
  const res = await request.post("/api/bridge/push", {
    data: { updates: [{ submission_id: submissionId, revision, fields }] },
    headers: SERVICE_TOKEN,
  })
  // Contract trap: ownership violations and stale revisions are per-item
  // outcomes inside a 200, never transport failures.
  expect(res.status(), "a push with a valid service token is 200").toBe(200)
  const body = (await res.json()) as { results: PushResult[] }
  expect(body.results, "one result per update").toHaveLength(1)
  return body.results[0]
}

// ── design rounds, authored the only way coord can ──────────────────────────

interface RoundSeed {
  round: number
  outcome: string
  decomposition: string[]
  mockBundleUrl: string
}

/**
 * PROPOSE: one atomic push carrying the whole round plus the status that parks
 * it in front of the customer.
 *
 * All in ONE update on purpose. Issue #10's slice pins that the portal "renders
 * and does not derive", so a pushed `design_round` alone must not make the
 * portal decide the status is `awaiting-signoff`; and whole-update atomicity
 * (contract § push) means the customer never sees half a proposal.
 *
 * TODO(test-author): **the contract pins that coord owns `design_round`,
 * `decomposition` and `artifacts`, but pins no value TYPE for any of them.** The
 * shape below is the literal reading of contract § "Design-round / sign-off
 * loop" — "A design round carries: a plain-language outcome definition, a
 * proposed decomposition (rendered as a plain-text list of work items) … and a
 * mock bundle link" — mapped onto the three coord-owned fields in the only way
 * that fits: the round envelope in `design_round`, the list in `decomposition`,
 * the bundle in `artifacts`. Nothing downstream of this helper depends on the
 * guess: every assertion below is on the rendered DOM and on the event stream,
 * which contract note 3 makes the real contract ("the DOM is the contract, not
 * an inferred JSON schema"). If #13 lands a different wire shape for a round,
 * THIS FUNCTION is the only thing that should need changing.
 */
async function pushDesignRound(
  request: APIRequestContext,
  reference: string,
  revision: number,
  seed: RoundSeed,
): Promise<void> {
  const result = await pushFields(request, reference, revision, {
    design_round: {
      round: seed.round,
      outcome_definition: seed.outcome,
      mock_bundle_url: seed.mockBundleUrl,
    },
    decomposition: seed.decomposition,
    artifacts: [{ kind: "mock-bundle", url: seed.mockBundleUrl }],
    status: "awaiting-signoff",
  })
  expect(
    result.outcome,
    "`design_round`, `decomposition`, `artifacts` and `status` are all coord-owned",
  ).toBe("applied")
}

// ── synthetic material ──────────────────────────────────────────────────────

const SEEDS = [
  {
    outcome: "A printable watering rota for the community greenhouse.",
    audience: "our Saturday volunteers",
    doneDefinition: "Anyone on shift can see which beds are due without asking.",
  },
  {
    outcome: "A monthly note listing tools that were never returned.",
    audience: "the workshop steward",
    doneDefinition: "The steward gets one list on the first of the month.",
  },
  {
    outcome: "A shared list of which raised beds are free to claim.",
    audience: "new plot holders",
    doneDefinition: "A new plot holder can pick a free bed unaided.",
  },
  {
    outcome: "A weekly count of visitors to the seed library.",
    audience: "our trustees",
    doneDefinition: "The trustees see one number per week, no spreadsheet.",
  },
]

/**
 * Three rounds of the same synthetic proposal, each visibly different from the
 * last. The differences matter: "never mutates round N in place" is only
 * testable if round N's text is distinguishable from round N+1's.
 */
const ROUNDS: RoundSeed[] = [
  {
    round: 1,
    outcome: "Volunteers can see a watering rota for the greenhouse on their phone.",
    decomposition: [
      "A rota page showing who waters which beds this week",
      "A way for a volunteer to swap a shift with someone else",
    ],
    mockBundleUrl: "https://mocks.example.test/rota/round-1/",
  },
  {
    round: 2,
    outcome:
      "Volunteers can see a watering rota on their phone AND print a paper copy for the shed door.",
    decomposition: [
      "A rota page showing who waters which beds this week",
      "A way for a volunteer to swap a shift with someone else",
      "A printable one-page version sized for the shed noticeboard",
    ],
    mockBundleUrl: "https://mocks.example.test/rota/round-2/",
  },
  {
    round: 3,
    outcome:
      "Volunteers can see and print the rota, and the printed copy shows who to call about a swap.",
    decomposition: [
      "A rota page showing who waters which beds this week",
      "A way for a volunteer to swap a shift with someone else",
      "A printable one-page version sized for the shed noticeboard",
      "A contact line on the printed copy for swap questions",
    ],
    mockBundleUrl: "https://mocks.example.test/rota/round-3/",
  },
]

/** Synthetic change requests — plain customer language, no engineer vocabulary. */
const CHANGE_COMMENTS = [
  "This has to work on paper too — half the volunteers never open their phone in the greenhouse.",
  "Please put a phone number on the printed sheet so people know who to ask about a swap.",
]

// ── seeding and reading, through the pinned customer surface ────────────────

/** The verified-identity mechanism the contract's screens assume is present. */
function asCustomer(page: Page, email: string = CUSTOMER_EMAIL) {
  return page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": email })
}

interface Seeded {
  url: string
  reference: string
}

/** Author one submission through the pinned intake form (#9's surface). */
async function seedSubmission(page: Page, n: number): Promise<Seeded> {
  const seed = SEEDS[n % SEEDS.length]
  await page.goto("/intake")
  await page.getByTestId("field-outcome").fill(seed.outcome)
  await page.getByTestId("field-audience").fill(seed.audience)
  await page.getByTestId("field-done-definition").fill(seed.doneDefinition)
  await page.getByTestId("submit-intake").click()
  await expect(page.getByTestId("intake-receipt")).toBeVisible()

  const shown = (await page.getByTestId("submission-reference").innerText()).trim()
  const reference = shown.replace(/^Reference\s+/, "")
  expect(reference, "the receipt shows a SUB-XXXXXX reference").toMatch(REFERENCE)
  return { url: page.url(), reference }
}

/** Collapse the incidental whitespace of rendered HTML before comparing copy. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

/** The status slug the customer is actually shown on a detail screen. */
async function readStatus(page: Page, url: string): Promise<string | null> {
  await page.goto(url)
  await expect(page.getByTestId("submission-detail")).toBeVisible()
  return page.getByTestId("status-pill").getAttribute("data-status")
}

/**
 * DECIDE, request-changes half: open the composer, write the comment, submit.
 *
 * Contract note 3 leaves the transport of this write entirely unpinned, so
 * nothing here assumes a navigation, a form POST or a fetch — the caller waits
 * on an observable consequence (the event, or the round history), never on a
 * mechanism.
 */
async function requestChanges(page: Page, url: string, comment: string): Promise<void> {
  await page.goto(url)
  const button = page.getByTestId("request-changes-button")
  await expect(
    button,
    "an awaiting-sign-off round offers Request changes",
  ).toBeVisible()
  await button.click()
  const form = page.getByTestId("request-changes-form")
  await expect(form, "the request-changes button opens the composer").toBeVisible()
  await page.getByTestId("changes-comment").fill(comment)
  await page.getByTestId("submit-changes").click()
}

/** DECIDE, approve half. */
async function approve(page: Page, url: string): Promise<void> {
  await page.goto(url)
  const button = page.getByTestId("approve-button")
  await expect(button, "an awaiting-sign-off round offers Approve").toBeVisible()
  await button.click()
}

interface HistoryRow {
  round: number
  verdict: string | null
  text: string
  comment: string | null
}

/** Read `/submissions/:id/rounds` into comparable rows, newest-first or not. */
async function readHistory(page: Page, detailUrl: string): Promise<HistoryRow[]> {
  await page.goto(`${detailUrl}/rounds`)
  const history = page.getByTestId("round-history")
  await expect(history, "the round history renders at /submissions/:id/rounds").toBeVisible()

  const entries = page.getByTestId("round-entry")
  const count = await entries.count()
  const rows: HistoryRow[] = []
  for (let i = 0; i < count; i++) {
    const entry = entries.nth(i)
    const round = await entry.getAttribute("data-round")
    expect(round, "every round entry is numbered").not.toBeNull()
    const comment = entry.getByTestId("round-comment")
    rows.push({
      round: Number(round),
      verdict: await entry.getAttribute("data-verdict"),
      text: flat(await entry.innerText()),
      comment: (await comment.count()) > 0 ? flat(await comment.first().innerText()) : null,
    })
  }
  return rows
}

/** Wait for a customer decision to surface on the bridge, and return the events. */
async function awaitSignoffEvents(
  request: APIRequestContext,
  cursor: string | null,
  reference: string,
  type: string,
  expected: number,
): Promise<BridgeEvent[]> {
  let found: BridgeEvent[] = []
  await expect
    .poll(
      async () => {
        found = (await eventsSince(request, cursor)).filter(
          (e) => e.submission_id === reference && e.type === type,
        )
        return found.length
      },
      {
        message: `the customer's decision on ${reference} must reach coord as \`${type}\``,
        timeout: 15_000,
      },
    )
    .toBe(expected)
  return found
}

/**
 * Contract note 6, treated as an absolute: "no mock renders any GitHub issue
 * number, PR number, branch name, or coord-side identifier anywhere in
 * customer-facing copy", reinforced for this issue by the contract's own
 * "**no issue numbers, no branch names, no agent identifiers, ever**".
 */
const FORBIDDEN: Array<[RegExp, string]> = [
  [/\bSTUCK:/i, "the worker's escalation vocabulary is engineer-side"],
  [/\bissue\s*#?\d+/i, "customers never see an issue number"],
  [/#\d+/, "customers never see a GitHub number"],
  [/\bepic\b/i, "the epic is an engineer-side decomposition artefact"],
  [/\bmilestone\b/i, "the milestone is an engineer-side artefact"],
  [/\bpull request\b/i, "no PR ever crosses the wall"],
  [/\bPR\b/, "no PR ever crosses the wall"],
  [/\bbranch(es)?\b/i, "customers never see a branch"],
  [/\bcommit(s|ted)?\b/i, "customers never see a commit"],
  [/\bworktree\b/i, "customers never see a worktree"],
  [/\bagent\b/i, "customers never see a live agent"],
  [/\bworker\b/i, "customers never see an engineer-side worker"],
  [/\bgithub\b/i, "the engineer side is not named"],
  [/\bdaemon\b/i, "the daemon is not a customer-facing concept"],
  [/\bstatus:ready\b/i, "labels are engineer-side"],
  [/\b(feat|fix|chore|refactor)\/[a-z0-9-]+/i, "customers never see a branch name"],
]

// ── the slice ───────────────────────────────────────────────────────────────

test.describe("ms-1 issue 13 design rounds", () => {
  test.beforeEach(async ({ page }) => {
    await asCustomer(page)
  })

  test("an awaiting-sign-off submission shows the current design round", async ({
    page,
    request,
  }) => {
    const target = await seedSubmission(page, 0)

    // Before a round exists there is nothing to sign off — the affordance is a
    // consequence of a proposal, not furniture.
    await page.goto(target.url)
    for (const testid of ["design-round", ...DECISION_TESTIDS]) {
      await expect(
        page.getByTestId(testid),
        `a submission with no design round renders no \`${testid}\``,
      ).toHaveCount(0)
    }

    await pushDesignRound(request, target.reference, 3000, ROUNDS[0])

    await page.goto(target.url)
    const detail = page.getByTestId("submission-detail")
    await expect(detail).toBeVisible()
    await expect(detail, "the detail root carries the sign-off status").toHaveAttribute(
      "data-status",
      "awaiting-signoff",
    )

    const pill = page.getByTestId("status-pill")
    await expect(pill, "one status, once").toHaveCount(1)
    await expect(pill).toHaveAttribute("data-status", "awaiting-signoff")
    expect(
      flat(await pill.innerText()),
      "contract § status vocabulary pins this wording",
    ).toBe(AWAITING_SIGNOFF_TEXT)

    for (const testid of SIGNOFF_TESTIDS) {
      await expect(
        page.getByTestId(testid),
        `the sign-off screen renders \`${testid}\``,
      ).toBeVisible()
    }

    // The round is the one coord proposed — number, outcome definition,
    // decomposition and mock bundle all come from the push, not from a template.
    const round = page.getByTestId("design-round")
    await expect(round, "one current round, once").toHaveCount(1)
    await expect(round).toHaveAttribute("data-round", "1")
    await expect(
      round,
      "an undecided round is `pending` in the pinned verdict vocabulary",
    ).toHaveAttribute("data-verdict", "pending")
    expect(
      flat(await page.getByTestId("round-number").innerText()),
      "contract § Awaiting-sign-off (05) pins the text `Round {n}`",
    ).toBe("Round 1")
    expect(flat(await page.getByTestId("outcome-definition").innerText())).toBe(
      ROUNDS[0].outcome,
    )

    const items = page.getByTestId("decomposition-item")
    await expect(items, "one item per proposed work item").toHaveCount(
      ROUNDS[0].decomposition.length,
    )
    expect((await items.allInnerTexts()).map(flat)).toEqual(ROUNDS[0].decomposition)

    // "a mock bundle where the change is visible" — a link that goes somewhere.
    const bundle = page.getByTestId("mock-bundle-link")
    const href = await bundle.getAttribute("href")
    expect(href, "the mock bundle link points somewhere").toBeTruthy()
    expect(href, "…and not at nothing").not.toBe("#")

    // TODO(test-author): the contract pins `mock-bundle-link` as a hook but not
    // the URL scheme of the bundle it points at (issue #13 says R2, served
    // read-only; the contract does not pin a path shape, and the mock uses a
    // placeholder `#`). So the destination is asserted only to be a non-empty,
    // non-placeholder href — not to match the pushed URL, since nothing pins
    // that the portal serves coord's URL verbatim rather than proxying it.

    // It is still the same submission, not a screen about a round in the abstract.
    expect(await page.getByTestId("submission-reference").innerText()).toContain(
      target.reference,
    )
  })

  test("the decomposition is plain language, with no engineer-side identifier", async ({
    page,
    request,
  }) => {
    // Contract § "Design-round / sign-off loop", verbatim: the decomposition is
    // "rendered as a plain-text list of work items — **no issue numbers, no
    // branch names, no agent identifiers, ever**". The decomposition is the most
    // likely place for the wall to leak, because it is literally the engineer
    // side's plan being shown to a customer.
    const target = await seedSubmission(page, 1)
    await pushDesignRound(request, target.reference, 3100, ROUNDS[1])

    await page.goto(target.url)
    const round = page.getByTestId("design-round")
    // Positive control first: a screen that failed to render leaks nothing and
    // proves nothing.
    await expect(round).toBeVisible()
    const body = flat(await round.innerText())
    expect(body, "the round really rendered").toContain(ROUNDS[1].outcome)
    expect(body, "the decomposition really rendered").toContain(ROUNDS[1].decomposition[2])

    for (const [pattern, why] of FORBIDDEN) {
      expect(body, `the sign-off screen: ${why}`).not.toMatch(pattern)
    }

    // Each work item is a sentence a customer could have written, not a ticket.
    for (const item of (await page.getByTestId("decomposition-item").allInnerTexts()).map(
      flat,
    )) {
      expect(item.length, "a work item is described, not just labelled").toBeGreaterThan(3)
      for (const [pattern, why] of FORBIDDEN) {
        expect(item, `a decomposition item: ${why}`).not.toMatch(pattern)
      }
    }

    // TODO(test-author): the decomposition TEXT originates engineer-side, and
    // the contract does not say whether the portal must scrub a decomposition
    // coord pushed with an issue number in it, or whether that is coord's duty
    // before it crosses the bridge. Same unresolved ownership as the question
    // text in `11-question-channel.spec.ts`. This test therefore uses clean
    // synthetic content and asserts the portal's own chrome and framing add no
    // identifier; it does not assert that dirty input gets sanitised.
  })

  test("the request-changes composer opens on demand and cancels cleanly", async ({
    page,
    request,
  }) => {
    // Contract § mock inventory: `06-request-changes.html` is "same route as 05,
    // composer expanded — not a distinct URL". So the composer is a state of the
    // sign-off screen, and cancelling it must leave the round exactly as it was.
    const target = await seedSubmission(page, 2)
    await pushDesignRound(request, target.reference, 3200, ROUNDS[0])
    const start = await drainToCursor(request)

    await page.goto(target.url)
    await expect(
      page.getByTestId("request-changes-form"),
      "the composer is closed until the customer asks for it",
    ).toBeHidden()

    const open = page.getByTestId("request-changes-button")
    await expect(open, "an awaiting-sign-off round offers Request changes").toBeVisible()
    await open.click()
    for (const testid of COMPOSER_TESTIDS) {
      await expect(
        page.getByTestId(testid),
        `the open composer renders \`${testid}\``,
      ).toBeVisible()
    }
    expect(
      await page.getByTestId("changes-comment").inputValue(),
      "a fresh composer starts empty",
    ).toBe("")

    // The composer says what submitting will do — the customer is told the round
    // is versioned before they commit to it, not after.
    const note = flat(await page.getByTestId("next-round-note").innerText())
    expect(note.length, "`next-round-note` explains what happens next").toBeGreaterThan(0)
    expect(note, "…and names the state the submission returns to").toContain(IN_DESIGN_TEXT)

    // TODO(test-author): the contract pins `next-round-note` as a hook but pins
    // no exact wording for it (unlike `pause-banner`'s "Work is paused until you
    // answer."). Only the substantive claim the mock makes — that this returns
    // to In design — is asserted; the sentence around it is free.

    // Cancel: typed-but-unsent notes are not a decision.
    await page.getByTestId("changes-comment").fill(CHANGE_COMMENTS[0])
    await page.getByTestId("cancel-changes").click()
    await expect(
      page.getByTestId("request-changes-form"),
      "cancelling closes the composer",
    ).toBeHidden()

    await page.goto(target.url)
    expect(
      await page.getByTestId("status-pill").getAttribute("data-status"),
      "cancelling decides nothing",
    ).toBe("awaiting-signoff")
    await expect(page.getByTestId("design-round")).toHaveAttribute("data-verdict", "pending")

    const events = (await eventsSince(request, start)).filter(
      (e) => e.submission_id === target.reference,
    )
    expect(events, "a cancelled composer is not a customer-authored fact").toEqual([])

    const body = flat(await page.locator("body").innerText())
    expect(body, "an abandoned draft is not recorded as a comment").not.toContain(
      CHANGE_COMMENTS[0],
    )
  })

  test("requesting changes records the verdict against the round it was given", async ({
    page,
    request,
  }) => {
    const target = await seedSubmission(page, 3)
    await pushDesignRound(request, target.reference, 3300, ROUNDS[0])
    const start = await drainToCursor(request)

    await requestChanges(page, target.url, CHANGE_COMMENTS[0])

    // `signoff_verdict` / `signoff_comment` are portal-owned (contract §
    // sole-writer table), which makes the decision a customer-authored fact,
    // which is exactly what the bridge carries out.
    const [event] = await awaitSignoffEvents(
      request,
      start,
      target.reference,
      "signoff.changes_requested",
      1,
    )
    expect(typeof event.id, "`id` is an opaque string").toBe("string")
    expect(event.id.length).toBeGreaterThan(0)
    expect(Number.isInteger(event.revision), "`revision` is an integer").toBe(true)

    // One decision, one event — not re-announced on every later pull.
    const again = (await eventsSince(request, start)).filter(
      (e) => e.submission_id === target.reference,
    )
    expect(
      again.map((e) => e.type),
      "requesting changes produces exactly one customer-authored fact",
    ).toEqual(["signoff.changes_requested"])

    // …and the round it was given now wears that verdict, with the comment
    // attached, in the audit trail.
    const rows = await readHistory(page, target.url)
    const round1 = rows.find((r) => r.round === 1)
    expect(round1, "round 1 is still in the history").toBeDefined()
    expect(round1!.verdict, "contract § Round history pins this verdict slug").toBe(
      "changes-requested",
    )
    expect(round1!.comment, "a changes-requested round carries the customer's comment").toBe(
      CHANGE_COMMENTS[0],
    )

    // TODO(test-author): the contract shows every event `payload` as `{ }` and
    // never says what a `signoff.changes_requested` payload contains — not even
    // whether the comment text rides in it. So the comment's presence is
    // asserted on the customer's screen (which contract note 3 makes the real
    // contract) and not on the wire.
  })

  test("requesting changes opens round N+1 and never mutates round N", async ({
    page,
    request,
  }) => {
    // The heart of issue #13: "Rounds are versioned and every previous round
    // stays readable — this is the audit trail of what was agreed." A round that
    // silently rewrites itself destroys exactly that.
    const target = await seedSubmission(page, 0)
    await pushDesignRound(request, target.reference, 3400, ROUNDS[0])

    await requestChanges(page, target.url, CHANGE_COMMENTS[0])
    await expect
      .poll(async () => (await readHistory(page, target.url)).find((r) => r.round === 1)?.verdict, {
        message: "round 1 must be marked changes-requested",
        timeout: 15_000,
      })
      .toBe("changes-requested")

    // Coord answers the change request with the next proposal.
    await pushDesignRound(request, target.reference, 3401, ROUNDS[1])

    await page.goto(target.url)
    const current = page.getByTestId("design-round")
    await expect(current, "exactly one round is current").toHaveCount(1)
    const currentRound = Number(await current.getAttribute("data-round"))
    expect(
      currentRound,
      "requesting changes on round N opens round N+1 — not N, not N+2",
    ).toBe(2)
    expect(flat(await page.getByTestId("round-number").innerText())).toBe("Round 2")
    expect(flat(await page.getByTestId("outcome-definition").innerText())).toBe(
      ROUNDS[1].outcome,
    )

    // Round 1 is untouched: its ORIGINAL outcome definition, its ORIGINAL
    // decomposition length, its verdict and its comment all survive round 2
    // existing.
    const rows = await readHistory(page, target.url)
    const round1 = rows.find((r) => r.round === 1)!
    expect(round1.verdict).toBe("changes-requested")
    expect(round1.comment).toBe(CHANGE_COMMENTS[0])
    expect(round1.text, "round 1 still reads as round 1 did").toContain(ROUNDS[0].outcome)
    expect(
      round1.text,
      "round 2's proposal must not be back-written into round 1",
    ).not.toContain(ROUNDS[1].outcome)
    expect(
      round1.text,
      "nor round 2's extra work item",
    ).not.toContain(ROUNDS[1].decomposition[2])

    const round2 = rows.find((r) => r.round === 2)!
    expect(round2.verdict, "the newest round is undecided").toBe("pending")
    expect(round2.comment, "an undecided round has no change request on it").toBeNull()

    // TODO(test-author): the contract says request-changes "opens round N+1" but
    // does not say WHEN round N+1 becomes visible — the instant the customer
    // submits (an empty round awaiting coord's proposal, as `06`'s copy "Your
    // notes become Round 3" implies) or only once coord pushes its content. So
    // the window between the two is deliberately unasserted; what is asserted is
    // that once coord's next proposal lands it is numbered N+1.
    //
    // TODO(test-author): nor does the contract say whether the portal assigns
    // the round number itself or renders one coord supplies. `pushDesignRound`
    // supplies a consistent number so either implementation passes.
  })

  test("requesting changes returns the submission to In design", async ({
    page,
    request,
  }) => {
    const target = await seedSubmission(page, 1)
    await pushDesignRound(request, target.reference, 3500, ROUNDS[0])

    await requestChanges(page, target.url, CHANGE_COMMENTS[1])

    // Contract § "Design-round / sign-off loop", verbatim: "'Request changes'
    // always opens round *N+1* and returns the submission to `In design`."
    await expect
      .poll(async () => readStatus(page, target.url), {
        message: "requesting changes returns the submission to In design",
        timeout: 15_000,
      })
      .toBe("in-design")

    await page.goto(target.url)
    expect(
      flat(await page.getByTestId("status-pill").innerText()),
      "contract § status vocabulary pins this wording",
    ).toBe(IN_DESIGN_TEXT)

    // …and the customer is no longer being asked to decide something they have
    // just decided.
    for (const testid of [...DECISION_TESTIDS, ...COMPOSER_TESTIDS]) {
      await expect(
        page.getByTestId(testid),
        `a submission back in design offers no \`${testid}\``,
      ).toHaveCount(0)
    }

    // TODO(test-author): **this test sits on an unresolved tension in the
    // contract and the coordinator should know about it.** § "Design-round /
    // sign-off loop" says request-changes "returns the submission to `In
    // design`", while § "Ownership — sole-writer table" says `status` is
    // coord-owned and the portal "may never write" it. Two readings: (a) the
    // portal moves the customer-visible status itself on a portal-owned
    // decision, which is what `mocks/06-request-changes.html` promises the
    // customer in as many words ("Submitting opens Round 3 and moves this back
    // to In design"), or (b) the portal writes only the verdict and coord pushes
    // `in-design` after observing the event. This spec takes reading (a),
    // because it is the more specific pin and it is what the mock — which the
    // contract calls part of the contract — tells the customer will happen. If
    // #13 lands reading (b), the contract needs amending rather than this test
    // quietly relaxing, and the poll above is the place it will show up.
  })

  test("an empty change request does not close the round", async ({ page, request }) => {
    const target = await seedSubmission(page, 2)
    await pushDesignRound(request, target.reference, 3600, ROUNDS[0])
    const start = await drainToCursor(request)

    // "requesting changes with comments" — a blank comment tells coord nothing
    // and must not burn a round.
    for (const blank of ["", "   "]) {
      await page.goto(target.url)
      const open = page.getByTestId("request-changes-button")
      await expect(open, "an awaiting-sign-off round offers Request changes").toBeVisible()
      await open.click()
      await page.getByTestId("changes-comment").fill(blank)
      const button = page.getByTestId("submit-changes")
      // A disabled button is a perfectly good way to refuse a blank comment, so
      // it is accepted rather than clicked into a timeout.
      if (await button.isEnabled()) await button.click()
    }

    await page.goto(target.url)
    expect(
      await page.getByTestId("status-pill").getAttribute("data-status"),
      "a blank comment is not a decision",
    ).toBe("awaiting-signoff")
    await expect(page.getByTestId("design-round")).toHaveAttribute("data-verdict", "pending")

    // Then a real change request — which both proves the composer still works
    // and flushes the stream, so a blank submission that HAD produced an event
    // would show up here as a second one.
    await requestChanges(page, target.url, CHANGE_COMMENTS[0])
    const events = await awaitSignoffEvents(
      request,
      start,
      target.reference,
      "signoff.changes_requested",
      1,
    )
    expect(events, "only the real change request reached coord").toHaveLength(1)

    const rows = await readHistory(page, target.url)
    expect(
      rows.filter((r) => r.verdict === "changes-requested"),
      "three attempts, one rejected round",
    ).toHaveLength(1)

    // TODO(test-author): the contract pins no validation copy, no error
    // `data-testid` and no disabled/enabled rule for `submit-changes` (the mock
    // marks the textarea `required` and nothing more), so HOW a blank comment is
    // refused is deliberately unasserted — only that it does not count.
  })

  test("approving is the only action that moves a submission past sign-off", async ({
    page,
    request,
  }) => {
    // Contract § "Design-round / sign-off loop": "'Approve' is the only action
    // that can move a submission past `Awaiting your sign-off` toward
    // `Planned`."
    const target = await seedSubmission(page, 3)
    await pushDesignRound(request, target.reference, 3700, ROUNDS[0])
    const start = await drainToCursor(request)

    // First the counter-example: the other action does NOT move it onward.
    await requestChanges(page, target.url, CHANGE_COMMENTS[0])
    await awaitSignoffEvents(
      request,
      start,
      target.reference,
      "signoff.changes_requested",
      1,
    )
    expect(
      FORWARD_OF_SIGNOFF,
      "requesting changes goes back to design, never forward",
    ).not.toContain(await readStatus(page, target.url))

    // Coord proposes again; this time the customer approves.
    await pushDesignRound(request, target.reference, 3701, ROUNDS[1])
    await approve(page, target.url)

    const [event] = await awaitSignoffEvents(
      request,
      start,
      target.reference,
      "signoff.approved",
      1,
    )
    expect(event.submission_id).toBe(target.reference)
    expect(Number.isInteger(event.revision)).toBe(true)

    const status = await readStatus(page, target.url)
    expect(status, "approving moves the submission past Awaiting your sign-off").not.toBe(
      "awaiting-signoff",
    )
    expect(
      FORWARD_OF_SIGNOFF,
      "…and onward, toward Planned — not back into design",
    ).toContain(status)

    // An approved round is decided: it is not still asking.
    await page.goto(target.url)
    for (const testid of [...DECISION_TESTIDS, ...COMPOSER_TESTIDS]) {
      await expect(
        page.getByTestId(testid),
        `a signed-off submission offers no \`${testid}\``,
      ).toHaveCount(0)
    }

    const rows = await readHistory(page, target.url)
    expect(rows.find((r) => r.round === 1)!.verdict).toBe("changes-requested")
    expect(
      rows.find((r) => r.round === 2)!.verdict,
      "the approved round is marked approved",
    ).toBe("approved")

    // TODO(test-author): the contract does not say whether approving is
    // idempotent or what a second approve on the same round would do, so a
    // repeat click is not exercised. It also does not pin which forward status
    // approval lands on ("toward `Planned`"), hence the set membership above.
  })

  test("every previous round stays readable in the round history", async ({
    page,
    request,
  }) => {
    // "Every previous round stays readable at `/submissions/:id/rounds` — a
    // superseded round is never deleted or hidden, only marked with its
    // verdict."
    const target = await seedSubmission(page, 0)
    await pushDesignRound(request, target.reference, 3800, ROUNDS[0])
    await requestChanges(page, target.url, CHANGE_COMMENTS[0])
    await expect
      .poll(async () => (await readHistory(page, target.url)).length, {
        message: "round 1 must be recorded before round 2 opens",
        timeout: 15_000,
      })
      .toBeGreaterThan(0)

    await pushDesignRound(request, target.reference, 3801, ROUNDS[1])
    await requestChanges(page, target.url, CHANGE_COMMENTS[1])
    await expect
      .poll(
        async () =>
          (await readHistory(page, target.url)).filter(
            (r) => r.verdict === "changes-requested",
          ).length,
        { message: "round 2 must be recorded too", timeout: 15_000 },
      )
      .toBe(2)

    await pushDesignRound(request, target.reference, 3802, ROUNDS[2])

    const rows = await readHistory(page, target.url)
    expect(rows.map((r) => r.round).sort((a, b) => a - b), "rounds 1..3, all present").toEqual(
      [1, 2, 3],
    )

    // Rounds are 1-indexed and monotonically increasing per submission — no
    // gaps, no repeats, no round zero.
    const numbers = rows.map((r) => r.round)
    expect(new Set(numbers).size, "no round number is reused").toBe(numbers.length)
    expect(Math.min(...numbers), "rounds are 1-indexed").toBe(1)

    // Each round still reads as itself — this is the audit trail of what was
    // agreed, so round 1 must still say what round 1 said.
    for (const [i, seed] of ROUNDS.entries()) {
      const row = rows.find((r) => r.round === seed.round)!
      expect(row.text, `round ${seed.round} still shows its own outcome definition`).toContain(
        seed.outcome,
      )
      for (const other of ROUNDS) {
        if (other.round === seed.round) continue
        expect(
          row.text,
          `round ${seed.round} must not have been rewritten as round ${other.round}`,
        ).not.toContain(other.outcome)
      }
      expect(i).toBeGreaterThanOrEqual(0) // keep `entries()` honest for the linter
    }

    // Both change requests survive, attached to the round they were made about.
    expect(rows.find((r) => r.round === 1)!.comment).toBe(CHANGE_COMMENTS[0])
    expect(rows.find((r) => r.round === 2)!.comment).toBe(CHANGE_COMMENTS[1])
    expect(
      rows.find((r) => r.round === 3)!.comment,
      "contract § Round history: `round-comment` is present only where changes were requested",
    ).toBeNull()

    // The history is navigable from the round and back again — the contract
    // pins both links.
    await page.goto(target.url)
    await page.getByTestId("round-history-link").click()
    await expect(page.getByTestId("round-history")).toBeVisible()
    expect(page.url().replace(/\/$/, "")).toBe(`${target.url.replace(/\/$/, "")}/rounds`)

    await page.getByTestId("back-to-submission").click()
    await expect(page.getByTestId("submission-detail")).toBeVisible()
    expect(page.url().replace(/\/$/, "")).toBe(target.url.replace(/\/$/, ""))

    // TODO(test-author): the contract pins neither the ORDER of `round-entry`
    // elements (the mock renders newest-first; nothing says that is required)
    // nor a per-round date hook, so ordering and dates are unasserted.
  })

  test("the round history marks each round with a verdict from the pinned vocabulary", async ({
    page,
    request,
  }) => {
    const target = await seedSubmission(page, 1)
    await pushDesignRound(request, target.reference, 3900, ROUNDS[0])
    await requestChanges(page, target.url, CHANGE_COMMENTS[0])
    await expect
      .poll(async () => (await readHistory(page, target.url)).length, {
        message: "the first decided round must reach the history",
        timeout: 15_000,
      })
      .toBeGreaterThan(0)
    await pushDesignRound(request, target.reference, 3901, ROUNDS[1])
    await approve(page, target.url)
    await expect
      .poll(
        async () =>
          (await readHistory(page, target.url)).find((r) => r.round === 2)?.verdict,
        { message: "the approved round must reach the history", timeout: 15_000 },
      )
      .toBe("approved")

    await page.goto(`${target.url}/rounds`)
    const entries = page.getByTestId("round-entry")
    const pills = page.getByTestId("verdict-pill")
    await expect(pills, "one verdict pill per round entry").toHaveCount(await entries.count())

    const count = await pills.count()
    for (let i = 0; i < count; i++) {
      const verdict = await pills.nth(i).getAttribute("data-verdict")
      expect(
        VERDICTS,
        "contract § Round history pins `pending` / `approved` / `changes-requested`",
      ).toContain(verdict)
      expect(
        flat(await pills.nth(i).innerText()).length,
        "a verdict pill is legible to a customer, not just an attribute",
      ).toBeGreaterThan(0)
      // The entry and its pill agree — a round cannot be approved in one place
      // and rejected in another.
      expect(await entries.nth(i).getAttribute("data-verdict")).toBe(verdict)
    }

    // The audit trail carries the same wall as every other customer screen.
    const body = flat(await page.getByTestId("round-history").innerText())
    expect(body, "the history really rendered").toContain(ROUNDS[0].outcome)
    for (const [pattern, why] of FORBIDDEN) {
      expect(body, `the round history: ${why}`).not.toMatch(pattern)
    }

    // TODO(test-author): the contract pins the three verdict SLUGS but no
    // customer-visible text for any of them (`mocks/07-round-history.html`
    // renders "Awaiting your sign-off" / "Changes requested", which the contract
    // never pins as required wording). So the pill's text is asserted only to be
    // non-empty.
  })

  test("coord may never write the customer's sign-off verdict or comment", async ({
    page,
    request,
  }) => {
    // Contract § sole-writer table: `signoff_verdict` and `signoff_comment` are
    // portal-owned. `15-sync-bridge.spec.ts` asserts the generic rejection
    // shape; what is asserted here is #13's own half — that a refused write
    // changes nothing the *customer* sees, so coord cannot sign a round off on
    // the customer's behalf.
    const target = await seedSubmission(page, 2)
    await pushDesignRound(request, target.reference, 4000, ROUNDS[0])
    const start = await drainToCursor(request)

    const forgedComment = "Looks great, ship it — this comment was not written by the customer."

    const verdict = await pushFields(request, target.reference, 4001, {
      signoff_verdict: "approved",
    })
    expect(verdict.outcome, "`signoff_verdict` is portal-owned").toBe("rejected")
    expect(verdict.reason).toBe("not_owned:signoff_verdict")

    const comment = await pushFields(request, target.reference, 4002, {
      signoff_comment: forgedComment,
    })
    expect(comment.outcome, "`signoff_comment` is portal-owned").toBe("rejected")
    expect(comment.reason).toBe("not_owned:signoff_comment")

    // Whole-update atomicity: a valid coord-owned sibling does not smuggle it in.
    const mixed = await pushFields(request, target.reference, 4003, {
      status: "planned",
      signoff_verdict: "approved",
    })
    expect(mixed.outcome).toBe("rejected")
    expect(mixed.reason).toBe("not_owned:signoff_verdict")

    await page.goto(target.url)
    expect(
      await page.getByTestId("status-pill").getAttribute("data-status"),
      "a rejected update applies none of its fields, including the valid sibling",
    ).toBe("awaiting-signoff")
    await expect(
      page.getByTestId("design-round"),
      "a forged verdict does not decide the round",
    ).toHaveAttribute("data-verdict", "pending")
    await expect(
      page.getByTestId("approve-button"),
      "the customer is still the one being asked",
    ).toBeVisible()

    const body = flat(await page.locator("body").innerText())
    expect(body, "coord cannot put a sign-off comment in the customer's mouth").not.toContain(
      forgedComment,
    )

    const events = (await eventsSince(request, start)).filter(
      (e) => e.submission_id === target.reference,
    )
    expect(events, "a rejected coord write is not a customer-authored fact").toEqual([])

    // The customer deciding afterwards still works — the refusal left the loop
    // intact, not wedged.
    await approve(page, target.url)
    await awaitSignoffEvents(request, start, target.reference, "signoff.approved", 1)
  })

  test("a submission not awaiting sign-off offers no sign-off actions", async ({
    page,
    request,
  }) => {
    // The inverse of the loop: a decision you are not being asked to make must
    // not be offerable. Without this, "Approve is the only action that can move
    // a submission past Awaiting your sign-off" is unenforceable — a customer
    // could approve a round that was never put to them.
    const target = await seedSubmission(page, 3)
    await pushDesignRound(request, target.reference, 4100, ROUNDS[0])
    const start = await drainToCursor(request)

    let revision = 4101
    for (const status of ["in-design", "planned", "in-progress", "quality-check", "shipped"]) {
      expect(
        (await pushFields(request, target.reference, revision++, { status })).outcome,
      ).toBe("applied")

      await page.goto(target.url)
      await expect(page.getByTestId("submission-detail")).toBeVisible()

      for (const testid of [...DECISION_TESTIDS, ...COMPOSER_TESTIDS]) {
        await expect(
          page.getByTestId(testid),
          `\`${status}\` is not awaiting sign-off — no \`${testid}\``,
        ).toHaveCount(0)
      }
      await expect(
        page.getByRole("button", { name: /approve|request changes|sign off/i }),
        `\`${status}\` asks the customer for no sign-off decision`,
      ).toHaveCount(0)
    }

    const events = (await eventsSince(request, start)).filter(
      (e) => e.submission_id === target.reference,
    )
    expect(events, "no decision was offered, so none was made").toEqual([])

    // …but the audit trail is still readable, whatever the status. The rounds
    // do not vanish once the work moves on.
    const rows = await readHistory(page, target.url)
    expect(rows.map((r) => r.round), "round 1 stays readable after shipping").toContain(1)
    expect(rows.find((r) => r.round === 1)!.text).toContain(ROUNDS[0].outcome)

    // TODO(test-author): the contract does not say whether `round-history-link`
    // (a read-only navigation, not a decision) survives on a non-sign-off
    // screen, so it is deliberately absent from the lists asserted away above —
    // only affordances that ask the customer to *decide* are.
  })

  test("a sign-off decision reaches coord once, and replays from a cursor", async ({
    page,
    request,
  }) => {
    // Contract § pull: "Replay-safe from a cursor: pulling the same cursor twice
    // returns the same events." For #13 that is what makes a sign-off durable —
    // the decision survives a daemon that restarts, and a customer who reloads
    // does not re-approve.
    const target = await seedSubmission(page, 0)
    await pushDesignRound(request, target.reference, 4200, ROUNDS[0])
    const start = await drainToCursor(request)

    await requestChanges(page, target.url, CHANGE_COMMENTS[0])
    await awaitSignoffEvents(request, start, target.reference, "signoff.changes_requested", 1)

    await pushDesignRound(request, target.reference, 4201, ROUNDS[1])
    await approve(page, target.url)
    await awaitSignoffEvents(request, start, target.reference, "signoff.approved", 1)

    // A fresh page, and a fresh reload, do not re-decide anything.
    await page.goto(target.url)
    await page.reload()
    await page.goto(`${target.url}/rounds`)
    await page.reload()

    const once = (await eventsSince(request, start)).filter(
      (e) => e.submission_id === target.reference,
    )
    const twice = (await eventsSince(request, start)).filter(
      (e) => e.submission_id === target.reference,
    )
    expect(twice, "replaying the same cursor returns the same events").toEqual(once)

    expect(
      once.map((e) => e.type),
      "two decisions, two events, in the order they were made",
    ).toEqual(["signoff.changes_requested", "signoff.approved"])

    // Revisions are monotonic and never reused, so the daemon can order the
    // sign-off against everything else it pulled.
    for (let i = 1; i < once.length; i++) {
      expect(once[i].revision).toBeGreaterThan(once[i - 1].revision)
    }

    // The portal emits customer-authored facts only — coord's own pushes are
    // never echoed back as events.
    for (const event of once) {
      expect(
        ["signoff.approved", "signoff.changes_requested"],
        "the portal never emits an event about a coord-owned fact",
      ).toContain(event.type)
    }
  })
})
