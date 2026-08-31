import { expect, test, type APIRequestContext, type Page } from "@playwright/test"
import { readOutboxRowState, seedGatedOutboxRow, setOutboxApproval } from "./outbox-fixtures"

/**
 * Black-box coverage for issue #50 ([portal] The drain — a Cron Trigger that
 * sends queued outbox rows, retries, and gives up visibly), driving the real
 * Worker under `wrangler dev` with real local D1 — see `playwright.config.ts`.
 * This is the project's own `e2e/` tier, not the sealed acceptance suite under
 * `tests/acceptance/`; per CLAUDE.md this repo still ships its own coverage
 * for behaviour-changing work.
 *
 * `serve:test` now passes `wrangler dev --test-scheduled --var
 * MAIL_PROVIDER:fake` (package.json), so `GET /__scheduled` invokes
 * `src/index.ts`'s exported `scheduled()` — and through it `src/drain.ts` —
 * against the deterministic fake mail provider (`src/mailProvider.ts`), the
 * same seam the sealed `tests/acceptance/ms-3/50-drain.spec.ts` slice drives.
 * This file exists so a regression here fails fast against `wrangler dev`
 * (seconds) instead of only surfacing through the much slower acceptance run.
 *
 * The last test in this file covers issue #83 ("the notification email
 * contains no link") specifically: every other test here only ever reads
 * `/outbox`, the portal's own rendering of what it decided to send — the
 * exact surface that stayed green while every real email went out with no
 * link at all, because nothing read what the drain actually handed the
 * provider. That test reads `GET /__outbound` instead (`src/routes/outbound.ts`),
 * the dev-only recording-fake read-back #83 added.
 *
 * Every address below is invented on the reserved `example.test` TLD —
 * CLAUDE.md rule 1.
 */

const SERVICE_TOKEN = {
  "CF-Access-Client-Id": "e91a4c7b3d6f0852a1eb4907c3d612f8.access",
  "CF-Access-Client-Secret":
    "6b2e0c9a17df4358b0c67ea4152d9f7038c165ae2fb804d13c6a09e754fdc12b",
}

/** `serve:test` does not wipe `.wrangler/state` between runs — unique per run, same as `e2e/notifications.spec.ts`. */
function uniqueEmail(local: string): string {
  const tag = Math.random().toString(36).slice(2, 10)
  return `${local}-${tag}@example.test`
}

interface Seeded {
  reference: string
}

async function seedSubmission(page: Page, email: string): Promise<Seeded> {
  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": email })
  await page.goto("/intake")
  await page.getByTestId("field-outcome").fill("A synthetic outcome for e2e drain coverage.")
  await page.getByTestId("field-audience").fill("synthetic e2e readers")
  await page.getByTestId("field-done-definition").fill("The drain e2e suite goes green.")
  await page.getByTestId("submit-intake").click()
  await expect(page.getByTestId("intake-receipt")).toBeVisible()

  const reference = (await page.getByTestId("submission-reference").innerText())
    .trim()
    .replace(/^Reference\s+/, "")
  return { reference }
}

async function push(
  request: APIRequestContext,
  reference: string,
  revision: number,
  fields: Record<string, unknown>,
): Promise<{ outcome: string; reason?: string }> {
  const res = await request.post("/api/bridge/push", {
    data: { updates: [{ submission_id: reference, revision, fields }] },
    headers: SERVICE_TOKEN,
  })
  expect(res.status()).toBe(200)
  const body = (await res.json()) as { results: Array<{ outcome: string; reason?: string }> }
  const result = body.results[0]
  if (!result) throw new Error("push produced no result")
  return result
}

function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

interface Row {
  status: string | null
  pillText: string | null
  sentAt: string | null
  attempts: string | null
  lastError: string | null
  /** The CTA href `/outbox` itself renders (issue #14/#83's `email-cta` hook). */
  ctaHref: string | null
}

async function readOutbox(page: Page, email: string): Promise<Row[]> {
  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": email })
  await page.goto("/outbox")

  const previews = page.getByTestId("email-preview")
  const rows: Row[] = []
  for (let i = 0; i < (await previews.count()); i++) {
    const preview = previews.nth(i)
    const pill = preview.getByTestId("delivery-status")
    const sentAt = preview.getByTestId("delivery-sent-at")
    const attempts = preview.getByTestId("delivery-attempts")
    const lastError = preview.getByTestId("delivery-last-error")
    const cta = preview.getByTestId("email-cta")
    rows.push({
      status: await preview.getAttribute("data-status"),
      pillText: (await pill.count()) > 0 ? flat(await pill.first().innerText()) : null,
      sentAt: (await sentAt.count()) > 0 ? flat(await sentAt.first().innerText()) : null,
      attempts: (await attempts.count()) > 0 ? flat(await attempts.first().innerText()) : null,
      lastError: (await lastError.count()) > 0 ? flat(await lastError.first().innerText()) : null,
      ctaHref: (await cta.count()) > 0 ? await cta.first().getAttribute("href") : null,
    })
  }
  return rows
}

async function awaitOutbox(page: Page, email: string, expected: number): Promise<Row[]> {
  let rows: Row[] = []
  await expect
    .poll(
      async () => {
        rows = await readOutbox(page, email)
        return rows.length
      },
      { message: `${email} must have exactly ${expected} outbox row(s)`, timeout: 15_000 },
    )
    .toBe(expected)
  return rows
}

/** `GET /__scheduled` — the dev-only route that invokes `scheduled()` directly. */
async function runDrain(request: APIRequestContext): Promise<void> {
  const res = await request.get("/__scheduled")
  expect(res.ok(), "GET /__scheduled must exist under `wrangler dev --test-scheduled`").toBe(true)
}

/**
 * `GET /__scheduled` drains the WHOLE outbox, not just one recipient's rows —
 * unlike every other route in this file, it is not scoped. Two of the tests
 * below assert a row is untouched *until* a drain runs; run in parallel next
 * to any other test in this file that fires one, that assertion would fail
 * for a reason that has nothing to do with issue #50 (another test's own
 * drain call claiming this test's row first). Serial, the same trade
 * `playwright.acceptance.config.ts` makes for the sealed suite against the
 * same shared-D1 reason.
 */
test.describe.configure({ mode: "serial" })

test("the scheduled route exists and a run against an empty-for-this-recipient queue is harmless", async ({
  request,
}) => {
  await runDrain(request)
  await runDrain(request)
})

test("a queued row is untouched by the request path, and only moves once the drain runs", async ({
  page,
  request,
}) => {
  const email = uniqueEmail("e2e-drain-untouched")
  const target = await seedSubmission(page, email)
  expect((await push(request, target.reference, 1, { status: "shipped" })).outcome).toBe("applied")

  const [before] = await awaitOutbox(page, email, 1)
  expect(before?.status, "the push decides a send; nothing has drained it yet").toBe("queued")

  // Reading the outbox itself is request-path traffic — it must never move the row.
  const [stillQueued] = await readOutbox(page, email)
  expect(stillQueued?.status).toBe("queued")
})

test("the drain claims a queued row and records it sent, with a delivery time and no attempts block", async ({
  page,
  request,
}) => {
  const email = uniqueEmail("e2e-drain-sent")
  const target = await seedSubmission(page, email)
  expect((await push(request, target.reference, 1, { status: "shipped" })).outcome).toBe("applied")
  await awaitOutbox(page, email, 1)

  await runDrain(request)

  const [row] = await readOutbox(page, email)
  expect(row?.status).toBe("sent")
  expect(row?.pillText).toBe("Sent")
  expect(row?.sentAt).not.toBeNull()
  expect(row?.attempts, "a first-try success shows no attempts block").toBeNull()
  expect(row?.lastError).toBeNull()

  // Terminal: a second drain run must not disturb it.
  await runDrain(request)
  const [after] = await readOutbox(page, email)
  expect(after?.status).toBe("sent")
})

test("the drain empties a multi-row queue in one pass", async ({ page, request }) => {
  const email = uniqueEmail("e2e-drain-batch")
  const target = await seedSubmission(page, email)

  let revision = 1
  expect(
    (
      await push(request, target.reference, revision++, {
        status: "awaiting-signoff",
        design_round: {
          round: 1,
          outcome_definition: "A synthetic outcome.",
          decomposition: ["one step"],
        },
      })
    ).outcome,
  ).toBe("applied")
  await awaitOutbox(page, email, 1)
  expect(
    (await push(request, target.reference, revision++, { question: "One question.", status: "needs-input" }))
      .outcome,
  ).toBe("applied")
  await awaitOutbox(page, email, 2)
  expect((await push(request, target.reference, revision++, { status: "shipped" })).outcome).toBe(
    "applied",
  )
  const queued = await awaitOutbox(page, email, 3)
  for (const row of queued) expect(row.status).toBe("queued")

  await runDrain(request)

  const rows = await readOutbox(page, email)
  expect(rows.length).toBe(3)
  for (const row of rows) expect(row.status).toBe("sent")
})

test("the fake's mailfail hook fails a send, and one failure is a retry — not a give-up", async ({
  page,
  request,
}) => {
  const email = uniqueEmail("e2e-drain-mailfail-retry")
  const target = await seedSubmission(page, email)
  expect((await push(request, target.reference, 1, { status: "shipped" })).outcome).toBe("applied")
  await awaitOutbox(page, email, 1)

  await runDrain(request)

  const [row] = await readOutbox(page, email)
  expect(row?.status, "one failure must not skip straight to failed").toBe("queued")
  expect(row?.attempts, "a mid-retry row renders identically to a fresh one").toBeNull()
  expect(row?.lastError).toBeNull()
})

test("a permanently failing recipient gives up visibly, with an attempt count and customer-safe copy", async ({
  page,
  request,
}) => {
  test.setTimeout(60_000)
  const email = uniqueEmail("e2e-drain-mailfail-giveup")
  const target = await seedSubmission(page, email)
  expect((await push(request, target.reference, 1, { status: "shipped" })).outcome).toBe("applied")
  await awaitOutbox(page, email, 1)

  // Contract's own default: 5 attempts. One drain tick = at most one attempt.
  for (let i = 0; i < 5; i++) {
    await runDrain(request)
  }

  const [row] = await readOutbox(page, email)
  expect(row?.status, "every retry exhausted").toBe("failed")
  expect(row?.pillText).toBe("Delivery failed")
  expect(row?.attempts).toMatch(/\d+/)
  expect(row?.lastError).not.toBeNull()
  expect(row?.lastError).not.toMatch(/mailfail/i)
  expect(row?.lastError).not.toMatch(/fake/i)

  // Terminal and frozen: further drains change nothing.
  await runDrain(request)
  const [after] = await readOutbox(page, email)
  expect(after?.status).toBe("failed")
  expect(after?.attempts).toBe(row?.attempts)
})

test("two overlapping drain runs settle as exactly one send, never a doubled row", async ({
  page,
  request,
}) => {
  const email = uniqueEmail("e2e-drain-overlap")
  const target = await seedSubmission(page, email)
  expect((await push(request, target.reference, 1, { status: "shipped" })).outcome).toBe("applied")
  await awaitOutbox(page, email, 1)

  const [first, second] = await Promise.all([request.get("/__scheduled"), request.get("/__scheduled")])
  expect(first.ok() && second.ok()).toBe(true)

  const rows = await readOutbox(page, email)
  expect(rows.length, "no doubled row").toBe(1)
  expect(rows[0]?.status).toBe("sent")
  expect(rows[0]?.attempts, "a doubled claim would show a second attempt").toBeNull()
})

/**
 * Issue #83: the notification email contains no link — the CTA is built,
 * stored and rendered on `/outbox`, then dropped at the provider boundary.
 * Every assertion above this point in the file only ever reads `/outbox`
 * itself, the portal's own rendering of what it *decided* to send — exactly
 * the surface #83 found green while every real email went out linkless. This
 * test reads the OTHER artefact instead: what the drain actually handed the
 * mail provider, via `GET /__outbound` (`src/routes/outbound.ts`), the
 * dev-only read-back of `src/mailProvider.ts`'s recording fake.
 */
test("the drain hands the provider an absolute, followable link to the submission (#83)", async ({
  page,
  request,
  baseURL,
}) => {
  const email = uniqueEmail("e2e-drain-cta-link")
  const target = await seedSubmission(page, email)
  expect(
    (
      await push(request, target.reference, 1, {
        status: "awaiting-signoff",
        design_round: {
          round: 1,
          outcome_definition: "A synthetic outcome for e2e CTA-link coverage.",
          decomposition: ["one step"],
        },
      })
    ).outcome,
  ).toBe("applied")

  const [queued] = await awaitOutbox(page, email, 1)
  expect(queued?.ctaHref, "`/outbox` itself must still render the CTA — #83 did not touch that").not.toBeNull()
  const ctaPath = new URL(queued?.ctaHref ?? "", baseURL).pathname
  expect(ctaPath.length, "the CTA must point somewhere with a path").toBeGreaterThan(1)

  await runDrain(request)
  const [sent] = await readOutbox(page, email)
  expect(sent?.status).toBe("sent")

  const res = await request.get("/__outbound")
  expect(res.ok(), "GET /__outbound must exist under MAIL_PROVIDER=fake (#83)").toBe(true)
  const body = (await res.json()) as { emails: Array<{ to: string; text: string; html?: string }> }
  const mine = body.emails.filter((e) => e.to === email)
  expect(mine, `the provider must have been handed exactly one email for ${email}`).toHaveLength(1)
  const record = mine[0]
  if (!record) throw new Error("unreachable — length checked above")

  // The text part carries the URL in full, visibly — a text-only client must
  // be able to reach the submission (#83 scope item 3).
  expect(record.text).toContain(ctaPath)
  const textUrls = record.text.match(/https?:\/\/[^\s]+/g) ?? []
  expect(
    textUrls.some((u) => new URL(u).hostname.length > 0 && new URL(u).pathname === ctaPath),
    `expected an absolute, followable URL for ${ctaPath} in the text body; got: ${record.text}`,
  ).toBe(true)

  // An HTML body rides alongside it, with a real anchor to the same submission.
  expect(record.html, "#83 scope item 3: an HTML body must be handed alongside the text one").toBeTruthy()
  expect(record.html).toContain(`href="`)
  expect(record.html).toContain(ctaPath)
})

/**
 * ── ISSUE #162 (EM-2): THE APPROVAL GATE ────────────────────────────────────
 *
 * `migrations/0021_outbox_approval.sql` adds `outbox.approval_state` — a
 * second axis beside `status`, not a fourth `status` value — and `src/drain.ts`
 * gains one clause for it in both the batch SELECT and the claim UPDATE. The
 * three tests below drive that clause through the real `GET /__scheduled`
 * against real local D1, because the unit tests in `test/drain.test.ts` prove
 * only that the SQL text this module builds contains the clause; they cannot
 * prove SQLite agrees, and they cannot prove the column the migration created
 * is the one the query names.
 *
 * They live in THIS file rather than a new one for the reason the header
 * above already gives: `GET /__scheduled` drains the whole table, so a second
 * file firing it would race every "untouched until a drain runs" assertion
 * here. `test.describe.configure({ mode: "serial" })` at the top covers these
 * too.
 *
 * Seeding is `outbox-fixtures.ts`'s `seedGatedOutboxRow` / `setOutboxApproval`
 * — #162 is explicitly "no UI, no new sends, no new callers", so there is no
 * HTTP route on this side that writes the column yet, exactly the situation
 * that file exists for. `seedGatedOutboxRow` inserts the row already held
 * rather than enqueuing-then-holding, because the two Playwright projects
 * share one drain and one database; its own comment has the detail.
 *
 * "approving a held row sends it on the very next tick" below carries more
 * weight than a smoke test usually does: the sealed slice's own version of
 * that scenario cannot complete its arrange step, because it asserts the
 * approving UPDATE reported `changes === 1` and `wrangler d1 execute --local`
 * discards everything but `duration` from `meta` before printing (see
 * `outbox-fixtures.ts`'s note — reproduced at wrangler 4.120.0 and 4.127.1,
 * and not fixable from this side). This test drives the same behaviour
 * through the same real `GET /__scheduled`, and its fixture proves the
 * approval landed by reading the row back instead.
 */

/** How many emails the recording fake was handed for one address (`src/routes/outbound.ts`). */
async function outboundCount(request: APIRequestContext, email: string): Promise<number> {
  const res = await request.get("/__outbound")
  expect(res.ok(), "GET /__outbound must exist under MAIL_PROVIDER=fake").toBe(true)
  const body = (await res.json()) as { emails: Array<{ to: string }> }
  return body.emails.filter((e) => e.to === email).length
}

test("a row held for approval is never claimed by the drain, however many ticks run", async ({
  page,
  request,
}) => {
  const email = uniqueEmail("e2e-drain-approval-pending")
  const id = seedGatedOutboxRow(email, "pending")

  for (let i = 0; i < 3; i++) await runDrain(request)

  const [rendered] = await awaitOutbox(page, email, 1)
  expect(rendered?.status, "a held row stays queued — approval is not a delivery outcome").toBe("queued")

  const row = readOutboxRowState(id)
  expect(row.approval_state).toBe("pending")
  expect(row.sent_at, "a held row is never sent").toBeNull()
  expect(row.attempts, "a held row is never even claimed — no attempt is spent on it").toBe(0)
  expect(row.claimed_at, "the claim UPDATE must be gated too, not just the batch SELECT").toBeNull()
  expect(await outboundCount(request, email), "the provider must never have seen it").toBe(0)
})

test("approving a held row sends it on the very next tick", async ({ page, request }) => {
  const email = uniqueEmail("e2e-drain-approval-approved")
  const id = seedGatedOutboxRow(email, "pending")
  await runDrain(request)
  expect(readOutboxRowState(id).status, "still held before a human acts").toBe("queued")

  setOutboxApproval(id, "approved", "operator@example.test")
  await runDrain(request)

  const [rendered] = await awaitOutbox(page, email, 1)
  expect(rendered?.status, "one tick after approval, it is gone").toBe("sent")
  expect(rendered?.attempts, "the held ticks must not have burned attempts").toBeNull()

  const row = readOutboxRowState(id)
  expect(row.approval_state, "sending must not disturb the approval axis").toBe("approved")
  expect(row.approved_by).toBe("operator@example.test")
  expect(row.sent_at).not.toBeNull()
  expect(await outboundCount(request, email), "exactly one send, not one per held tick").toBe(1)
})

test("a rejected row is never sent and never retried, however many ticks run", async ({
  page,
  request,
}) => {
  const email = uniqueEmail("e2e-drain-approval-rejected")
  const id = seedGatedOutboxRow(email, "rejected")

  for (let i = 0; i < 6; i++) await runDrain(request)

  const [rendered] = await awaitOutbox(page, email, 1)
  expect(rendered?.status, "rejected is not a delivery failure — the row never entered delivery").toBe(
    "queued",
  )
  expect(rendered?.lastError, "a customer is never shown a delivery error for a row nobody sent").toBeNull()

  const row = readOutboxRowState(id)
  expect(row.approval_state).toBe("rejected")
  expect(row.sent_at).toBeNull()
  expect(
    row.attempts,
    "unlike `failed`, a rejected row is never a retry candidate — it never matches the WHERE at all",
  ).toBe(0)
  expect(row.claimed_at).toBeNull()
  expect(await outboundCount(request, email)).toBe(0)
})
