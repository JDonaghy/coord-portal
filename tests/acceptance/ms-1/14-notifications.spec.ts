import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test"

/**
 * ms-1 sealed acceptance slice — issue #14
 * "[portal] Customer notifications — email, digest-first"
 *
 * Written from `tests/acceptance/ms-1/contract.md` (the `Emails (11–13)` hook
 * block, § "Customer status vocabulary" — which pins the send rule outright —
 * and § "Ownership — sole-writer table") and from the three mocks it pins,
 * `mocks/11-email-signoff-ready.html`, `mocks/12-email-needs-input.html`,
 * `mocks/13-email-shipped.html`, without sight of any implementation.
 *
 * THE SHAPE UNDER TEST. Issue #14 is one rule with two halves:
 *
 *   REACH    "The async loop only works if 'come back later' actually reaches
 *            the customer." A design round ready for sign-off, a question
 *            raised, and work shipped each put something in the customer's
 *            inbox that brings them back to the submission.
 *   RESTRAIN "A customer does not need to watch the pipeline breathe." Those
 *            three states, and *only* those three, ever generate a send. The
 *            contract states this as a black-box invariant in as many words:
 *            "Per issue #14, those three states — and *only* those three — ever
 *            generate an email send. This is a black-box invariant: a test may
 *            assert that no other status transition produces `email-preview`
 *            output."
 *
 * The restraint half is the one that actually needs an oracle. Reaching the
 * customer fails loudly (nobody comes back); over-sending fails quietly, by
 * training the customer to ignore the sender — which is the same as not
 * reaching them at all, only harder to notice.
 *
 * MECHANISM. `status`, `question` and `design_round` are all coord-owned
 * (contract § sole-writer table), so the only black-box way to drive a
 * submission into a sending state is a bridge push (#15's surface); the only way
 * to author a submission is #9's pinned intake form. Both are other issues'
 * surfaces, used here as instruments, not as subjects.
 *
 * NOT COVERED HERE, deliberately:
 *  - **Delivery.** Whether the mail actually leaves Cloudflare, which provider
 *    carries it, bounces, retries, SPF/DKIM. Nothing black-box in this repo can
 *    observe an inbox; this slice asserts what the portal *decided to send*.
 *  - **Per-recipient quiet hours.** Issue #14: "a v2 refinement." Out of scope
 *    by the issue's own words.
 *  - **What each screen contains** (`design-round`, `question-thread`,
 *    `shipped-copy`). Those are #13's, #11's and #10's slices.
 *  - **Generic bridge mechanics** (401s, cursors, batch ordering, ownership
 *    rejection). #15's and #8's slices own those.
 *
 * SYNTHETIC DATA. Per CLAUDE.md rule 1 and the contract's "Synthetic data"
 * section, every address, submission, question and design round below is
 * invented. `example.test` is a reserved TLD and can never be a real customer.
 */

// ── the observation seam ────────────────────────────────────────────────────

/**
 * TODO(test-author): **THE CONTRACT PINS NO ROUTE THAT RENDERS A SENT EMAIL,
 * AND THIS SLICE CANNOT EXIST WITHOUT ONE.** This is the single biggest gap in
 * ms-1's contract for issue #14 and the coordinator should treat it as a
 * contract amendment, not as a test-author preference.
 *
 * What the contract *does* pin, and what this suite relies on:
 *  - the email DOM: `email-preview` carrying `data-email-type` ∈
 *    `signoff-ready` / `needs-input` / `shipped`, containing `email-from`,
 *    `email-to`, `email-subject`, `email-preheader`, `email-body`, `email-cta`
 *    (§ "`data-testid` hooks", Emails (11–13));
 *  - that a test "may assert that no other status transition produces
 *    `email-preview` output" (§ "Customer status vocabulary") — which is only
 *    meaningful if `email-preview` output is observable from outside.
 *
 * What it does not pin: where that output is read from. § "Route surface
 * (pinned)" lists no email route, and the mocks say "not a portal route —
 * rendered as an inbox preview for review purposes".
 *
 * So this suite PROBES for one, rather than hard-coding a guess: the first
 * candidate below that answers 2xx is used for the whole run, and
 * `COORD_PORTAL_OUTBOX_PATH` overrides the list entirely. If none answers, every
 * test in this slice fails with `NO_OUTBOX` below, whose text is the message the
 * implementing worker will see (`coord acceptance run` prints failure messages,
 * never test source). Nothing else in this file depends on which candidate won.
 */
const OUTBOX_CANDIDATES: string[] = [
  process.env.COORD_PORTAL_OUTBOX_PATH ?? "",
  "/outbox",
  "/emails",
  "/notifications",
  "/api/outbox",
].filter((path) => path.length > 0)

const NO_OUTBOX =
  "ms-1 issue #14 has no readable email outbox. Tried: " +
  OUTBOX_CANDIDATES.join(", ") +
  ". The contract pins the email DOM hooks (`email-preview` with `data-email-type`, " +
  "`email-from`, `email-to`, `email-subject`, `email-preheader`, `email-body`, `email-cta`) " +
  "and pins that a test may assert no other status transition produces `email-preview` " +
  "output — but it pins no route that renders it. This sealed slice therefore needs one " +
  "black-box read-back of what the portal decided to send: an authenticated page that renders " +
  "one `email-preview` element per send, with exactly the DOM of mocks/11-13. Serve one at any " +
  "of the paths above, or point this suite at yours with COORD_PORTAL_OUTBOX_PATH."

let resolvedOutbox: string | null = null

async function outboxPath(page: Page): Promise<string> {
  if (resolvedOutbox !== null) return resolvedOutbox
  for (const candidate of OUTBOX_CANDIDATES) {
    const response = await page.goto(candidate)
    if (response !== null && response.ok()) {
      resolvedOutbox = candidate
      return candidate
    }
  }
  throw new Error(NO_OUTBOX)
}

// ── the pinned email surface ────────────────────────────────────────────────

/** Contract § `data-testid` hooks, Emails (11–13): the pinned `data-email-type`s. */
const SENDING_TYPES = ["signoff-ready", "needs-input", "shipped"] as const
type SendType = (typeof SENDING_TYPES)[number]

/** Contract § Emails (11–13): every hook an `email-preview` must contain. */
const EMAIL_TESTIDS = [
  "email-from",
  "email-to",
  "email-subject",
  "email-preheader",
  "email-body",
  "email-cta",
]

/**
 * Contract § "Customer status vocabulary": the three states that send, mapped to
 * the `data-email-type` each one produces. `awaiting-signoff` and `needs-input`
 * are the two customer-actionable states; `shipped` is the terminal one.
 */
const TYPE_FOR_STATUS: Record<string, SendType> = {
  "awaiting-signoff": "signoff-ready",
  "needs-input": "needs-input",
  shipped: "shipped",
}

/** Every other slug in the pinned vocabulary — none of these may ever send. */
const SILENT_STATUSES = [
  "describing",
  "in-design",
  "planned",
  "in-progress",
  "quality-check",
  "on-hold",
]

// ── bridge transport (the instrument, not the subject) ──────────────────────

/**
 * The daemon's service-token credential.
 *
 * TODO(test-author): identical to the note in `15-sync-bridge.spec.ts`,
 * `11-question-channel.spec.ts` and `13-design-rounds.spec.ts` — the contract
 * pins the two header names and pins missing/invalid ⇒ 401, but not how a Worker
 * booted by `npm run serve:acceptance` (no Access in front of it) learns which
 * pair is valid. Same escape hatch, same invented defaults.
 */
const SERVICE_TOKEN = {
  "CF-Access-Client-Id":
    process.env.COORD_BRIDGE_CLIENT_ID ?? "9f2c17b4a8de40518c6b3ad0e75f1c62.access",
  "CF-Access-Client-Secret":
    process.env.COORD_BRIDGE_CLIENT_SECRET ??
    "4d1e9c07b35a2f68e4c81079ba6d35f2c9017e4ab8d562309fc71ea48b0d63a5",
}

interface PushResult {
  submission_id: string
  outcome: string
  reason?: string
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

/** Apply a coord-owned status and insist it landed — this is the instrument. */
async function pushStatus(
  request: APIRequestContext,
  reference: string,
  revision: number,
  status: string,
): Promise<PushResult> {
  return pushFields(request, reference, revision, { status })
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

const ROUND = {
  round: 1,
  outcome: "Volunteers can see a watering rota for the greenhouse on their phone.",
  decomposition: [
    "A rota page showing who waters which beds this week",
    "A way for a volunteer to swap a shift with someone else",
  ],
  mockBundleUrl: "https://mocks.example.test/rota/round-1/",
}

const QUESTION =
  "Should volunteers who swap a shift need the rota owner to confirm it, or is a straight swap enough?"

/**
 * One inbox per test. The acceptance database is wiped per *run*, not per *test*
 * (tests/acceptance/README.md § Determinism), and an outbox is cumulative by
 * nature — so isolation here comes from each test owning a distinct synthetic
 * recipient rather than from a clean table. Every address is invented, on the
 * reserved `example.test` TLD.
 */
const INBOX = {
  signoff: "rota-signoff@example.test",
  question: "rota-question@example.test",
  shipped: "rota-shipped@example.test",
  silence: "rota-silence@example.test",
  churn: "rota-churn@example.test",
  envelope: "rota-envelope@example.test",
  cta: "rota-cta@example.test",
  ownerA: "rota-owner-a@example.test",
  ownerB: "rota-owner-b@example.test",
  wall: "rota-wall@example.test",
  repeat: "rota-repeat@example.test",
  screens: "rota-screens@example.test",
}

const REFERENCE = /^SUB-[A-Z0-9]{6}$/

// ── seeding and reading, through the pinned customer surface ────────────────

/** The verified-identity mechanism the contract's screens assume is present. */
function asCustomer(page: Page, email: string) {
  return page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": email })
}

async function pageFor(browser: Browser, email: string): Promise<Page> {
  const context = await browser.newContext({
    extraHTTPHeaders: { "Cf-Access-Authenticated-User-Email": email },
  })
  return context.newPage()
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

// ── the outbox, read as the contract's email DOM ────────────────────────────

interface Sent {
  type: string | null
  from: string | null
  to: string | null
  subject: string | null
  preheader: string | null
  body: string | null
  ctaText: string | null
  ctaHref: string | null
  text: string
  missing: string[]
}

/**
 * Read every `email-preview` the portal will admit to having sent, in the DOM
 * the contract pins for it. `to` filters client-side on `email-to`: an outbox
 * scoped to the caller by Access and a global one both satisfy the contract, and
 * filtering makes this slice indifferent to which was built.
 */
async function readOutbox(page: Page, to?: string): Promise<Sent[]> {
  const path = await outboxPath(page)
  const response = await page.goto(path)
  expect(response?.ok(), NO_OUTBOX).toBe(true)

  const previews = page.getByTestId("email-preview")
  const count = await previews.count()
  const sent: Sent[] = []

  for (let i = 0; i < count; i++) {
    const preview = previews.nth(i)
    const missing: string[] = []
    const read = async (testid: string): Promise<string | null> => {
      const node = preview.getByTestId(testid)
      if ((await node.count()) === 0) {
        missing.push(testid)
        return null
      }
      return flat(await node.first().innerText())
    }

    const cta = preview.getByTestId("email-cta")
    sent.push({
      type: await preview.getAttribute("data-email-type"),
      from: await read("email-from"),
      to: await read("email-to"),
      subject: await read("email-subject"),
      preheader: await read("email-preheader"),
      body: await read("email-body"),
      ctaText: (await cta.count()) > 0 ? flat(await cta.first().innerText()) : null,
      ctaHref: (await cta.count()) > 0 ? await cta.first().getAttribute("href") : null,
      text: flat(await preview.innerText()),
      missing,
    })
  }

  if (to === undefined) return sent
  return sent.filter((email) => email.to !== null && email.to.includes(to))
}

/**
 * Wait for the outbox to hold exactly `expected` emails for `to`, then return
 * them. Sends may be queued rather than synchronous — issue #14 is explicitly
 * "digest-first, not instant" — so this polls rather than reading once.
 */
async function awaitOutbox(page: Page, to: string, expected: number): Promise<Sent[]> {
  let sent: Sent[] = []
  await expect
    .poll(
      async () => {
        sent = await readOutbox(page, to)
        return sent.length
      },
      {
        message: `${to} must have exactly ${expected} email(s) from the portal`,
        timeout: 30_000,
      },
    )
    .toBe(expected)
  return sent
}

/**
 * Contract note 6, treated as an absolute: "no mock renders any GitHub issue
 * number, PR number, branch name, or coord-side identifier anywhere in
 * customer-facing copy". An email is the one customer-facing surface that leaves
 * the product and lands somewhere the customer keeps forever, so it is the worst
 * possible place for the wall to leak.
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

test.describe("ms-1 issue 14 customer notifications", () => {
  test("a design ready for sign-off sends the customer exactly one email", async ({
    page,
    request,
  }) => {
    // Issue #14: "Transactional email for: a design round is ready for
    // sign-off". `awaiting-signoff` is one of the two customer-actionable
    // states, so it is one of the three that may send.
    await asCustomer(page, INBOX.signoff)
    const target = await seedSubmission(page, 0)

    expect(
      (await readOutbox(page, INBOX.signoff)).length,
      "authoring a submission is not a state that emails the customer",
    ).toBe(0)

    // PROPOSE, the only way coord can — the round and the status that parks it
    // in front of the customer, in one atomic update.
    const applied = await pushFields(request, target.reference, 5000, {
      design_round: {
        round: ROUND.round,
        outcome_definition: ROUND.outcome,
        mock_bundle_url: ROUND.mockBundleUrl,
      },
      decomposition: ROUND.decomposition,
      artifacts: [{ kind: "mock-bundle", url: ROUND.mockBundleUrl }],
      status: "awaiting-signoff",
    })
    expect(applied.outcome, "a design round is entirely coord-owned").toBe("applied")

    const [email] = await awaitOutbox(page, INBOX.signoff, 1)
    expect(
      email.type,
      "contract § Emails: `awaiting-signoff` produces `data-email-type=\"signoff-ready\"`",
    ).toBe("signoff-ready")
    expect(email.missing, "the email carries every pinned hook").toEqual([])
    expect(email.to, "the send is addressed to the signed-in customer").toContain(INBOX.signoff)
    expect((email.subject ?? "").length, "an email has a subject").toBeGreaterThan(0)
    expect((email.body ?? "").length, "an email has a body").toBeGreaterThan(0)

    // TODO(test-author): the contract does NOT pin the subject line. Unlike
    // `pause-banner` ("Work is paused until you answer.") or `submit-intake`
    // ("Send to the team"), § Emails pins only the hooks, so
    // `mocks/11-email-signoff-ready.html`'s "Your design is ready for sign-off"
    // is illustrative rather than required wording. Same treatment
    // `13-design-rounds.spec.ts` gives `verdict-pill` text: presence and
    // non-emptiness are asserted, exact copy is left free.
  })

  test("a raised question sends the customer exactly one email", async ({ page, request }) => {
    // Issue #14: "Transactional email for: … a question was raised".
    // `needs-input` is the other customer-actionable state.
    await asCustomer(page, INBOX.question)
    const target = await seedSubmission(page, 1)

    // RAISE: `question` and `status` are both coord-owned and arrive together
    // (the portal never invents a question, nor the pause that accompanies it).
    const applied = await pushFields(request, target.reference, 5100, {
      question: QUESTION,
      status: "needs-input",
    })
    expect(applied.outcome, "coord owns both `question` and `status`").toBe("applied")

    const [email] = await awaitOutbox(page, INBOX.question, 1)
    expect(
      email.type,
      "contract § Emails: `needs-input` produces `data-email-type=\"needs-input\"`",
    ).toBe("needs-input")
    expect(email.missing, "the email carries every pinned hook").toEqual([])
    expect(email.to).toContain(INBOX.question)

    // The point of this email is that work has stopped and only the customer can
    // restart it — so answering must be the thing it asks for.
    expect((email.ctaText ?? "").length, "the email asks the customer to do the one thing").toBeGreaterThan(0)

    // TODO(test-author): the contract pins neither the subject nor the CTA
    // wording for any of the three emails (the mock says "Answer the question"),
    // so only presence is asserted here. What the CTA must *do* is asserted in
    // "the email's call to action brings the customer back to the submission".

    // TODO(test-author): the contract is silent on whether the question TEXT
    // itself rides in the email body. `mocks/12-email-needs-input.html` does not
    // reproduce it — it names the request and links out — so nothing below
    // requires the question to appear, and nothing forbids it either.
  })

  test("shipped work sends the customer exactly one final email", async ({ page, request }) => {
    // Issue #14: "Transactional email for: … work shipped". `shipped` is the
    // only terminal state in the pinned vocabulary.
    await asCustomer(page, INBOX.shipped)
    const target = await seedSubmission(page, 2)

    let revision = 5200
    for (const status of ["in-design", "planned", "in-progress", "quality-check"]) {
      expect(
        (await pushStatus(request, target.reference, revision++, status)).outcome,
        "`status` is coord-owned",
      ).toBe("applied")
    }
    expect(
      (await readOutbox(page, INBOX.shipped)).length,
      "the whole run-up to shipping is silent",
    ).toBe(0)

    expect(
      (await pushStatus(request, target.reference, revision++, "shipped")).outcome,
    ).toBe("applied")

    const [email] = await awaitOutbox(page, INBOX.shipped, 1)
    expect(email.type, "contract § Emails: `shipped` produces `data-email-type=\"shipped\"`").toBe(
      "shipped",
    )
    expect(email.missing, "the email carries every pinned hook").toEqual([])
    expect(email.to).toContain(INBOX.shipped)

    // Terminal means terminal: nothing after shipping re-opens the conversation.
    // (Re-pushing `shipped` is `already_applied` — nothing changed, so there is
    // nothing new to tell the customer.)
    expect(
      (await pushStatus(request, target.reference, revision - 1, "shipped")).outcome,
      "a repeated push of the same revision is idempotent",
    ).toBe("already_applied")
    expect(
      (await pushFields(request, target.reference, revision++, {
        artifacts: [{ kind: "screenshot", url: "https://mocks.example.test/rota/shipped.png" }],
      })).outcome,
    ).toBe("applied")

    expect(
      (await readOutbox(page, INBOX.shipped)).length,
      "shipped is the last email about this request",
    ).toBe(1)
  })

  test("only the three customer-facing states ever send an email", async ({ page, request }) => {
    // THE INVARIANT, stated by the contract itself: "those three states — and
    // *only* those three — ever generate an email send. This is a black-box
    // invariant: a test may assert that no other status transition produces
    // `email-preview` output."
    await asCustomer(page, INBOX.silence)
    const target = await seedSubmission(page, 3)

    let revision = 5300
    for (const status of SILENT_STATUSES) {
      const result = await pushStatus(request, target.reference, revision++, status)
      // `on-hold`'s customer visibility is unresolved (contract note 1), so its
      // push is allowed to be refused — what is NOT allowed, either way, is an
      // email about it.
      if (status !== "on-hold") {
        expect(result.outcome, `\`${status}\` is a coord-owned status push`).toBe("applied")
      }

      expect(
        (await readOutbox(page, INBOX.silence)).length,
        `\`${status}\` is neither customer-actionable nor terminal — it must not send`,
      ).toBe(0)
    }

    // Positive control. Absence is only meaningful next to a presence that the
    // same mechanism *did* observe: without this, an outbox that is broken and
    // an outbox that is correctly empty look identical.
    expect(
      (await pushStatus(request, target.reference, revision++, "shipped")).outcome,
    ).toBe("applied")
    const sent = await awaitOutbox(page, INBOX.silence, 1)
    expect(
      sent.map((email) => email.type),
      "six silent transitions and one terminal one produce exactly one email",
    ).toEqual(["shipped"])
  })

  test("the pipeline breathing never reaches the customer's inbox", async ({ page, request }) => {
    // Issue #14, verbatim: "a customer does not need to watch the pipeline
    // breathe". Contract § "Route surface" / issue #10: "request-changes
    // reviews, merge conflicts and CI churn stay hidden inside In progress /
    // Quality check." Churn that is invisible on the screen must be equally
    // invisible in the inbox.
    await asCustomer(page, INBOX.churn)
    const target = await seedSubmission(page, 0)

    let revision = 5400
    for (let cycle = 0; cycle < 3; cycle++) {
      // A build fails, work goes back, a decomposition item is re-planned, an
      // artifact is replaced, the daemon checks in. Five heartbeats of a
      // pipeline; zero of them are the customer's business.
      expect(
        (await pushStatus(request, target.reference, revision++, "in-progress")).outcome,
      ).toBe("applied")
      expect(
        (await pushStatus(request, target.reference, revision++, "quality-check")).outcome,
      ).toBe("applied")
      expect(
        (await pushFields(request, target.reference, revision++, {
          decomposition: [...ROUND.decomposition, `A revised plan, pass ${cycle + 1}`],
        })).outcome,
      ).toBe("applied")
      expect(
        (await pushFields(request, target.reference, revision++, {
          artifacts: [{ kind: "screenshot", url: `https://mocks.example.test/rota/${cycle}.png` }],
        })).outcome,
      ).toBe("applied")

      const beat = await request.post("/api/bridge/heartbeat", {
        data: { at: `2026-08-08T19:0${cycle}:11Z` },
        headers: SERVICE_TOKEN,
      })
      expect(beat.status(), "a heartbeat is accepted").toBe(200)
    }

    expect(
      (await readOutbox(page, INBOX.churn)).length,
      "twelve coord-side updates and three heartbeats are not news",
    ).toBe(0)

    // Positive control, as above.
    expect(
      (await pushStatus(request, target.reference, revision++, "shipped")).outcome,
    ).toBe("applied")
    const sent = await awaitOutbox(page, INBOX.churn, 1)
    expect(sent[0].type, "only the terminal state broke the silence").toBe("shipped")
  })

  test("every email carries the pinned envelope, addressed to the signed-in customer", async ({
    page,
    request,
  }) => {
    // One submission, driven through all three sending states, so the envelope
    // is checked against every `data-email-type` the contract pins.
    await asCustomer(page, INBOX.envelope)
    const target = await seedSubmission(page, 1)

    let revision = 5500
    const expectedTypes: SendType[] = []
    for (const status of ["awaiting-signoff", "needs-input", "shipped"]) {
      const fields: Record<string, unknown> =
        status === "awaiting-signoff"
          ? {
              status,
              design_round: {
                round: ROUND.round,
                outcome_definition: ROUND.outcome,
                mock_bundle_url: ROUND.mockBundleUrl,
              },
              decomposition: ROUND.decomposition,
            }
          : status === "needs-input"
            ? { status, question: QUESTION }
            : { status }
      expect((await pushFields(request, target.reference, revision++, fields)).outcome).toBe(
        "applied",
      )
      expectedTypes.push(TYPE_FOR_STATUS[status])
      await awaitOutbox(page, INBOX.envelope, expectedTypes.length)
    }

    const sent = await readOutbox(page, INBOX.envelope)
    expect(
      sent.map((email) => email.type).sort(),
      "one email per sending state, and no others",
    ).toEqual([...expectedTypes].sort())

    for (const email of sent) {
      expect(
        SENDING_TYPES as readonly string[],
        "contract § Emails pins `signoff-ready` / `needs-input` / `shipped`",
      ).toContain(email.type)
      expect(
        email.missing,
        `an \`${email.type}\` email is missing pinned hooks: ${email.missing.join(", ")}`,
      ).toEqual([])

      for (const testid of EMAIL_TESTIDS) {
        expect(email.missing, `the email renders \`${testid}\``).not.toContain(testid)
      }

      expect(email.from, "an email says who it is from").toContain("@")
      expect(email.to, "…and reaches the customer who owns the submission").toContain(
        INBOX.envelope,
      )
      expect((email.subject ?? "").length, "…with a subject").toBeGreaterThan(0)
      expect((email.preheader ?? "").length, "…a preheader").toBeGreaterThan(0)
      expect((email.body ?? "").length, "…a body").toBeGreaterThan(0)
      expect((email.ctaText ?? "").length, "…and a call to action").toBeGreaterThan(0)
    }

    // TODO(test-author): the contract pins `email-from` as a hook but not the
    // sending address (`mocks/11-13` all show
    // `coord-portal <notify@intake.heurontech.com>`), so only "it looks like an
    // address" is asserted. Pinning the domain here would freeze a deployment
    // detail into the oracle.
    //
    // TODO(test-author): **"digest-first, not instant" is not asserted, because
    // the contract pins no cadence and the mocks contradict the obvious reading
    // of the phrase.** Issue #14's title says digest-first; each of
    // `mocks/11-13` renders ONE email about ONE request, with a preheader naming
    // that single request — i.e. not a roll-up of several submissions. This spec
    // follows the mocks (which the contract calls part of itself) and asserts
    // one send per qualifying transition, with `awaitOutbox` polling for 30s so
    // a batched-on-a-timer implementation still passes. If "digest" is meant to
    // mean "several submissions collapsed into one message", the contract needs
    // a window and a combined-email DOM before it can be tested — neither
    // exists today.
  })

  test("the email's call to action brings the customer back to the submission", async ({
    page,
    request,
  }) => {
    // Issue #14's whole premise: "The async loop only works if 'come back later'
    // actually reaches the customer." An email that reaches them and does not
    // bring them back has not done the job.
    await asCustomer(page, INBOX.cta)
    const target = await seedSubmission(page, 2)

    expect(
      (await pushFields(request, target.reference, 5600, {
        question: QUESTION,
        status: "needs-input",
      })).outcome,
    ).toBe("applied")

    const [email] = await awaitOutbox(page, INBOX.cta, 1)
    expect(email.ctaHref, "the call to action points somewhere").toBeTruthy()
    expect(email.ctaHref, "…and not at nothing").not.toBe("#")

    // A real email carries an absolute URL, and this suite must not leave the
    // test server to follow it — so only the path is used.
    const destination = new URL(email.ctaHref as string, "http://127.0.0.1:8789")
    await page.goto(`${destination.pathname}${destination.search}`)

    await expect(
      page.getByTestId("submission-detail"),
      "the call to action lands on a submission, not on a marketing page",
    ).toBeVisible()
    expect(
      await page.getByTestId("submission-reference").innerText(),
      "…and on the submission the email was about",
    ).toContain(target.reference)
    expect(
      await page.getByTestId("status-pill").getAttribute("data-status"),
      "…in the state that generated the send",
    ).toBe("needs-input")

    // TODO(test-author): the contract pins `email-cta` as a hook but pins no URL
    // shape for it — § "Route surface" lists no email-tracking or redirect route
    // and the mocks use a placeholder `href="#"`. So the destination is asserted
    // by where following it *lands* (a pinned route, § "Route surface":
    // `GET /submissions/:id`), not by matching a literal URL. A signed or
    // redirecting link passes as long as it arrives at the right submission.
  })

  test("an email about one customer's submission never reaches another customer", async ({
    browser,
    request,
  }) => {
    // Contract § "Route surface": `GET /submissions` returns "the signed-in
    // customer's own submissions, and only their own". A notification is the one
    // place that guarantee leaves the site — a mis-addressed send exports a
    // customer's private request to a stranger's inbox, where no later fix can
    // recall it.
    const alice = await pageFor(browser, INBOX.ownerA)
    const bob = await pageFor(browser, INBOX.ownerB)

    const target = await seedSubmission(alice, 3)
    // Bob has a submission of his own, so his outbox is exercised rather than
    // merely empty for want of anything to notify him about.
    const bobs = await seedSubmission(bob, 0)

    expect(
      (await pushFields(request, target.reference, 5700, {
        question: "Should the seed-library count include people who only browse?",
        status: "needs-input",
      })).outcome,
    ).toBe("applied")

    const [toAlice] = await awaitOutbox(alice, INBOX.ownerA, 1)
    expect(toAlice.type).toBe("needs-input")
    expect(toAlice.to, "the owner is told").toContain(INBOX.ownerA)

    const bobsMail = await readOutbox(bob, INBOX.ownerB)
    expect(
      bobsMail.length,
      "nothing happened to Bob's submission, so Bob hears nothing",
    ).toBe(0)

    // …and nothing anywhere in what Bob can read mentions Alice's request.
    for (const email of await readOutbox(bob)) {
      expect(
        email.text,
        "another customer's reference must not appear in this inbox",
      ).not.toContain(target.reference)
      expect(email.to, "…nor may a send be addressed to them here").not.toContain(INBOX.ownerA)
    }

    // Then Bob's own submission does notify Bob — the address is derived from
    // ownership, not stuck on one account.
    expect((await pushStatus(request, bobs.reference, 5750, "shipped")).outcome).toBe("applied")
    const [toBob] = await awaitOutbox(bob, INBOX.ownerB, 1)
    expect(toBob.type).toBe("shipped")

    expect(
      (await readOutbox(alice, INBOX.ownerA)).length,
      "Bob's shipment is not Alice's news",
    ).toBe(1)

    await alice.context().close()
    await bob.context().close()

    // TODO(test-author): the contract does not say WHOSE address a notification
    // uses — the Access identity that authored the submission is the only
    // black-box candidate (§ "Route surface" scopes everything by the caller,
    // and `mocks/11-13` address a single person), but no field is pinned for it
    // and the sole-writer table lists no `recipient`. This test asserts the
    // behavioural guarantee (the owner is told, nobody else is) without pinning
    // the mechanism.
  })

  test("no engineer-side identifier reaches the customer's inbox", async ({ page, request }) => {
    // Issue #16, treated by contract note 6 as an absolute: customers "never see
    // a branch, an issue number, or a live agent". An email is the worst place
    // to leak one — it is the only customer-facing artefact that leaves the
    // product and is archived by the recipient.
    await asCustomer(page, INBOX.wall)
    const target = await seedSubmission(page, 1)

    let revision = 5800
    expect(
      (await pushFields(request, target.reference, revision++, {
        status: "awaiting-signoff",
        design_round: {
          round: ROUND.round,
          outcome_definition: ROUND.outcome,
          mock_bundle_url: ROUND.mockBundleUrl,
        },
        decomposition: ROUND.decomposition,
      })).outcome,
    ).toBe("applied")
    await awaitOutbox(page, INBOX.wall, 1)

    expect(
      (await pushFields(request, target.reference, revision++, {
        question: QUESTION,
        status: "needs-input",
      })).outcome,
    ).toBe("applied")
    await awaitOutbox(page, INBOX.wall, 2)

    expect((await pushStatus(request, target.reference, revision++, "shipped")).outcome).toBe(
      "applied",
    )
    const sent = await awaitOutbox(page, INBOX.wall, 3)

    for (const email of sent) {
      // Positive control first: an email that failed to render leaks nothing and
      // proves nothing.
      expect(email.text.length, "the email really rendered").toBeGreaterThan(0)
      for (const [pattern, why] of FORBIDDEN) {
        expect(email.text, `an \`${email.type}\` email: ${why}`).not.toMatch(pattern)
      }
    }

    // TODO(test-author): the contract does not say whether the portal must
    // SCRUB coord-authored text (a question or a decomposition pushed with an
    // issue number in it) before quoting it into an email, or whether keeping
    // the wall clean is coord's duty before it crosses the bridge — the same
    // unresolved ownership `11-question-channel.spec.ts` and
    // `13-design-rounds.spec.ts` both record. This test therefore uses clean
    // synthetic content and asserts the portal's own email chrome adds no
    // identifier; it does not assert that dirty input gets sanitised.
  })

  test("a re-applied push does not re-send an email", async ({ page, request }) => {
    // Contract § push: "Idempotent by `(submission_id, revision)`: a revision
    // less than or equal to the stored one is `already_applied` — not an error.
    // Assume every request arrives twice." A daemon that retries must not turn
    // one design round into three emails; that is precisely how "digest-first,
    // not instant" fails in practice.
    await asCustomer(page, INBOX.repeat)
    const target = await seedSubmission(page, 2)

    const round = {
      status: "awaiting-signoff",
      design_round: {
        round: ROUND.round,
        outcome_definition: ROUND.outcome,
        mock_bundle_url: ROUND.mockBundleUrl,
      },
      decomposition: ROUND.decomposition,
    }

    expect((await pushFields(request, target.reference, 5900, round)).outcome).toBe("applied")
    await awaitOutbox(page, INBOX.repeat, 1)

    // The same request, twice more — once at the same revision, once behind it.
    expect(
      (await pushFields(request, target.reference, 5900, round)).outcome,
      "the same revision again is already_applied",
    ).toBe("already_applied")
    expect(
      (await pushFields(request, target.reference, 5899, round)).outcome,
      "a stale revision is already_applied",
    ).toBe("already_applied")

    // Positive control that also flushes the queue: a genuinely new sending
    // state. If either replay HAD sent, the count below would be 3, not 2.
    expect(
      (await pushFields(request, target.reference, 5901, {
        question: QUESTION,
        status: "needs-input",
      })).outcome,
    ).toBe("applied")
    const sent = await awaitOutbox(page, INBOX.repeat, 2)
    expect(
      sent.map((email) => email.type).sort(),
      "two real transitions, two emails — replays added nothing",
    ).toEqual(["needs-input", "signoff-ready"])

    // TODO(test-author): the contract does not say whether re-ENTERING a sending
    // state legitimately re-sends — coord proposing round 2 after changes were
    // requested is plainly new news, and a second question plainly is too, but
    // neither issue #14 nor the contract commits to it. Only the unambiguous
    // case is asserted here: an `already_applied` push changed nothing, so there
    // is nothing to tell the customer about.
  })

  test("the customer portal itself never renders an email", async ({ page, request }) => {
    // Contract § mock inventory, for all three email mocks: "not a portal route
    // — transactional email". The email DOM belongs in a message, not on a
    // screen; a portal that renders its own outbox chrome into
    // `/submissions/:id` has confused the two.
    await asCustomer(page, INBOX.screens)
    const target = await seedSubmission(page, 3)

    expect(
      (await pushFields(request, target.reference, 6000, {
        question: QUESTION,
        status: "needs-input",
      })).outcome,
    ).toBe("applied")
    // Prove a send really happened, so the absences below are meaningful.
    await awaitOutbox(page, INBOX.screens, 1)

    for (const route of ["/intake", "/submissions", target.url, `${target.url}/rounds`]) {
      await page.goto(route)
      await expect(
        page.getByTestId("email-preview"),
        `\`${route}\` is a portal route, not an inbox`,
      ).toHaveCount(0)
      for (const testid of EMAIL_TESTIDS) {
        await expect(
          page.getByTestId(testid),
          `\`${route}\` must not render \`${testid}\``,
        ).toHaveCount(0)
      }
    }

    // TODO(test-author): `/submissions/:id/rounds` is asserted alongside the
    // rest because the contract pins it as a customer route; if a submission has
    // no rounds the page may legitimately be empty, which does not weaken the
    // assertion (an empty page renders no email either).
  })
})
