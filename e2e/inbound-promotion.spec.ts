import { expect, test, type APIRequestContext, type Browser } from "@playwright/test"
import {
  countSubmissionsForEmail,
  insertClientRow,
  insertProjectRow,
  insertSubmissionRow,
  readMessagesForSubmission,
  readSubmissionRow,
} from "./client-fixtures"

/**
 * Black-box coverage for issue #167 ([portal] EM-7: promote an inbound email
 * to a submission, in one click), driving the real Worker under `wrangler
 * dev` with real local D1 — see `playwright.config.ts`. This is the project's
 * own `e2e/` tier, not the sealed acceptance suite under `tests/acceptance/`;
 * per CLAUDE.md this repo still ships its own behavioural coverage for
 * behaviour-changing work, and the sealed suite's independence (it is written
 * by a separate agent, without sight of this implementation) is exactly why
 * it does not substitute for this file.
 *
 * Issue #167's own acceptance, in its own words: "promoting an inbound email
 * creates exactly one submission with one `submission.created` event;
 * promoting it twice still creates one; the submission lands in the matched
 * project; the original message row is unchanged." This file asserts the
 * first three from the outside (through `/replies*` and the real D1 state),
 * plus the guard rules `src/routes/replies.ts`'s own module comment pins for
 * all four of EM-6/EM-7's actions on this screen. The bridge event's own shape
 * is `createSubmissionStatements`'s job and already has dedicated coverage
 * (`test/submissions.test.ts`, `e2e/bridge.spec.ts`) — this file does not
 * re-open `/api/bridge/pull`.
 *
 * `serve:test` does NOT wipe `.wrangler/state` between runs and the suite runs
 * `fullyParallel`, so every fixture here carries a per-run unique sender
 * address and every assertion is scoped to it — the same trick
 * `e2e/replies.spec.ts` and `e2e/leads.spec.ts` already use.
 *
 * Every address, name, subject and body below is invented on the reserved
 * `example.test` TLD (RFC 6761) — CLAUDE.md rule 1: this repo is public and a
 * real customer's words in a commit cannot be taken back.
 */

const ACCESS_HEADER = "Cf-Access-Authenticated-User-Email"
const DEV_OPERATOR = "ops@example.test"

function tag(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function uniqueEmail(local: string): string {
  return `${local}-${tag()}@sender.example.test`
}

interface BlobOptions {
  from: string
  to?: string
  subject?: string
  messageId?: string
  dmarc?: "pass" | "fail"
  body?: string
}

/** One synthetic RFC 822 message, the shape `POST /__email` takes (EM-1's own door). */
function blob(options: BlobOptions): string {
  const headers = [
    `From: Fixture Sender <${options.from}>`,
    `To: ${options.to ?? "intake@mail.example.test"}`,
    `Subject: ${options.subject ?? "Following up"}`,
    "Date: Tue, 25 Aug 2026 09:14:00 +0000",
    `Message-ID: <${options.messageId ?? `em7-${tag()}@sender.example.test`}>`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
  ]
  if (options.dmarc !== undefined) {
    headers.push(`Authentication-Results: mx.example.test; dmarc=${options.dmarc} header.from=sender.example.test`)
  }
  return `${headers.join("\r\n")}\r\n\r\n${options.body ?? "Just checking in on this."}\r\n`
}

interface DoorResponse {
  id: string
  routed_kind: string | null
  outbox_id: string | null
}

async function deliver(request: APIRequestContext, options: BlobOptions): Promise<DoorResponse> {
  const params = new URLSearchParams({ to: options.to ?? "intake@mail.example.test", from: options.from })
  const res = await request.post(`/__email?${params.toString()}`, {
    data: blob(options),
    headers: { "content-type": "message/rfc822" },
  })
  expect(res.status(), "POST /__email must exist under MAIL_PROVIDER=fake").toBe(200)
  return (await res.json()) as DoorResponse
}

interface InboundReadBack {
  id: string
  promoted_at: string | null
  promoted_submission_id: string | null
  promoted_submission_reference: string | null
}

/** `GET /__email`'s read-back, filtered to one recorded row — the only way this suite observes promotion's own effect on `inbound_emails`. */
async function readInbound(request: APIRequestContext, id: string): Promise<InboundReadBack> {
  const res = await request.get("/__email")
  expect(res.ok(), "GET /__email must exist under MAIL_PROVIDER=fake").toBe(true)
  const body = (await res.json()) as { emails: InboundReadBack[] }
  const row = body.emails.find((one) => one.id === id)
  if (!row) throw new Error(`no recorded inbound row with id ${id}`)
  return row
}

async function contextFor(browser: Browser, baseURL: string | undefined, email: string) {
  return browser.newContext({ baseURL, extraHTTPHeaders: { [ACCESS_HEADER]: email } })
}

function replyRowFor(page: import("@playwright/test").Page, email: string) {
  return page.getByTestId("reply-row").filter({ hasText: email })
}

test.describe("issue #167 — EM-7: promote an inbound email to a submission, in one click", () => {
  test("promoting a matched reply mints one submission in the matched project, owned by the sender, and leaves the existing thread alone", async ({
    request,
    browser,
    baseURL,
  }) => {
    const sender = uniqueEmail("em7-core")
    const client = insertClientRow(sender)
    const project = insertProjectRow({ clientId: client, customerEmail: sender, name: `EM-7 Core ${tag()}` })
    const existing = insertSubmissionRow({ customerEmail: sender, projectId: project })

    const messageBody = `A brand new ask, buried in what looked like a reply — ${tag()}.`
    const door = await deliver(request, { from: sender, dmarc: "pass", subject: "One more thing", body: messageBody })
    expect(door.routed_kind, "an exact client match with one project is rung 3's own case").toBe("message")
    const draft = door.outbox_id ?? ""

    // EM-5's own thread write — exactly one message on the submission this
    // row matched, before promotion touches anything.
    const threadBefore = readMessagesForSubmission(existing.reference)
    expect(threadBefore, "sanity — EM-5, already landed").toHaveLength(1)

    const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
    const page = await operatorContext.newPage()
    await page.goto("/replies")
    await replyRowFor(page, sender).getByTestId("review-reply").click()
    await expect(page).toHaveURL(new RegExp(`/replies/${draft}$`))

    await expect(page.getByTestId("reply-promote-form"), "present for a matched, non-lead row").toBeVisible()
    await page.getByTestId("reply-promote-button").click()
    await expect(page).toHaveURL(/\/replies$/)

    const inbound = await readInbound(request, door.id)
    expect(inbound.promoted_at, "issue #167: promotion stamps promoted_at").not.toBeNull()
    expect(inbound.promoted_submission_id, "issue #167: promotion records the submission it minted").not.toBeNull()
    expect(inbound.promoted_submission_reference).toMatch(/^SUB-[A-Z0-9]{6}$/)

    const submission = readSubmissionRow(inbound.promoted_submission_reference as string)
    expect(submission.id, "a NEW submission, distinct from the one EM-5 threaded onto").not.toBe(existing.id)
    expect(submission.customer_email, "owned by the sender's own address").toBe(sender)
    expect(submission.project_id, "lands in the matched project").toBe(project)
    expect(submission.status, "createSubmissionStatements always creates at describing").toBe("describing")
    expect(submission.outcome, "the message body becomes the outcome").toBe(messageBody)
    expect(submission.audience, "never a guess").not.toContain(messageBody)
    expect(submission.audience.length, "a real sentence, not a blank placeholder").toBeGreaterThan(10)
    expect(submission.done_definition, "never a guess").not.toContain(messageBody)
    expect(submission.done_definition.length).toBeGreaterThan(10)

    // "The thread message EM-5 already wrote stays ... promotion adds a
    // submission, it does not rewrite history."
    expect(readMessagesForSubmission(existing.reference)).toEqual(threadBefore)
    expect(readMessagesForSubmission(submission.reference), "promotion mints a submission, not a message").toHaveLength(0)

    expect(countSubmissionsForEmail(sender), "promotion adds exactly one submission").toBe(2)
    await operatorContext.close()
  })

  test("promoting the same inbound email twice — a click, a retry and a race — converges on one submission", async ({
    request,
    browser,
    baseURL,
  }) => {
    const sender = uniqueEmail("em7-idem")
    const client = insertClientRow(sender)
    const project = insertProjectRow({ clientId: client, customerEmail: sender, name: `EM-7 Idem ${tag()}` })
    insertSubmissionRow({ customerEmail: sender, projectId: project })

    const door = await deliver(request, { from: sender, dmarc: "pass", subject: "One more ask" })
    expect(door.routed_kind).toBe("message")
    const draft = door.outbox_id ?? ""

    const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
    const page = await operatorContext.newPage()
    await page.goto(`/replies/${draft}`)
    await page.getByTestId("reply-promote-button").click()
    await expect(page).toHaveURL(/\/replies$/)

    const first = await readInbound(request, door.id)
    expect(first.promoted_submission_id).not.toBeNull()

    // A retried POST, then two genuinely concurrent ones — a double-click, or
    // an operator's second tab.
    const retry = await operatorContext.request.post(`/replies/${draft}/promote`, { form: {} })
    expect(retry.status(), "a retried promote is not an error").toBe(200)

    const raced = await Promise.all([
      operatorContext.request.post(`/replies/${draft}/promote`, { form: {} }),
      operatorContext.request.post(`/replies/${draft}/promote`, { form: {} }),
    ])
    for (const response of raced) expect(response.status()).toBe(200)

    const after = await readInbound(request, door.id)
    expect(after.promoted_submission_id, "every promote reads back the same submission").toBe(
      first.promoted_submission_id,
    )
    expect(countSubmissionsForEmail(sender), "four promotes create exactly one new submission").toBe(2)
    await operatorContext.close()
  })

  test("a discarded draft cannot be promoted afterward, and a stranger's lead-routed row has no promote path at all", async ({
    request,
    browser,
    baseURL,
  }) => {
    const discardSender = uniqueEmail("em7-discard")
    const client = insertClientRow(discardSender)
    const project = insertProjectRow({ clientId: client, customerEmail: discardSender, name: `EM-7 Discard ${tag()}` })
    insertSubmissionRow({ customerEmail: discardSender, projectId: project })

    const discardDoor = await deliver(request, { from: discardSender, dmarc: "pass", subject: "Never mind" })
    expect(discardDoor.routed_kind).toBe("message")
    const discardDraft = discardDoor.outbox_id ?? ""

    const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
    const page = await operatorContext.newPage()
    await page.goto(`/replies/${discardDraft}`)
    await page.getByTestId("reply-discard-button").click()
    await expect(page).toHaveURL(/\/replies$/)

    const before = countSubmissionsForEmail(discardSender)
    const guardedAttempt = await operatorContext.request.post(`/replies/${discardDraft}/promote`, { form: {} })
    expect(guardedAttempt.status(), "a guarded no-op, not an error").toBe(200)

    const discardInbound = await readInbound(request, discardDoor.id)
    expect(discardInbound.promoted_submission_id, "the pending guard blocks a promote after discard").toBeNull()
    expect(countSubmissionsForEmail(discardSender), "a guarded no-op creates nothing").toBe(before)

    // A genuine stranger — no client on file — routes to a lead, not a
    // project, and has no promote path on this screen at all.
    const strangerSender = uniqueEmail("em7-stranger")
    const strangerDoor = await deliver(request, { from: strangerSender, subject: "Interested in a small project" })
    expect(strangerDoor.routed_kind, "a genuine stranger is rung 6's lead case").toBe("lead")
    const strangerDraft = strangerDoor.outbox_id ?? ""

    await page.goto(`/replies/${strangerDraft}`)
    await expect(page.getByTestId("reply-promote-form"), "absent for routed_kind = lead").toHaveCount(0)

    const direct = await operatorContext.request.post(`/replies/${strangerDraft}/promote`, { form: {} })
    expect(direct.status(), "a hand-rolled POST past the missing button is still not a server error").toBe(200)

    const strangerInbound = await readInbound(request, strangerDoor.id)
    expect(strangerInbound.promoted_submission_id, "a stranger's row has no matched project to promote into").toBeNull()
    expect(countSubmissionsForEmail(strangerSender), "no submission is created for this address").toBe(0)

    await operatorContext.close()
  })
})
