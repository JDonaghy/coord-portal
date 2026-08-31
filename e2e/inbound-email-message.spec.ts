import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test"
import {
  insertClientRow,
  insertProjectRow,
  insertSubmissionRow,
  readMessagesForSubmission,
  readSubmissionStatus,
} from "./client-fixtures"

/**
 * Black-box coverage for issue #165 ([portal] EM-5: an email from a known
 * client lands on the matched project's thread), driving the real Worker
 * under `wrangler dev` with real local D1 — see `playwright.config.ts`. This
 * is the project's own `e2e/` tier, not the sealed acceptance suite under
 * `tests/acceptance/`; per CLAUDE.md this repo still ships its own
 * behavioural coverage for behaviour-changing work, and the sealed suite's
 * independence is exactly why it does not substitute for this file.
 *
 * WHAT THIS FILE IS FOR, THAT `e2e/inbound-router.spec.ts` IS NOT. That file
 * proves the router's own rung-by-rung decision (`routed_kind`/`routed_rung`/
 * `routed_reason`/`routed_runner_up`) is wired to the real `email()` path.
 * This file proves what EM-5 itself adds on top of that decision: a
 * `"message"` decision actually appends to `messages` (never moving
 * `submissions.status`), an `"unrouted"` decision appends nothing anywhere,
 * and every routed outcome — matched or unrouted alike — still drafts a
 * pending acknowledgement into `outbox`, the same enqueue path EM-4 built for
 * the stranger case.
 *
 * `serve:test` does NOT wipe `.wrangler/state` between runs, so every fixture
 * carries a per-run unique identity and every assertion filters the read-back
 * to its own rows — the same trick `e2e/inbound-router.spec.ts` and
 * `e2e/inbound-email-lead.spec.ts` already use.
 *
 * Every address, name, subject and body is invented on the reserved
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
  messageId: string
  dmarc?: "pass" | "fail"
  body?: string
}

function blob(options: BlobOptions): string {
  const headers = [
    `From: Fixture Sender <${options.from}>`,
    `To: ${options.to ?? "intake@mail.example.test"}`,
    `Subject: ${options.subject ?? "Following up"}`,
    "Date: Tue, 25 Aug 2026 09:14:00 +0000",
    `Message-ID: <${options.messageId}>`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
  ]
  if (options.dmarc !== undefined) {
    headers.push(`Authentication-Results: mx.example.test; dmarc=${options.dmarc} header.from=sender.example.test`)
  }
  return `${headers.join("\r\n")}\r\n\r\n${options.body ?? "Just checking in on this."}\r\n`
}

/** The `inbound_emails` row as `POST /__email` renders it — EM-3's and EM-5's own columns. */
interface DoorResponse {
  id: string
  disposition: string
  from_email: string
  to_email: string
  routed_kind: string | null
  routed_rung: number | null
  routed_project_id: string | null
  routed_submission_id: string | null
  routed_lead_id: string | null
  outbox_id: string | null
}

async function deliver(
  request: APIRequestContext,
  options: BlobOptions & { envelopeTo?: string },
): Promise<DoorResponse> {
  const params = new URLSearchParams({
    to: options.envelopeTo ?? options.to ?? "intake@mail.example.test",
    from: options.from,
  })
  const res = await request.post(`/__email?${params.toString()}`, {
    data: blob(options),
    headers: { "content-type": "message/rfc822" },
  })
  expect(res.status(), "POST /__email must exist under MAIL_PROVIDER=fake").toBe(200)
  return (await res.json()) as DoorResponse
}

async function contextFor(browser: Browser, baseURL: string | undefined, email: string) {
  return browser.newContext({ baseURL, extraHTTPHeaders: { [ACCESS_HEADER]: email } })
}

function leadRowFor(page: Page, email: string) {
  return page.getByTestId("lead-row").filter({ hasText: email })
}

test.describe("issue #165 — a known sender's message lands on the matched project's thread", () => {
  test("rung 3 — appends exactly one messages row on the client's newest submission, and changes no submissions.status", async ({
    request,
    browser,
    baseURL,
  }) => {
    const clientEmail = uniqueEmail("em5-rung3")
    const client = insertClientRow(clientEmail)
    const project = insertProjectRow({ clientId: client, customerEmail: clientEmail, name: "Rung 3 Thread Project" })
    const submission = insertSubmissionRow({ customerEmail: clientEmail, projectId: project })

    const statusBefore = readSubmissionStatus(submission.reference)

    const body = "Any update on the booking screen we discussed?"
    const door = await deliver(request, {
      from: clientEmail,
      dmarc: "pass",
      messageId: `em5-rung3-${tag()}@sender.example.test`,
      subject: "checking in",
      body,
    })

    expect(door.routed_kind).toBe("message")
    expect(door.routed_rung).toBe(3)
    expect(door.routed_project_id).toBe(project)
    expect(door.routed_submission_id).toBe(submission.reference)
    expect(door.outbox_id, "issue #165 scope item 3 — the routed draft").not.toBeNull()

    const messages = readMessagesForSubmission(submission.reference)
    expect(messages, "exactly one messages row, on the matched submission").toHaveLength(1)
    expect(messages[0]?.author_role).toBe("customer")
    expect(messages[0]?.author_email).toBe(clientEmail)
    expect(messages[0]?.body).toBe(body)

    expect(
      readSubmissionStatus(submission.reference),
      "a message never moves submissions.status — migrations/0014_messages.sql's own rule",
    ).toBe(statusBefore)

    // The routed acknowledgement lands in the sender's own outbox, pending,
    // linking back to the exact submission the message just joined.
    const customerContext = await contextFor(browser, baseURL, clientEmail)
    const customer = await customerContext.newPage()
    await customer.goto("/outbox")
    const preview = customer.getByTestId("email-preview")
    await expect(preview).toHaveCount(1)
    await expect(preview).toHaveAttribute("data-email-type", "intake-reply")
    await expect(preview).toHaveAttribute("data-status", "queued")
    await expect(customer.getByTestId("email-cta")).toHaveAttribute("href", `/submissions/${submission.id}`)
    await customerContext.close()
  })

  test("re-delivering the same message posts no second message and drafts no second acknowledgement", async ({
    request,
  }) => {
    const clientEmail = uniqueEmail("em5-rung3-redeliver")
    const client = insertClientRow(clientEmail)
    const project = insertProjectRow({ clientId: client, customerEmail: clientEmail, name: "Redeliver Project" })
    const submission = insertSubmissionRow({ customerEmail: clientEmail, projectId: project })

    const opts: BlobOptions = {
      from: clientEmail,
      dmarc: "pass",
      messageId: `em5-redeliver-${tag()}@sender.example.test`,
      subject: "one more time",
      body: "Sending this again in case it did not go through.",
    }

    const first = await deliver(request, opts)
    expect(first.routed_kind).toBe("message")
    expect(first.outbox_id).not.toBeNull()

    const second = await deliver(request, opts)
    expect(second.id, "the redelivery guard resolves to the same row").toBe(first.id)
    expect(second.outbox_id).toBe(first.outbox_id)

    expect(
      readMessagesForSubmission(submission.reference),
      "one message delivered twice must post one message, not two",
    ).toHaveLength(1)
  })

  test("rung 1 — a plus-addressed reply routes to the named submission even when the sender's identity would have pointed elsewhere", async ({
    request,
  }) => {
    const owner = uniqueEmail("em5-rung1-owner")
    const impostor = uniqueEmail("em5-rung1-impostor")
    // No client, no project — a bare one-off submission, so the only thing
    // that could route this message is the plus-address token itself.
    const submission = insertSubmissionRow({ customerEmail: owner })

    const body = "Replying from a different address entirely."
    const door = await deliver(request, {
      from: impostor,
      messageId: `em5-rung1-${tag()}@sender.example.test`,
      subject: "Re: your request",
      envelopeTo: `intake+${submission.reference}@mail.example.test`,
      body,
    })

    expect(door.routed_kind).toBe("message")
    expect(door.routed_rung, "the plus-address token, not sender identity, decides this").toBe(1)
    expect(door.routed_project_id, "a one-off submission has no project").toBeNull()
    expect(door.routed_submission_id).toBe(submission.reference)

    const messages = readMessagesForSubmission(submission.reference)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.author_email, "the actual sender, not the submission's owner").toBe(impostor)
    expect(messages[0]?.body).toBe(body)
  })

  test("rung 4 tie — an ambiguous two-project client parks as unrouted, posts no message, and still drafts a neutral acknowledgement", async ({
    request,
    browser,
    baseURL,
  }) => {
    const clientEmail = uniqueEmail("em5-rung4-tied")
    const client = insertClientRow(clientEmail)
    const tiedTime = new Date(Date.now() - 30_000).toISOString()

    const projectA = insertProjectRow({ clientId: client, customerEmail: clientEmail, name: "Tied Alpha" })
    const submissionA = insertSubmissionRow({
      customerEmail: clientEmail,
      projectId: projectA,
      status: "describing",
      createdAt: tiedTime,
    })
    const projectB = insertProjectRow({ clientId: client, customerEmail: clientEmail, name: "Tied Beta" })
    const submissionB = insertSubmissionRow({
      customerEmail: clientEmail,
      projectId: projectB,
      status: "describing",
      createdAt: tiedTime,
    })

    const door = await deliver(request, {
      from: clientEmail,
      dmarc: "pass",
      messageId: `em5-rung4tie-${tag()}@sender.example.test`,
      subject: "Following up",
      body: "Just checking in on things.",
    })

    expect(door.routed_kind, "a known client's tie is unrouted, not a fabricated lead").toBe("unrouted")
    expect(door.routed_rung).toBe(6)
    expect(door.routed_project_id, "nothing was confidently attached to").toBeNull()
    expect(door.routed_submission_id).toBeNull()
    expect(door.routed_lead_id, "a known client's own address never becomes a stranger's lead").toBeNull()
    expect(door.outbox_id, "issue #165's own words: draft a neutral acknowledgement anyway").not.toBeNull()

    expect(readMessagesForSubmission(submissionA.reference), "no message on either tied candidate").toHaveLength(0)
    expect(readMessagesForSubmission(submissionB.reference)).toHaveLength(0)

    const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
    const operator = await operatorContext.newPage()
    await operator.goto("/leads")
    await expect(leadRowFor(operator, clientEmail), "unrouted never becomes a lead either").toHaveCount(0)
    await operatorContext.close()

    const customerContext = await contextFor(browser, baseURL, clientEmail)
    const customer = await customerContext.newPage()
    await customer.goto("/outbox")
    const preview = customer.getByTestId("email-preview")
    await expect(preview).toHaveCount(1)
    await expect(preview).toHaveAttribute("data-email-type", "intake-reply")
    // Neutral — nothing was decided confidently enough to link to.
    await expect(customer.getByTestId("email-cta")).toHaveAttribute("href", "/")
    await customerContext.close()
  })

  test("a DMARC-fail message from a known client's address parks as unrouted and never reaches postMessage", async ({
    request,
  }) => {
    const clientEmail = uniqueEmail("em5-dmarc-fail")
    const client = insertClientRow(clientEmail)
    const project = insertProjectRow({ clientId: client, customerEmail: clientEmail, name: "DMARC Fail Project" })
    const submission = insertSubmissionRow({ customerEmail: clientEmail, projectId: project })

    const door = await deliver(request, {
      from: clientEmail,
      dmarc: "fail",
      messageId: `em5-dmarcfail-${tag()}@sender.example.test`,
      subject: "following up",
      body: "No reference quoted anywhere.",
    })

    expect(door.routed_kind, "rungs 3-5 never fire without a DMARC pass").toBe("unrouted")
    expect(door.routed_rung).toBe(6)
    expect(door.routed_project_id).toBeNull()
    expect(door.routed_submission_id).toBeNull()
    expect(door.outbox_id, "still hears back, just not on the thread").not.toBeNull()

    expect(
      readMessagesForSubmission(submission.reference),
      "postMessage is never reached for an unrouted decision",
    ).toHaveLength(0)
  })
})
