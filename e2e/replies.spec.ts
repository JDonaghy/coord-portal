import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test"
import { insertClientRow, insertProjectRow, insertSubmissionRow } from "./client-fixtures"
import { readOutboxRowState } from "./outbox-fixtures"

/**
 * Black-box coverage for issue #166 ([portal] EM-6: `/replies` — proof-read,
 * edit and approve a drafted reply before it sends), driving the real Worker
 * under `wrangler dev` with real local D1 — see `playwright.config.ts`. This
 * is the project's own `e2e/` tier, not the sealed acceptance suite under
 * `tests/acceptance/`; per CLAUDE.md this repo still ships its own
 * behavioural coverage for behaviour-changing work, and the sealed suite's
 * independence is exactly why it does not substitute for this file.
 *
 * WHAT IS ASSERTED HERE, THAT NOTHING ELSE IN `e2e/` COVERS. Issue #166's own
 * acceptance list, in its own order:
 *
 *   1. a non-operator gets the same 404 as for `/leads` — on the list, the
 *      detail, and every action;
 *   2. a pending draft renders with its inbound message and routing reason;
 *   3. editing the body and approving sends **the edited text**, not the
 *      original — read off `GET /__outbound`, the recording fake's own
 *      read-back, because that is what the provider was actually handed
 *      (`/outbox`'s rendering is the surface issue #83 found green while every
 *      real email went out linkless);
 *   4. approving twice sends once;
 *   5. a discarded draft never sends, however many ticks run.
 *
 * Plus the third action's own effect — "Change route ... re-render the draft
 * from the template, stay `pending`" — which the issue's table pins but its
 * acceptance list does not.
 *
 * `serve:test` does NOT wipe `.wrangler/state` between runs, and
 * `GET /__scheduled` drains the WHOLE outbox rather than one recipient's rows,
 * so every fixture here carries a per-run unique sender address and every
 * assertion filters its read-back to that address — the same trick
 * `e2e/inbound-email-message.spec.ts` and `e2e/drain.spec.ts` already use. No
 * test here asserts "a row is still queued until *my* drain runs", so none of
 * them needs the serial mode `e2e/drain.spec.ts` takes for that reason.
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
  messageId?: string
  dmarc?: "pass" | "fail"
  body?: string
  name?: string
}

/** One synthetic RFC 822 message, the shape `POST /__email` takes (EM-1's own door). */
function blob(options: BlobOptions): string {
  const headers = [
    `From: ${options.name ?? "Fixture Sender"} <${options.from}>`,
    `To: ${options.to ?? "intake@mail.example.test"}`,
    `Subject: ${options.subject ?? "Following up"}`,
    "Date: Tue, 25 Aug 2026 09:14:00 +0000",
    `Message-ID: <${options.messageId ?? `em6-${tag()}@sender.example.test`}>`,
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
  routed_rung: number | null
  routed_lead_id: string | null
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

/** `GET /__scheduled` — the dev-only route that invokes `scheduled()`, and through it the drain. */
async function runDrain(request: APIRequestContext): Promise<void> {
  const res = await request.get("/__scheduled")
  expect(res.ok(), "GET /__scheduled must exist under `wrangler dev --test-scheduled`").toBe(true)
}

interface RecordedEmail {
  to: string
  subject: string
  text: string
  html?: string
}

/** What the recording fake was actually handed for one recipient — `src/routes/outbound.ts`. */
async function sentTo(request: APIRequestContext, email: string): Promise<RecordedEmail[]> {
  const res = await request.get("/__outbound")
  expect(res.ok(), "GET /__outbound must exist under MAIL_PROVIDER=fake").toBe(true)
  const body = (await res.json()) as { emails: RecordedEmail[] }
  return body.emails.filter((one) => one.to === email)
}

async function contextFor(browser: Browser, baseURL: string | undefined, email: string) {
  return browser.newContext({ baseURL, extraHTTPHeaders: { [ACCESS_HEADER]: email } })
}

/** An operator page, already signed in as the dev operator identity. */
async function operatorPage(browser: Browser, baseURL: string | undefined): Promise<Page> {
  const context = await contextFor(browser, baseURL, DEV_OPERATOR)
  return context.newPage()
}

function replyRowFor(page: Page, email: string) {
  return page.getByTestId("reply-row").filter({ hasText: email })
}

test.describe("issue #166 — /replies, the approval gate becomes operable", () => {
  test("a non-operator gets the same 404 as for /leads — the list, the draft, and every action", async ({
    request,
    browser,
    baseURL,
  }) => {
    const sender = uniqueEmail("em6-closed")
    const door = await deliver(request, { from: sender, subject: "Closed to strangers" })
    expect(door.outbox_id, "EM-4 drafts a pending reply for a stranger").not.toBeNull()
    const draft = door.outbox_id ?? ""

    // A signed-in customer who is not on the operator allowlist, and an
    // anonymous caller, must be indistinguishable from someone asking for a
    // page that does not exist — never a 403, never a login redirect.
    const customerContext = await contextFor(browser, baseURL, uniqueEmail("em6-customer"))
    for (const context of [customerContext.request, request]) {
      for (const path of ["/replies", `/replies/${draft}`, "/leads"]) {
        const res = await context.get(path)
        expect(res.status(), `${path} must 404 for a non-operator`).toBe(404)
        expect(await res.text(), "the customer-facing not-found copy, nothing operator-shaped").toContain(
          "We can't find that",
        )
      }
      for (const action of ["approve", "discard", "route"]) {
        const res = await context.post(`/replies/${draft}/${action}`, { form: { target: "lead" } })
        expect(res.status(), `POST /replies/:id/${action} must 404 for a non-operator`).toBe(404)
      }
    }
    await customerContext.close()

    // And the refusal really was about the caller: the row is untouched.
    expect(readOutboxRowState(draft).approval_state).toBe("pending")
  })

  test("a pending stranger draft renders its inbound message, the routing reason and an editable draft", async ({
    request,
    browser,
    baseURL,
  }) => {
    const sender = uniqueEmail("em6-render")
    const subject = "Interested in a small booking page"
    const body = "Hi, a friend passed on your name. What would a small booking page cost?"
    const door = await deliver(request, { from: sender, subject, body, name: "Priya Fixture" })
    expect(door.routed_kind, "a genuine stranger is rung 6's lead case").toBe("lead")

    const page = await operatorPage(browser, baseURL)
    await page.goto("/replies")
    await expect(page.getByTestId("nav-replies")).toHaveAttribute("aria-current", "page")

    const row = replyRowFor(page, sender)
    await expect(row).toHaveCount(1)
    await expect(row).toHaveAttribute("data-routed-kind", "lead")
    await expect(row).toHaveAttribute("data-rung", "6")
    await expect(row.getByTestId("reply-subject")).toHaveText(subject)
    await expect(row.getByTestId("reply-sender-name")).toHaveText("Priya Fixture")
    // The DMARC verdict, exactly as EM-1 parsed it — this fixture carries no
    // Authentication-Results header at all, which is honestly `none`.
    await expect(row.getByTestId("reply-auth-result")).toHaveText("none")
    await expect(
      row.getByTestId("reply-attachments-dropped"),
      "absent at zero attachments, the present-iff convention /deliveries already uses",
    ).toHaveCount(0)

    await row.getByTestId("review-reply").click()
    await expect(page).toHaveURL(new RegExp(`/replies/${door.outbox_id}$`))

    const detail = page.getByTestId("reply-detail")
    await expect(detail).toHaveAttribute("data-routed-kind", "lead")
    // The message as received, verbatim and unredacted.
    await expect(page.getByTestId("reply-original-body")).toHaveText(body)
    await expect(page.getByTestId("reply-sender-email")).toHaveText(sender)
    // Why it landed here — "an operator who cannot see why a match was made
    // cannot sensibly disagree with it".
    await expect(page.getByTestId("reply-route-decision")).toHaveAttribute("data-routed-kind", "lead")
    expect((await page.getByTestId("reply-route-reason").textContent())?.trim().length).toBeGreaterThan(0)
    await expect(
      page.getByTestId("reply-route-runner-up"),
      "no second candidate was ever scored for a stranger",
    ).toHaveCount(0)
    // The LEAD-XXXXXX reference the sender is being told to quote back.
    await expect(page.getByTestId("reply-route-target")).toHaveText(/^LEAD-[A-Z0-9]{6}$/)

    // The draft, editable.
    await expect(page.getByTestId("reply-subject-field")).not.toHaveValue("")
    await expect(page.getByTestId("reply-body-field")).toHaveValue(/LEAD-[A-Z0-9]{6}/)
    await expect(
      page.getByTestId("reply-body-field"),
      "never quotes the sender's own message back at them",
    ).not.toHaveValue(new RegExp(body.slice(0, 20)))

    // The stranger case has no routing panel and no promote button — it
    // already has a lead, and `/leads/:id` is where that gets promoted.
    await expect(page.getByTestId("reply-routing-form")).toHaveCount(0)
    await expect(page.getByTestId("reply-promote-form")).toHaveCount(0)

    await page.getByTestId("back-to-replies").click()
    await expect(page).toHaveURL(/\/replies$/)

    // The other half of the link EM-4 asked for: the lead this stranger's
    // message minted says, in plain text, that it came in by email — see
    // `originatingEmail` in `src/routes/leads.ts` for why it is not a live
    // cross-link back to `/replies/:id`.
    await page.goto("/leads")
    await page.getByTestId("lead-row").filter({ hasText: sender }).getByTestId("review-lead").click()
    await expect(page.getByTestId("originating-email")).toContainText(subject)
    await page.context().close()
  })

  test("editing the body and approving sends the edited text, not the original", async ({
    request,
    browser,
    baseURL,
  }) => {
    const sender = uniqueEmail("em6-edit")
    const door = await deliver(request, { from: sender, subject: "Proof-read me" })
    const draft = door.outbox_id ?? ""

    const page = await operatorPage(browser, baseURL)
    await page.goto(`/replies/${draft}`)

    const bodyField = page.getByTestId("reply-body-field")
    const original = (await bodyField.inputValue()).trim()
    expect(original.length, "there is a drafted body to proof-read").toBeGreaterThan(0)

    const editedSubject = `Edited subject ${tag()}`
    const editedBody = `Proof-read and corrected by hand — ${tag()}.`
    await page.getByTestId("reply-subject-field").fill(editedSubject)
    await bodyField.fill(editedBody)
    await page.getByTestId("reply-approve-button").click()

    // Approved rows leave the queue: it is a pending list, not an archive.
    await expect(page).toHaveURL(/\/replies$/)
    await expect(replyRowFor(page, sender)).toHaveCount(0)

    const state = readOutboxRowState(draft)
    expect(state.approval_state).toBe("approved")
    expect(state.approved_by, "who signed off is recorded, not just that someone did").toBe(DEV_OPERATOR)

    await runDrain(request)

    const sent = await sentTo(request, sender)
    expect(sent, "exactly one send for one approved draft").toHaveLength(1)
    expect(sent[0]?.subject).toBe(editedSubject)
    expect(sent[0]?.text, "the edited text is what goes out").toContain(editedBody)
    expect(sent[0]?.text, "the original draft is not what goes out").not.toContain(original)
    await page.context().close()
  })

  test("approving twice sends once", async ({ request, browser, baseURL }) => {
    const sender = uniqueEmail("em6-double")
    const door = await deliver(request, { from: sender, subject: "Double click me" })
    const draft = door.outbox_id ?? ""

    const context = await contextFor(browser, baseURL, DEV_OPERATOR)
    const form = { subject: "Approved once", body: `Approved once — ${tag()}.` }

    // Two genuinely concurrent approvals of the same row — a double-click, or
    // an operator's second tab. The guard (`WHERE id = ? AND approval_state =
    // 'pending'`) is what makes this converge; the missing button is not.
    const [first, second] = await Promise.all([
      context.request.post(`/replies/${draft}/approve`, { form }),
      context.request.post(`/replies/${draft}/approve`, { form }),
    ])
    expect(first.status()).toBe(200)
    expect(second.status()).toBe(200)

    await runDrain(request)
    await runDrain(request)

    expect(await sentTo(request, sender), "a double-click converges instead of double-sending").toHaveLength(1)
    expect(readOutboxRowState(draft).status).toBe("sent")
    await context.close()
  })

  test("a discarded draft never sends, however many ticks run", async ({ request, browser, baseURL }) => {
    const sender = uniqueEmail("em6-discard")
    const door = await deliver(request, { from: sender, subject: "Not worth answering" })
    const draft = door.outbox_id ?? ""

    const page = await operatorPage(browser, baseURL)
    await page.goto(`/replies/${draft}`)
    await page.getByTestId("reply-discard-button").click()
    await expect(page).toHaveURL(/\/replies$/)
    await expect(replyRowFor(page, sender)).toHaveCount(0)

    for (let tick = 0; tick < 3; tick++) await runDrain(request)

    expect(await sentTo(request, sender), "rejected is terminal — it never sends").toHaveLength(0)

    const state = readOutboxRowState(draft)
    expect(state.approval_state).toBe("rejected")
    // `rejected` is not `failed`: a discarded draft is an operator's decision,
    // not a fault, and it must never be retried into one.
    expect(state.status).toBe("queued")
    expect(state.attempts, "never claimed, never attempted").toBe(0)
    await page.context().close()
  })

  test("an ambiguous row offers both candidates, pre-selects neither, and re-renders the draft against the one an operator picks", async ({
    request,
    browser,
    baseURL,
  }) => {
    const sender = uniqueEmail("em6-route")
    const client = insertClientRow(sender)
    // Two projects whose newest submissions score identically — EM-3's rung 4
    // tie, which "is not a winner" and parks as unrouted.
    const tied = new Date(Date.now() - 30_000).toISOString()
    const alpha = insertProjectRow({ clientId: client, customerEmail: sender, name: "Routed Alpha" })
    insertSubmissionRow({ customerEmail: sender, projectId: alpha, createdAt: tied })
    const beta = insertProjectRow({ clientId: client, customerEmail: sender, name: "Routed Beta" })
    const betaSubmission = insertSubmissionRow({ customerEmail: sender, projectId: beta, createdAt: tied })

    const door = await deliver(request, { from: sender, dmarc: "pass", subject: "Which one is this" })
    expect(door.routed_kind, "a tie parks for a human").toBe("unrouted")
    const draft = door.outbox_id ?? ""

    const page = await operatorPage(browser, baseURL)
    await page.goto(`/replies/${draft}`)

    await expect(page.getByTestId("reply-detail")).toHaveAttribute("data-routed-kind", "unrouted")
    await expect(page.getByTestId("reply-route-target"), "nothing was attached to").toHaveCount(0)
    await expect(page.getByTestId("reply-route-runner-up"), "a tie has a genuine second").toHaveCount(1)
    // Open by default on an unrouted row — resolving it is the first thing an
    // operator is here to do.
    await expect(page.getByTestId("reply-routing-toggle")).toBeChecked()
    await expect(page.getByTestId("reply-routing-form")).toBeVisible()

    const options = page.getByTestId("reply-routing-option")
    await expect(options, "both tied projects, offered as equals").toHaveCount(2)
    // "Guessing never" — nothing is pre-selected, including the lead option.
    await expect(page.locator('input[name="target"]:checked')).toHaveCount(0)
    await expect(page.getByTestId("reply-routing-option-lead")).toHaveCount(1)

    await options.filter({ hasText: "Routed Beta" }).locator('input[type="radio"]').check()
    await page.getByTestId("reply-routing-submit").click()

    // Stays pending — an operator still has to approve what they re-routed.
    await expect(page).toHaveURL(new RegExp(`/replies/${draft}$`))
    await expect(page.getByTestId("reply-detail")).toHaveAttribute("data-routed-kind", "message")
    await expect(page.getByTestId("reply-route-target")).toHaveText("Routed Beta")
    expect(readOutboxRowState(draft).approval_state).toBe("pending")

    // The draft was re-rendered from the template against the new target: its
    // call to action now lands on that project's own submission.
    await page.getByTestId("reply-approve-button").click()
    await runDrain(request)
    const sent = await sentTo(request, sender)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.html ?? "", "the re-rendered CTA points at the project an operator chose").toContain(
      `/submissions/${betaSubmission.id}`,
    )
    await page.context().close()
  })

  test("re-routing an ambiguous row to a lead mints the same inert row /start would have", async ({
    request,
    browser,
    baseURL,
  }) => {
    const sender = uniqueEmail("em6-to-lead")
    const client = insertClientRow(sender)
    const tied = new Date(Date.now() - 30_000).toISOString()
    const one = insertProjectRow({ clientId: client, customerEmail: sender, name: "Lead Route One" })
    insertSubmissionRow({ customerEmail: sender, projectId: one, createdAt: tied })
    const two = insertProjectRow({ clientId: client, customerEmail: sender, name: "Lead Route Two" })
    insertSubmissionRow({ customerEmail: sender, projectId: two, createdAt: tied })

    const door = await deliver(request, { from: sender, dmarc: "pass", subject: "Neither of those" })
    expect(door.routed_kind).toBe("unrouted")
    expect(door.routed_lead_id, "an unrouted row is never given a lead by the router").toBeNull()
    const draft = door.outbox_id ?? ""

    const page = await operatorPage(browser, baseURL)
    await page.goto(`/replies/${draft}`)
    await page.getByTestId("reply-routing-option-lead").locator('input[type="radio"]').check()
    await page.getByTestId("reply-routing-submit").click()

    await expect(page.getByTestId("reply-detail")).toHaveAttribute("data-routed-kind", "lead")
    const reference = (await page.getByTestId("reply-route-target").textContent())?.trim() ?? ""
    expect(reference).toMatch(/^LEAD-[A-Z0-9]{6}$/)
    // Re-rendered from the stranger template: the reference is what the sender
    // is asked to quote back, and rung 2 is what reads it.
    await expect(page.getByTestId("reply-body-field")).toHaveValue(new RegExp(reference))
    // Once it is a lead there is nothing left to re-route, and the promotion
    // path is `/leads/:id`'s own button.
    await expect(page.getByTestId("reply-routing-form")).toHaveCount(0)
    await expect(page.getByTestId("reply-promote-form")).toHaveCount(0)

    // The same inert row `POST /start` writes, on the same triage screen.
    await page.goto("/leads")
    const lead = page.getByTestId("lead-row").filter({ hasText: sender })
    await expect(lead).toHaveCount(1)
    await page.context().close()
  })
})
