import { expect, test, type APIRequestContext, type Page } from "@playwright/test"

/**
 * ms-1 sealed acceptance slice — issue #10
 * "[portal] Up-mapping read model — customer status vocabulary + precedence +
 *  business-time On-hold"
 *
 * Written from `tests/acceptance/ms-1/contract.md` (§ "Customer status
 * vocabulary (pinned, from issue #10)") and the mocks it pins —
 * `mocks/03-dashboard.html` (one row per vocabulary value),
 * `mocks/04-submission-in-design.html` (the rollup template),
 * `mocks/09-submission-onhold.html` (provisional) and
 * `mocks/10-submission-shipped.html` — without sight of any implementation.
 *
 * SCOPE. Issue #10 rolls engineer/issue/assignment state UP into a fixed
 * customer vocabulary of nine words, and is explicit that the roll-up is
 * "computed daemon-side and pushed through the bridge — the portal renders, it
 * does not derive". That sentence decides what is black-box testable here and
 * what is not:
 *
 *  1. **The vocabulary is closed and its wording is pinned.** Nine slugs, nine
 *     exact strings, rendered on `status-pill` / `submission-detail` /
 *     `submission-row`. Anything else reaching the customer is a wall breach.
 *  2. **Only `Awaiting your sign-off`, `Quality check`, and `Needs your input`
 *     demand the customer; only `Shipped` is terminal.** The other states are
 *     read-only — "request-changes reviews, merge conflicts and CI churn stay
 *     hidden inside In progress / Quality check" (issue #10's original text,
 *     predating the amendment below — CI churn still stays hidden, but
 *     `Quality check` itself is no longer a read-only rollup state).
 *  3. **The portal renders and does not derive.** A status arrives as a
 *     coord-owned `status` field over the bridge; no other fact the daemon
 *     pushes may move it.
 *
 * AMENDED 2026-08-19 against contract.md § "Customer status vocabulary", note
 * 2 (issue #107, 2026-08-18): `quality-check` is promoted from
 * not-customer-actionable to customer-actionable — "the customer approves the
 * preview or requests changes from the submission page, exactly the same
 * shape as a design-round sign-off". This slice previously treated
 * `quality-check` as one of the four read-only rollup states sharing
 * `04-submission-in-design.html`'s template; it no longer does. Two things
 * follow, both asserted below: `quality-check` drops out of the "no demand
 * hooks" negative check, and it drops out of the rollup-template group
 * (now three states, not four).
 *
 * TODO(test-author): the contract has NOT been fully reconciled with itself
 * here. The "Mock inventory" section (`04-submission-in-design.html`'s row)
 * still reads "is the template for **all four** non-actionable rollup states
 * … In design, Planned, In progress, Quality check" — unrevised prose that
 * predates note 2 and now contradicts the pinned vocabulary table + note 2's
 * explicit "promoted … to customer-actionable". The pinned table and note 2
 * are the more specific and more recent statements, so this slice follows
 * them: `quality-check` is actionable, is out of the rollup-template group,
 * and the older "four" language is stale. What is NOT pinned by either
 * section is quality-check's exact DOM shape — no mock exists for a
 * "preview ready to approve" screen, and the `data-testid` hooks section pins
 * `approve-button` / `request-changes-button` only under "Awaiting-sign-off
 * (`05`)". This slice takes note 2's "exactly the same shape as a
 * design-round sign-off" at its word and asserts that pair specifically; if a
 * worker's implementation reasonably chooses different hooks, that is a
 * contract gap to raise, not a bug in this slice.
 *
 * NOT COVERED HERE, deliberately:
 *  - **The precedence rule for mixed-state submissions.** It is computed
 *    daemon-side (`JDonaghy/claude-coordinator#1982`), and this repo never sees
 *    the engineer-side states it resolves between — the bridge delivers one
 *    already-collapsed `status`. Its only portal-side residue is "the customer
 *    is shown exactly one word at a time, everywhere", which IS asserted. See
 *    the TODO on "a submission shows exactly one status at a time".
 *  - **The business-time On-hold threshold (~1 business day, clock pauses
 *    nights/weekends/holidays).** Contract note 2: it is "a computation rule,
 *    not a rendering rule", the contract pins only that `onhold-since` carries
 *    an ISO-8601 timestamp, and the computation happens daemon-side. Nothing in
 *    this suite can drive a business-time clock. See the on-hold test.
 *  - **Email sends.** The contract records that only the three
 *    actionable/terminal states ever generate one, but the send is issue #14's
 *    slice; asserting it here would double-report one behaviour.
 *  - **What the actionable screens contain** (`design-round`, `approve-button`,
 *    `question-thread`, …). Those are #13's and #11's slices. This slice
 *    asserts only the *absence* of demands on the non-actionable states, which
 *    is the half issue #10 owns.
 *
 * MECHANISM. `status` is coord-owned, so the only black-box way to put a
 * submission into a given customer state is a bridge push (contract § "Sync
 * bridge"); the only way to author a submission is the pinned intake form. Both
 * are other issues' surfaces, used here as instruments, not as subjects.
 *
 * SYNTHETIC DATA. Per CLAUDE.md rule 1 and the contract's "Synthetic data"
 * section, every string below is invented.
 */

// ── the pinned vocabulary ───────────────────────────────────────────────────

interface Vocab {
  slug: string
  text: string
  actionable: boolean
  terminal: boolean
}

/** Contract § "Customer status vocabulary", verbatim and in its pinned order. */
const VOCABULARY: Vocab[] = [
  { slug: "describing", text: "Describing", actionable: false, terminal: false },
  { slug: "in-design", text: "In design", actionable: false, terminal: false },
  {
    slug: "awaiting-signoff",
    text: "Awaiting your sign-off",
    actionable: true,
    terminal: false,
  },
  { slug: "planned", text: "Planned", actionable: false, terminal: false },
  { slug: "in-progress", text: "In progress", actionable: false, terminal: false },
  // Promoted to actionable 2026-08-18 (issue #107 / contract note 2). See the
  // "AMENDED" block in this file's header comment.
  { slug: "quality-check", text: "Quality check", actionable: true, terminal: false },
  { slug: "needs-input", text: "Needs your input", actionable: true, terminal: false },
  { slug: "on-hold", text: "On hold", actionable: false, terminal: false },
  { slug: "shipped", text: "Shipped", actionable: false, terminal: true },
]

const SLUGS = VOCABULARY.map((v) => v.slug)
const TEXT_FOR = new Map(VOCABULARY.map((v) => [v.slug, v.text]))

/** The pinned customer wording for a slug — `""` for anything outside the set. */
function textFor(slug: string | null): string {
  return TEXT_FOR.get(slug ?? "") ?? ""
}

/**
 * `on-hold` is held out of every *strict* assertion below.
 *
 * Contract note 1: issue #10 carries forward the open question "does On hold
 * surface to customers at all?", `mocks/09-submission-onhold.html` renders the
 * literal reading only "so there is something to react to", and a spec against
 * that screen should treat it as "optional/skippable pending a decision in
 * issue #10, not as a required pass condition". So the eight settled statuses
 * are asserted exactly; on-hold gets one dedicated test that passes under
 * either resolution of the open question.
 */
const SETTLED = VOCABULARY.filter((v) => v.slug !== "on-hold")

/**
 * Contract: `04-submission-in-design.html` "is the template for **all four**
 * non-actionable rollup states … Implementers render the identical read-only
 * template for all four; only `data-status`, the pill text, and the highlighted
 * `timeline-step` change." — that "four" is the mock-inventory section's
 * unrevised wording; per note 2 (issue #107, see this file's header comment),
 * `quality-check` is no longer one of them, so this list now has three.
 */
const ROLLUP_SLUGS = ["in-design", "planned", "in-progress"]

/** Contract § "Awaiting-sign-off (`05`)" — the pinned "act on this" pair. */
const SIGNOFF_SHAPE_TESTIDS = ["approve-button", "request-changes-button"]

/** Every affordance the contract pins as a *demand* on the customer. */
const DEMAND_TESTIDS = [
  "approve-button",
  "request-changes-button",
  "request-changes-form",
  "submit-changes",
  "changes-comment",
  "pause-banner",
  "question-thread",
  "answer-field",
  "submit-answer",
]

const ISO_8601_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/
const REFERENCE = /^SUB-[A-Z0-9]{6}$/

// ── bridge transport (the instrument, not the subject) ──────────────────────

/**
 * TODO(test-author): identical to the note in `15-sync-bridge.spec.ts` — the
 * contract pins the two header names and pins missing/invalid ⇒ 401, but not how
 * a Worker running without Access in front of it (which is what
 * `npm run serve:acceptance` boots) learns which pair is valid. Same escape
 * hatch: export `COORD_BRIDGE_CLIENT_ID` / `COORD_BRIDGE_CLIENT_SECRET` and this
 * suite presents those instead. The defaults are invented, not a credential.
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

/** Put a submission into a customer state the only way coord can: a `status` push. */
async function setStatus(
  request: APIRequestContext,
  submissionId: string,
  status: string,
  revision: number,
): Promise<PushResult> {
  return pushFields(request, submissionId, revision, { status })
}

// ── seeding and reading, through the pinned customer surface ────────────────

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
    outcome: "A reminder when a seed order has not been acknowledged.",
    audience: "our purchasing volunteer",
    doneDefinition: "An unacknowledged order is flagged after five days.",
  },
  {
    outcome: "A one-page summary of who is on the repair cafe rota.",
    audience: "the front-desk planner",
    doneDefinition: "Next month's rota prints without editing a spreadsheet.",
  },
  {
    outcome: "A weekly count of visitors to the seed library.",
    audience: "our trustees",
    doneDefinition: "The trustees see one number per week, no spreadsheet.",
  },
  {
    outcome: "A shared list of which raised beds are free to claim.",
    audience: "new plot holders",
    doneDefinition: "A new plot holder can pick a free bed unaided.",
  },
  {
    outcome: "A note when the compost delivery slot changes.",
    audience: "our site coordinator",
    doneDefinition: "The coordinator hears about a slot change the same day.",
  },
  {
    outcome: "A printable label sheet for the seed swap jars.",
    audience: "the seed swap table team",
    doneDefinition: "Labels print straight onto the sheets we already buy.",
  },
  {
    outcome: "A summary of which workshops filled up and which did not.",
    audience: "our events volunteer",
    doneDefinition: "The volunteer can see last season's fill rates at a glance.",
  },
]

/** The verified-identity mechanism the contract's screens assume is present. */
function asCustomer(page: Page, email: string) {
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

interface RenderedStatus {
  root: string | null
  pill: string | null
  pillText: string
  pillCount: number
}

/** Read the status the customer is actually shown on a detail screen. */
async function readDetailStatus(page: Page, url: string): Promise<RenderedStatus> {
  await page.goto(url)
  const detail = page.getByTestId("submission-detail")
  await expect(detail, `${url} renders a submission detail`).toBeVisible()
  const pill = page.getByTestId("status-pill")
  const pillCount = await pill.count()
  expect(pillCount, "a detail screen carries exactly one status pill").toBe(1)
  return {
    root: await detail.getAttribute("data-status"),
    pill: await pill.getAttribute("data-status"),
    pillText: (await pill.innerText()).trim(),
    pillCount,
  }
}

/** Assert a rendered status is one of the nine pinned words, wording included. */
function expectInVocabulary(shown: RenderedStatus, where: string) {
  expect(SLUGS, `${where}: data-status must be a vocabulary slug`).toContain(shown.pill)
  expect(shown.root, `${where}: the detail root and its pill agree`).toBe(shown.pill)
  expect(shown.pillText, `${where}: pill wording is pinned by the contract`).toBe(
    textFor(shown.pill),
  )
}

// ── the slice ───────────────────────────────────────────────────────────────

test.describe("ms-1 issue 10 up-mapping read model", () => {
  test("every customer status renders its pinned wording on the detail screen", async ({
    page,
    request,
  }) => {
    await asCustomer(page, "vocab@example.test")

    let revision = 100
    for (const [i, entry] of SETTLED.entries()) {
      const seeded = await seedSubmission(page, i)

      const result = await setStatus(request, seeded.reference, entry.slug, revision++)
      expect(
        result.outcome,
        `\`${entry.slug}\` is in the pinned vocabulary and coord owns \`status\``,
      ).toBe("applied")

      const shown = await readDetailStatus(page, seeded.url)
      expect(shown.pill, `${entry.slug}: the pill carries the pushed slug`).toBe(
        entry.slug,
      )
      expect(shown.root, `${entry.slug}: the detail root carries the slug too`).toBe(
        entry.slug,
      )
      expect(
        shown.pillText,
        `${entry.slug}: exact customer-visible wording is pinned`,
      ).toBe(entry.text)
    }
  })

  test("no status outside the fixed vocabulary ever reaches the customer", async ({
    page,
    request,
  }) => {
    // This customer's own address is scanned by the whole-body assertion below,
    // because issue #12 pins that "every authenticated screen names the signed-in
    // customer" — so the identity chrome is part of every page this test reads.
    // The address must therefore contain none of `ENGINEER_SIDE`. The original
    // `closed-set@example.test` contained "closed" and failed against a correct
    // implementation; the guard below now makes that mistake impossible to
    // reintroduce silently.
    const CUSTOMER = "outside-vocab@example.test"
    await asCustomer(page, CUSTOMER)

    // Issue #10: engineer/issue/assignment state is rolled UP into the fixed
    // vocabulary. Whatever the daemon's own state machine calls things, the
    // customer only ever sees one of nine words — a raw engineer-side value
    // reaching a `status-pill` is the wall breach this test exists to catch.
    const ENGINEER_SIDE = [
      "open",
      "assigned",
      "in_review",
      "review-requested",
      "changes_requested",
      "ci-failing",
      "merge-conflict",
      "rebasing",
      "blocked",
      "merged",
      "closed",
      "IN PROGRESS",
      "In progress",
      "",
    ]

    // Self-check on the fixture, not on the app: a collision here would fail the
    // body scan below while the implementation is behaving correctly, which reads
    // as a wall breach and is not one. Fail loudly and specifically instead.
    for (const raw of ENGINEER_SIDE) {
      if (raw.trim().length === 0) continue
      expect(
        CUSTOMER,
        `fixture defect, not an app defect: the signed-in address contains the ` +
          `engineer-side value ${JSON.stringify(raw)}, which the whole-body scan ` +
          "below cannot distinguish from a real leak. Choose another address.",
      ).not.toContain(raw)
    }

    let revision = 200
    for (const [i, raw] of ENGINEER_SIDE.entries()) {
      const seeded = await seedSubmission(page, i)
      const before = await readDetailStatus(page, seeded.url)
      expectInVocabulary(before, `a fresh submission (${JSON.stringify(raw)})`)

      // TODO(test-author): the contract does not say whether a non-vocabulary
      // `status` is `rejected` (with what reason?) or accepted-and-clamped, and
      // it pins `rejected`'s `reason` shape only for ownership violations. So
      // the push outcome is left tolerant; what is NOT tolerant is what the
      // customer is shown afterwards.
      await setStatus(request, seeded.reference, raw, revision++)

      const after = await readDetailStatus(page, seeded.url)
      expectInVocabulary(after, `after pushing status ${JSON.stringify(raw)}`)

      // The whole screen, not just the pill: a raw value must not leak into the
      // copy either. (The empty string is unsearchable, so it is skipped here —
      // its pill is still checked above.)
      if (raw.trim().length > 0 && !SLUGS.includes(raw)) {
        const body = await page.locator("body").innerText()
        expect(
          body,
          `the engineer-side value ${JSON.stringify(raw)} must not cross the wall`,
        ).not.toContain(raw)
      }
    }
  })

  test("only the three customer-actionable states ask the customer for anything", async ({
    page,
    request,
  }) => {
    await asCustomer(page, "actionable@example.test")

    // Contract (as amended by note 2 / issue #107): "Only `Awaiting your
    // sign-off`, `Needs your input`, and `Quality check` are customer-
    // actionable; only `Shipped` is terminal." Every other state is a
    // read-only status report — nothing on it may ask the customer to decide,
    // approve, or answer.
    //
    // TODO(test-author): the positive half — that the two actionable states DO
    // render their affordances — needs a published design round (#13) or an
    // open question (#11), neither of which this slice may assume exists, and
    // both of which those slices already own. Only the negative half is
    // asserted here.
    const NON_ACTIONABLE = SETTLED.filter((v) => !v.actionable)

    let revision = 300
    for (const [i, entry] of NON_ACTIONABLE.entries()) {
      const seeded = await seedSubmission(page, i)
      expect(
        (await setStatus(request, seeded.reference, entry.slug, revision++)).outcome,
      ).toBe("applied")

      const shown = await readDetailStatus(page, seeded.url)
      expect(shown.pill).toBe(entry.slug)

      for (const testid of DEMAND_TESTIDS) {
        await expect(
          page.getByTestId(testid),
          `\`${entry.slug}\` is not customer-actionable — no \`${testid}\``,
        ).toHaveCount(0)
      }

      // ...and no button wearing one of those demands as a label either.
      await expect(
        page.getByRole("button", {
          name: /approve|request changes|send answer|sign off/i,
        }),
        `\`${entry.slug}\` asks the customer for nothing`,
      ).toHaveCount(0)
    }
  })

  test("the three rollup states share one read-only template", async ({
    page,
    request,
  }) => {
    await asCustomer(page, "rollup@example.test")

    let revision = 400
    for (const [i, slug] of ROLLUP_SLUGS.entries()) {
      const seeded = await seedSubmission(page, i)
      expect((await setStatus(request, seeded.reference, slug, revision++)).outcome).toBe(
        "applied",
      )

      const shown = await readDetailStatus(page, seeded.url)
      expect(shown.pill).toBe(slug)
      expect(shown.pillText).toBe(textFor(slug))

      // Contract, rollup hooks: `status-timeline`, repeated `timeline-step`
      // each with `data-step` (a slug), `data-current="true"` on exactly one,
      // and `rollup-copy`.
      await expect(
        page.getByTestId("status-timeline"),
        `\`${slug}\` uses the rollup template`,
      ).toBeVisible()

      const steps = page.getByTestId("timeline-step")
      const stepCount = await steps.count()
      expect(stepCount, `\`${slug}\`: the timeline has steps`).toBeGreaterThan(0)

      const stepSlugs: string[] = []
      for (let s = 0; s < stepCount; s++) {
        stepSlugs.push((await steps.nth(s).getAttribute("data-step")) ?? "")
      }
      for (const step of stepSlugs) {
        expect(SLUGS, `\`${slug}\`: every data-step is a vocabulary slug`).toContain(step)
      }
      expect(
        new Set(stepSlugs).size,
        `\`${slug}\`: no step appears twice in the timeline`,
      ).toBe(stepSlugs.length)

      await expect(
        page.locator('[data-testid="timeline-step"][data-current="true"]'),
        `\`${slug}\`: exactly one step is current`,
      ).toHaveCount(1)

      // TODO(test-author): the contract says of the rollup template that "only
      // `data-status`, the pill text, and the highlighted `timeline-step`
      // change", but `mocks/04-submission-in-design.html` renders a five-step
      // timeline (describing → in-design → awaiting-signoff → in-progress →
      // shipped) that contains no step for `planned` or `quality-check`. The
      // contract pins neither the step list nor a mapping from an off-timeline
      // status to a step, so this asserts the only reading both sources
      // support: IF the current status has a step, that step is the current one.
      if (stepSlugs.includes(slug)) {
        await expect(
          page.locator(`[data-testid="timeline-step"][data-step="${slug}"]`),
          `\`${slug}\`: the step matching the status is the highlighted one`,
        ).toHaveAttribute("data-current", "true")
      }

      const copy = page.getByTestId("rollup-copy")
      await expect(copy, `\`${slug}\` explains itself in plain language`).toBeVisible()
      expect((await copy.innerText()).trim().length).toBeGreaterThan(0)
    }
  })

  test("internal churn stays hidden inside the rollup states", async ({
    page,
    request,
  }) => {
    await asCustomer(page, "opaque@example.test")

    // Issue #10: "request-changes reviews, merge conflicts and CI churn stay
    // hidden inside In progress / Quality check." Issue #16, restated as an
    // absolute by contract note 6: customers "never see a branch, an issue
    // number, or a live agent".
    const FORBIDDEN: Array<[RegExp, string]> = [
      [/\bmerge[ -]?conflict/i, "a merge conflict is engineer-side churn"],
      [/\bmerged?\b/i, "merges are engineer-side churn"],
      [/\brebase/i, "rebases are engineer-side churn"],
      [/\bCI\b/, "CI churn never crosses the wall"],
      [/\bbuild (failed|failure|broke)/i, "build churn never crosses the wall"],
      [/\bpull request\b/i, "no PR ever crosses the wall"],
      [/\bPR\b/, "no PR ever crosses the wall"],
      [/\bbranch(es)?\b/i, "customers never see a branch"],
      [/\bcommit(s|ted)?\b/i, "customers never see a commit"],
      [/\bworktree\b/i, "customers never see a worktree"],
      [/\bagent\b/i, "customers never see a live agent"],
      [/\bworker\b/i, "customers never see an engineer-side worker"],
      [/\bgithub\b/i, "the engineer side is not named"],
      [/\bissue\s*#?\d+/i, "customers never see an issue number"],
      [/#\d+/, "customers never see a GitHub number"],
      [/\b(feat|fix|chore|refactor)\/[a-z0-9-]+/i, "customers never see a branch name"],
      [/\breview requested\b/i, "review rounds stay hidden inside the rollup states"],
      [/\bchanges[_ -]requested\b/i, "review rounds stay hidden inside the rollup states"],
    ]

    let revision = 500
    for (const [i, slug] of ROLLUP_SLUGS.entries()) {
      const seeded = await seedSubmission(page, i)
      expect((await setStatus(request, seeded.reference, slug, revision++)).outcome).toBe(
        "applied",
      )

      // Positive control FIRST, and a demanding one: "the copy leaks nothing"
      // proves nothing about a screen that has not rendered the rollup surface
      // at all. So the full pinned rollup surface must be present before any of
      // the negatives below counts.
      const shown = await readDetailStatus(page, seeded.url)
      expect(shown.pill, `\`${slug}\`: the rollup screen really rendered`).toBe(slug)
      await expect(page.getByTestId("status-timeline")).toBeVisible()
      await expect(page.getByTestId("rollup-copy")).toBeVisible()

      const body = await page.locator("body").innerText()
      expect(body, "the screen really rendered").toContain(seeded.reference)
      expect(body).toContain(textFor(slug))

      for (const [pattern, why] of FORBIDDEN) {
        expect(body, `\`${slug}\`: ${why}`).not.toMatch(pattern)
      }
    }
  })

  test("quality-check now asks the customer to act, per the #107 amendment", async ({
    page,
    request,
  }) => {
    await asCustomer(page, "quality-check-actionable@example.test")

    // Contract note 2 (issue #107, 2026-08-18): "`Quality check` is also
    // promoted from not-customer-actionable to customer-actionable … the
    // customer approves the preview or requests changes from the submission
    // page, exactly the same shape as a design-round sign-off." The vocabulary
    // table now marks `quality-check` "yes" under "customer-actionable?",
    // alongside `awaiting-signoff` and `needs-input`.
    //
    // This is the positive half of that promotion — that *something* asks the
    // customer to act reaches this slice, because it is a direct consequence
    // of the vocabulary classification issue #10 owns. The exact contents of
    // that affordance (a design round? a bare preview link?) stay #13's,
    // consistent with this slice's SCOPE note — but "no affordance at all" is
    // no longer a legal rendering of `quality-check`, and that much is
    // squarely this slice's to assert.
    const seeded = await seedSubmission(page, 3)
    expect(
      (await setStatus(request, seeded.reference, "quality-check", 1000)).outcome,
    ).toBe("applied")

    const shown = await readDetailStatus(page, seeded.url)
    expect(shown.pill).toBe("quality-check")
    expect(shown.pillText).toBe("Quality check")

    // "Exactly the same shape as a design-round sign-off" — the only pinned
    // hooks for "approve this or ask for changes" anywhere in the contract are
    // `approve-button` / `request-changes-button` (§ "Awaiting-sign-off
    // (`05`)"). See the TODO(test-author) in this file's header comment: this
    // is the most textually-supported reading, not a hook the contract
    // re-pins verbatim for `quality-check` specifically.
    for (const testid of SIGNOFF_SHAPE_TESTIDS) {
      await expect(
        page.getByTestId(testid),
        `\`quality-check\` is customer-actionable — expected a \`${testid}\``,
      ).toBeVisible()
    }

    // And the negative this replaces: `quality-check` is no longer silent.
    const anyDemandVisible = await page
      .getByRole("button", { name: /approve|request changes/i })
      .count()
    expect(
      anyDemandVisible,
      "`quality-check` asks the customer for something, unlike the read-only rollup states",
    ).toBeGreaterThan(0)
  })

  test("quality-check's actionable screen still hides internal churn", async ({
    page,
    request,
  }) => {
    await asCustomer(page, "quality-check-opaque@example.test")

    // The churn-hiding invariant ("request-changes reviews, merge conflicts
    // and CI churn stay hidden") does not depend on whether the state is
    // read-only or actionable — only on which words may reach the customer.
    // Unlike "internal churn stays hidden inside the rollup states" above,
    // this does NOT assert `status-timeline` / `rollup-copy`: per the header
    // TODO, `quality-check`'s exact DOM shape is no longer pinned to the
    // rollup template, so only the globally-pinned hooks (`submission-detail`,
    // `status-pill`) and the whole-body text scan are used.
    const FORBIDDEN: Array<[RegExp, string]> = [
      [/\bmerge[ -]?conflict/i, "a merge conflict is engineer-side churn"],
      [/\brebase/i, "rebases are engineer-side churn"],
      [/\bCI\b/, "CI churn never crosses the wall"],
      [/\bbuild (failed|failure|broke)/i, "build churn never crosses the wall"],
      [/\bpull request\b/i, "no PR ever crosses the wall"],
      [/\bPR\b/, "no PR ever crosses the wall"],
      [/\bbranch(es)?\b/i, "customers never see a branch"],
      [/\bcommit(s|ted)?\b/i, "customers never see a commit"],
      [/\bworktree\b/i, "customers never see a worktree"],
      [/\bagent\b/i, "customers never see a live agent"],
      [/\bissue\s*#?\d+/i, "customers never see an issue number"],
      [/#\d+/, "customers never see a GitHub number"],
      [/\breview requested\b/i, "review rounds stay hidden inside the rollup states"],
    ]

    const seeded = await seedSubmission(page, 4)
    expect(
      (await setStatus(request, seeded.reference, "quality-check", 1100)).outcome,
    ).toBe("applied")

    const shown = await readDetailStatus(page, seeded.url)
    expect(shown.pill, "the quality-check screen really rendered").toBe("quality-check")

    const body = await page.locator("body").innerText()
    expect(body, "the screen really rendered").toContain(seeded.reference)
    expect(body).toContain("Quality check")

    for (const [pattern, why] of FORBIDDEN) {
      expect(body, `\`quality-check\`: ${why}`).not.toMatch(pattern)
    }
  })

  test("the dashboard renders each status with the same wording as its detail", async ({
    page,
    request,
  }) => {
    // `mocks/03-dashboard.html` renders "all 9 canonical customer-status-
    // vocabulary values … one row each". One identity of its own, because the
    // acceptance database is wiped per run and not per test, so a row count is
    // only stable for a customer nobody else seeds for.
    await asCustomer(page, "board@example.test")

    const seeded: Array<{ slug: string; entry: Seeded }> = []
    let revision = 600
    for (const [i, entry] of VOCABULARY.entries()) {
      const one = await seedSubmission(page, i)
      await setStatus(request, one.reference, entry.slug, revision++)
      seeded.push({ slug: entry.slug, entry: one })
    }

    await page.goto("/submissions")
    await expect(page.getByTestId("submission-list")).toBeVisible()
    const rows = page.getByTestId("submission-row")
    await expect(rows, "one row per submission this customer authored").toHaveCount(
      VOCABULARY.length,
    )

    for (const { slug, entry } of seeded) {
      const row = rows.filter({ hasText: entry.reference })
      await expect(row, `${entry.reference} has exactly one row`).toHaveCount(1)

      const pill = row.getByTestId("status-pill")
      await expect(pill, `${entry.reference}: one pill per row`).toHaveCount(1)

      const rowStatus = await row.getAttribute("data-status")
      const pillStatus = await pill.getAttribute("data-status")
      const pillText = (await pill.innerText()).trim()

      expect(SLUGS, `${entry.reference}: the row slug is vocabulary`).toContain(rowStatus)
      expect(pillStatus, `${entry.reference}: the row and its pill agree`).toBe(rowStatus)
      expect(pillText, `${entry.reference}: pinned wording on the dashboard too`).toBe(
        textFor(pillStatus),
      )

      // The eight settled statuses must be exactly what was pushed. `on-hold`
      // is exempt only because whether it surfaces at all is an open question
      // in issue #10 (contract note 1) — its wording is still pinned above.
      if (slug !== "on-hold") {
        expect(rowStatus, `${entry.reference}: the dashboard shows the pushed status`).toBe(
          slug,
        )
      }
    }

    // The dashboard and the detail are two renderings of one read model, never
    // two derivations of it.
    for (const { entry } of seeded) {
      const rowStatus = await rows
        .filter({ hasText: entry.reference })
        .getAttribute("data-status")
      const detail = await readDetailStatus(page, entry.url)
      expect(
        detail.pill,
        `${entry.reference}: the dashboard and the detail show one status`,
      ).toBe(rowStatus)
      await page.goto("/submissions")
    }
  })

  test("a submission shows exactly one status at a time", async ({ page, request }) => {
    await asCustomer(page, "precedence@example.test")

    // TODO(test-author): the precedence rule itself ("Implement the precedence
    // rule for mixed-state submissions") is computed daemon-side — issue #10
    // says the roll-up is "computed daemon-side and pushed through the bridge —
    // the portal renders, it does not derive" — and the bridge's pinned wire
    // shape carries a single already-collapsed `status`. The portal is never
    // shown the mixed engineer-side states the rule resolves between, so the
    // rule's ordering is not black-box observable from this repo. What IS
    // observable, and is the whole customer-facing point of collapsing a mixed
    // submission to one word, is asserted here: the customer is never shown two
    // statuses at once, and every surface shows the same one.
    const seeded = await seedSubmission(page, 0)

    let revision = 700
    for (const slug of ["in-design", "awaiting-signoff", "in-progress", "quality-check"]) {
      expect(
        (await setStatus(request, seeded.reference, slug, revision++)).outcome,
      ).toBe("applied")

      const shown = await readDetailStatus(page, seeded.url)
      expect(shown.pillCount, "never two statuses at once").toBe(1)
      expect(shown.pill, `the current status is \`${slug}\``).toBe(slug)
      expect(shown.root).toBe(slug)

      // No stale second opinion left behind anywhere on the screen: a
      // `data-status` is a claim about *this submission's* status, so every one
      // of them must say the same word. The timeline legitimately *names* the
      // other states, but it names them with `data-step`, which the contract
      // keeps deliberately distinct — so `timeline-step` is excluded here in
      // case an implementation doubles up the attribute on it.
      const claims = page.locator('[data-status]:not([data-testid="timeline-step"])')
      const claimCount = await claims.count()
      expect(claimCount, "the status is claimed somewhere").toBeGreaterThan(0)
      for (let c = 0; c < claimCount; c++) {
        expect(
          await claims.nth(c).getAttribute("data-status"),
          "no element claims a status this submission is not in",
        ).toBe(slug)
      }

      await page.goto("/submissions")
      const row = page.getByTestId("submission-row").filter({ hasText: seeded.reference })
      await expect(row).toHaveCount(1)
      expect(
        await row.getAttribute("data-status"),
        "the dashboard shows the same single status",
      ).toBe(slug)
    }
  })

  test("the portal renders the status it is given and derives none of its own", async ({
    page,
    request,
  }) => {
    await asCustomer(page, "no-derive@example.test")

    // Issue #10: "Computed daemon-side and pushed through the bridge — the
    // portal renders, it does not derive." So a coord-owned fact that is NOT
    // `status` must never move the status: a pushed question must not make the
    // portal decide the submission is `Needs your input`, and a pushed design
    // round must not make it decide `Awaiting your sign-off`. Only the daemon
    // decides that, because only the daemon knows the engineer-side states the
    // vocabulary rolls up.
    const seeded = await seedSubmission(page, 1)

    let revision = 800
    expect(
      (await setStatus(request, seeded.reference, "planned", revision++)).outcome,
    ).toBe("applied")
    expect((await readDetailStatus(page, seeded.url)).pill).toBe("planned")

    // TODO(test-author): the contract pins *which side owns* these fields but
    // not their value types (see the same note in `15-sync-bridge.spec.ts`), so
    // the push outcome is left tolerant — an implementation that has not
    // modelled `design_round` yet may reject the write. Either way the status
    // must not move, which is the invariant under test.
    const NON_STATUS_COORD_FACTS: Array<[string, unknown]> = [
      ["question", "Should the rota cover bank holidays as well?"],
      ["design_round", "A first proposal for the watering rota"],
      ["decomposition", "A printable rota page; a way to swap a shift"],
      ["artifacts", "a mock bundle for the rota screen"],
    ]

    for (const [field, value] of NON_STATUS_COORD_FACTS) {
      await pushFields(request, seeded.reference, revision++, { [field]: value })
      const shown = await readDetailStatus(page, seeded.url)
      expect(
        shown.pill,
        `pushing \`${field}\` must not make the portal derive a new status`,
      ).toBe("planned")
      expect(shown.pillText).toBe(textFor("planned"))
    }

    // And the status the daemon does push is rendered verbatim, including a
    // move the portal would have no way to infer on its own.
    expect(
      (await setStatus(request, seeded.reference, "needs-input", revision++)).outcome,
    ).toBe("applied")
    const moved = await readDetailStatus(page, seeded.url)
    expect(moved.pill).toBe("needs-input")
    expect(moved.pillText).toBe("Needs your input")
  })

  test("On hold surfaces with the pinned wording or not at all", async ({
    page,
    request,
  }) => {
    await asCustomer(page, "onhold@example.test")

    // Contract note 1, quoting issue #10 verbatim: "Open question carried
    // forward: does On hold surface to customers at all? Flagged as the most
    // opinionated knob in the vocabulary and still unanswered." The mock
    // "renders the literal reading … purely so there is something to react to"
    // and a spec against it should treat that screen as optional, "not as a
    // required pass condition".
    //
    // This test is therefore written to hold under EITHER resolution: if On
    // hold surfaces it must use the pinned word and the pinned hooks; if the
    // decision is that it does not surface, the customer must still be shown
    // one of the nine vocabulary words rather than a raw or blank status. What
    // is asserted either way is that nothing invents a tenth word.
    const seeded = await seedSubmission(page, 2)
    const result = await setStatus(request, seeded.reference, "on-hold", 900)
    expect(
      ["applied", "already_applied", "rejected"],
      "`on-hold` is in the pinned vocabulary, so a push of it is not a transport failure",
    ).toContain(result.outcome)

    const shown = await readDetailStatus(page, seeded.url)
    expectInVocabulary(shown, "after pushing `on-hold`")

    if (shown.pill === "on-hold") {
      // The literal reading. The contract pins the wording and three hooks.
      expect(shown.pillText).toBe("On hold")
      await expect(
        page.getByTestId("onhold-copy"),
        "the on-hold screen explains itself",
      ).toBeVisible()

      const since = page.getByTestId("onhold-since")
      if ((await since.count()) > 0) {
        // Contract note 2: this contract "pins only that `onhold-since` carries
        // an ISO-8601 timestamp".
        const text = (await since.innerText()).trim()
        const stamp = text.replace(/^on-hold-since:\s*/i, "").trim()
        expect(stamp, "`onhold-since` carries an ISO-8601 instant").toMatch(ISO_8601_Z)
      }

      // On hold is not customer-actionable: "no (provisional)" in the pinned
      // table. Whatever the copy says, it must not ask the customer to act.
      for (const testid of DEMAND_TESTIDS) {
        await expect(
          page.getByTestId(testid),
          `on-hold asks the customer for nothing — no \`${testid}\``,
        ).toHaveCount(0)
      }
    }

    // TODO(test-author): the business-time threshold itself (~1 business day,
    // clock pausing nights, weekends and holidays) is NOT asserted anywhere in
    // this slice. Contract note 2 records it as "a computation rule, not a
    // rendering rule", issue #10 puts the computation daemon-side, and this
    // suite has no way to advance a business-time clock against a Worker it
    // boots fresh per run. If the threshold is ever pinned as customer-visible
    // copy or as a portal-side computation, this test needs extending.
    // TODO(test-author): likewise unasserted — whether `onhold-since` is the
    // moment work paused or the moment the threshold was crossed. The contract
    // pins the format only.
  })
})
