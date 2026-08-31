import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test"

/**
 * Black-box coverage for issue #164 ([portal] EM-4: an email from a stranger
 * becomes a lead, with a drafted acknowledgement), driving the real Worker
 * under `wrangler dev` with real local D1 — see `playwright.config.ts`. This
 * is the project's own `e2e/` tier, not the sealed acceptance suite under
 * `tests/acceptance/`; per CLAUDE.md this repo still ships its own
 * behavioural coverage for behaviour-changing work, and the sealed suite's
 * independence (`tests/acceptance/ms-5/164-em4-stranger-lead.spec.ts`) is
 * exactly why it does not substitute for this file.
 *
 * Everything below goes through `POST /__email` (`src/routes/inboundTestDoor.ts`)
 * — the real `email()` path, the same door `e2e/inbound-router.spec.ts` and
 * `e2e/inbound-email.spec.ts` already use — and reads the outcome back
 * through the *ordinary* portal screens (`/leads`, `/leads/:id`, `/outbox`),
 * never a direct D1 read: the whole point of #164's own text ("the same inert
 * row on the same triage screen, promotable by the same button") is that
 * nothing here needed its own rendering path.
 *
 * `serve:test` does NOT wipe `.wrangler/state` between runs, so every fixture
 * carries a per-run unique identity and every assertion filters the read-back
 * to its own rows — the same trick `e2e/inbound-router.spec.ts` and
 * `e2e/drain.spec.ts` already use.
 *
 * Every address, name, subject and body is invented on the reserved
 * `example.test` TLD (RFC 6761) — CLAUDE.md rule 1: this repo is public and a
 * real customer's words in a commit cannot be taken back.
 */

const ACCESS_HEADER = "Cf-Access-Authenticated-User-Email"

/**
 * The operator identity `wrangler dev` honours when `OPERATOR_EMAILS` is
 * unset — see `DEV_OPERATOR_EMAIL` in `src/operators.ts` and
 * `e2e/leads.spec.ts`'s identical constant.
 */
const DEV_OPERATOR = "ops@example.test"

function tag(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function uniqueEmail(local: string): string {
  return `${local}-${tag()}@sender.example.test`
}

interface BlobOptions {
  from: string
  subject?: string
  messageId: string
  extraHeaders?: Record<string, string>
  body?: string
  /**
   * The ENVELOPE recipient — `?to=`, out of band from the blob's own `To:`
   * header, exactly as Cloudflare hands `email()` the two separately (see
   * `src/routes/inboundTestDoor.ts`). Defaults to the plain intake address;
   * a test sets it to prove what does (and does not) depend on it.
   */
  envelopeTo?: string
}

const INTAKE = "intake@mail.example.test"

function blob(options: BlobOptions): string {
  const headers = [
    `From: ${options.from}`,
    `To: ${INTAKE}`,
    `Subject: ${options.subject ?? "Hello from a stranger"}`,
    "Date: Tue, 25 Aug 2026 09:14:00 +0000",
    `Message-ID: <${options.messageId}>`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    ...Object.entries(options.extraHeaders ?? {}).map(([k, v]) => `${k}: ${v}`),
  ]
  return `${headers.join("\r\n")}\r\n\r\n${options.body ?? "I saw your site and wanted to ask about a project."}\r\n`
}

interface DoorResponse {
  id: string
  disposition: string
  from_email: string
  from_name: string | null
  to_email: string
  routed_kind: string | null
  routed_lead_id: string | null
  outbox_id: string | null
}

async function deliver(request: APIRequestContext, options: BlobOptions): Promise<DoorResponse> {
  const params = new URLSearchParams({ to: options.envelopeTo ?? INTAKE, from: options.from })
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

/** The operator's `/leads` row for one lead, found by the contact email this run minted. */
function leadRowFor(page: Page, email: string) {
  return page.getByTestId("lead-row").filter({ hasText: email })
}

/** Anchored — for matching a reference against a whole string, e.g. `door.routed_lead_id`'s reference. */
const LEAD_REFERENCE = /^LEAD-[A-Z0-9]{6}$/
/** Unanchored — for `toContainText`, which needs a substring match, not a whole-string one. */
const LEAD_REFERENCE_SUBSTRING = /LEAD-[A-Z0-9]{6}/

test.describe("issue #164 — a stranger's email becomes a lead, with a drafted acknowledgement", () => {
  test("the same createLead() /start uses produces the same inert row on the same triage screen", async ({
    request,
    browser,
    baseURL,
  }) => {
    const from = uniqueEmail("em4-plain")
    const body = "Could someone help us build a small booking page for our community garden?"

    const door = await deliver(request, {
      from: `"Dana Okafor" <${from}>`,
      subject: "Booking page for the garden",
      messageId: `em4-plain-${tag()}@sender.example.test`,
      body,
    })
    expect(door.disposition).toBe("received")
    expect(door.routed_kind, "rung 6 — a genuine stranger").toBe("lead")
    expect(door.routed_lead_id).not.toBeNull()
    expect(door.outbox_id).not.toBeNull()

    const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
    const operator = await operatorContext.newPage()
    await operator.goto("/leads")

    const row = leadRowFor(operator, from)
    await expect(row, `exactly one /leads row for ${from}`).toHaveCount(1)
    await expect(row).toHaveAttribute("data-status", "new")

    await row.getByTestId("review-lead").click()
    await expect(operator).toHaveURL(new RegExp(`/leads/${door.routed_lead_id}$`))
    await expect(operator.getByTestId("lead-detail")).toHaveAttribute("data-status", "new")
    await expect(operator.getByTestId("lead-reference")).toContainText(LEAD_REFERENCE_SUBSTRING)
    await expect(operator.getByTestId("lead-summary-full")).toHaveText(body)
    await expect(operator.getByTestId("lead-contact-email")).toHaveText(from)
    await expect(operator.getByTestId("lead-name")).toHaveText("Dana Okafor")
    await expect(
      operator.getByTestId("promote-lead-form"),
      "issue #164: promotable by the exact same, unmodified button",
    ).toBeVisible()

    await operatorContext.close()
  })

  test("a stranger with no display name leaves the lead's name null, same as /start", async ({
    request,
    browser,
    baseURL,
  }) => {
    const from = uniqueEmail("em4-noname")
    const door = await deliver(request, {
      from, // bare address — no "Display Name <addr>" wrapper
      messageId: `em4-noname-${tag()}@sender.example.test`,
      subject: "Quick question",
      body: "Do you do ongoing maintenance retainers, or one-off projects only?",
    })
    expect(door.from_name).toBeNull()
    expect(door.routed_lead_id).not.toBeNull()

    const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
    const operator = await operatorContext.newPage()
    await operator.goto(`/leads/${door.routed_lead_id}`)
    await expect(
      operator.getByTestId("lead-name"),
      "nameBlock() renders nothing when a lead has no name",
    ).toHaveCount(0)
    await operatorContext.close()
  })

  test("the lead a stranger's email produces promotes through the exact same button into a real submission", async ({
    request,
    browser,
    baseURL,
  }) => {
    const from = uniqueEmail("em4-promote")
    const door = await deliver(request, {
      from: `"Kwame Boateng" <${from}>`,
      messageId: `em4-promote-${tag()}@sender.example.test`,
      subject: "Interested in a project",
      body: "Could someone help us build a simple sign-up form for a workshop series?",
    })
    expect(door.routed_lead_id).not.toBeNull()

    const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
    const operator = await operatorContext.newPage()
    await operator.goto(`/leads/${door.routed_lead_id}`)
    await expect(operator.getByTestId("lead-detail")).toHaveAttribute("data-status", "new")
    await operator.getByTestId("promote-button").click()
    await expect(operator.getByTestId("lead-detail")).toHaveAttribute("data-status", "promoted")
    await expect(operator.getByTestId("promoted-submission-reference")).toContainText(/SUB-[A-Z0-9]{6}/)
    await operatorContext.close()
  })

  test("drafts exactly one pending outbox row, visible on the sender's own /outbox, never sent however many drain ticks run", async ({
    request,
    browser,
    baseURL,
  }) => {
    const from = uniqueEmail("em4-draft")
    const door = await deliver(request, {
      from,
      messageId: `em4-draft-${tag()}@sender.example.test`,
      subject: "Hello",
      body: "Wondering if you have capacity to take on a new client this quarter.",
    })
    expect(door.outbox_id).not.toBeNull()

    const customerContext = await contextFor(browser, baseURL, from)
    const customer = await customerContext.newPage()
    await customer.goto("/outbox")
    const preview = customer.getByTestId("email-preview")
    await expect(preview, "GET /outbox is scoped to the caller's own to_email").toHaveCount(1)
    await expect(preview).toHaveAttribute("data-email-type", "intake-reply")
    await expect(preview).toHaveAttribute("data-status", "queued")
    await expect(customer.getByTestId("email-to")).toHaveText(from)

    // Issue #162's own drain gate (already sealed) must still hold for an
    // intake-reply draft: `approval_state = 'pending'` blocks the drain no
    // matter how many ticks run.
    for (let i = 0; i < 3; i++) {
      const res = await request.get("/__scheduled")
      expect(res.ok(), "GET /__scheduled (ms-3 issue #50) should answer 2xx").toBe(true)
    }
    await customer.reload()
    await expect(customer.getByTestId("email-preview")).toHaveAttribute("data-status", "queued")
    await expect(customer.getByTestId("delivery-status")).toHaveText("Queued")

    await customerContext.close()
  })

  test("re-delivering the same message produces no second lead and no second draft", async ({
    request,
    browser,
    baseURL,
  }) => {
    const from = uniqueEmail("em4-redeliver")
    const messageId = `em4-redeliver-${tag()}@sender.example.test`
    const opts: BlobOptions = {
      from,
      messageId,
      subject: "Following up on my earlier note",
      body: "Sending this again in case it did not go through the first time.",
    }

    const first = await deliver(request, opts)
    expect(first.routed_lead_id).not.toBeNull()
    expect(first.outbox_id).not.toBeNull()

    const second = await deliver(request, opts)
    expect(second.id, "the redelivery guard resolves to the same row").toBe(first.id)
    expect(second.routed_lead_id).toBe(first.routed_lead_id)
    expect(second.outbox_id).toBe(first.outbox_id)

    // Only one lead ever reaches the operator's inbox for this sender.
    const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
    const operator = await operatorContext.newPage()
    await operator.goto("/leads")
    await expect(leadRowFor(operator, from)).toHaveCount(1)
    await operatorContext.close()

    // And only one drafted reply ever reaches the sender's own outbox.
    const customerContext = await contextFor(browser, baseURL, from)
    const customer = await customerContext.newPage()
    await customer.goto("/outbox")
    await expect(customer.getByTestId("email-preview")).toHaveCount(1)
    await customerContext.close()
  })

  test("one message delivered to two of our own addresses is still one message — one row, one lead, one draft", async ({
    request,
    browser,
    baseURL,
  }) => {
    const from = uniqueEmail("em4-two-addresses")
    const messageId = `em4-two-addresses-${tag()}@sender.example.test`
    const opts: BlobOptions = {
      from,
      messageId,
      subject: "Copied you on both addresses",
      body: "Not sure which address reaches you, so I have written to both.",
    }

    const first = await deliver(request, opts)
    expect(first.routed_lead_id).not.toBeNull()

    // Same `Message-ID`, different ENVELOPE recipient — what Cloudflare does
    // when one message names two of our addresses, and what an SMTP retry onto
    // a different alias looks like. The redelivery guard keys on the message's
    // own identity, so this resolves to the row already recorded rather than
    // acknowledging the sender twice.
    const second = await deliver(request, {
      ...opts,
      envelopeTo: "intake+SUB-ZZ9900@mail.example.test",
    })
    expect(second.id, "one Message-ID, one inbound_emails row").toBe(first.id)
    expect(second.to_email, "the row returned is the one recorded first").toBe(first.to_email)
    expect(second.routed_lead_id).toBe(first.routed_lead_id)
    expect(second.outbox_id).toBe(first.outbox_id)

    const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
    const operator = await operatorContext.newPage()
    await operator.goto("/leads")
    await expect(leadRowFor(operator, from)).toHaveCount(1)
    await operatorContext.close()

    const customerContext = await contextFor(browser, baseURL, from)
    const customer = await customerContext.newPage()
    await customer.goto("/outbox")
    await expect(customer.getByTestId("email-preview")).toHaveCount(1)
    await customerContext.close()
  })

  test("the drafted acknowledgement never quotes the sender's own message and always carries the lead's own reference", async ({
    request,
    browser,
    baseURL,
  }) => {
    const from = uniqueEmail("em4-safety")
    const canary = "purple-narwhal-invoice-4471"
    const door = await deliver(request, {
      from,
      messageId: `em4-safety-${tag()}@sender.example.test`,
      subject: "Confidential-ish request",
      body: `Please keep this quiet, but can you quote a job referencing ${canary}? Thanks.`,
    })
    expect(door.routed_lead_id).not.toBeNull()

    const operatorContext = await contextFor(browser, baseURL, DEV_OPERATOR)
    const operator = await operatorContext.newPage()
    await operator.goto(`/leads/${door.routed_lead_id}`)
    const referenceText = await operator.getByTestId("lead-reference").innerText()
    const reference = referenceText.match(/LEAD-[A-Z0-9]{6}/)?.[0]
    expect(reference, `a well-formed reference in ${JSON.stringify(referenceText)}`).toBeDefined()
    await operatorContext.close()

    const customerContext = await contextFor(browser, baseURL, from)
    const customer = await customerContext.newPage()
    await customer.goto("/outbox")
    const bodyText = await customer.getByTestId("email-body").innerText()
    const subjectText = await customer.getByTestId("email-subject").innerText()
    await customerContext.close()

    expect(bodyText, "the sender's own canary phrase must not reappear in the draft").not.toContain(canary)
    expect(subjectText).not.toContain(canary)
    expect(bodyText, "the LEAD-XXXXXX reference must appear in the drafted body").toContain(reference)
  })
})
