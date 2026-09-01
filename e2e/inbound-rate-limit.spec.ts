import { expect, test, type APIRequestContext, type Browser } from "@playwright/test"

/**
 * Black-box coverage for issue #169 ([portal] EM-9: rate-limit inbound
 * drafts, and say out loud that attachments are dropped), driving the real
 * Worker under `wrangler dev` with real local D1 — see `playwright.config.ts`.
 * This is the project's own `e2e/` tier, not the sealed acceptance suite
 * under `tests/acceptance/`; per CLAUDE.md this repo still ships its own
 * behavioural coverage for behaviour-changing work, and the sealed suite's
 * independence is exactly why it does not substitute for this file.
 *
 * ── WHAT IS COVERED HERE, AND WHY ────────────────────────────────────────────
 *
 * 1. The **per-sender** cap: a burst from one, never-before-seen sender —
 *    the first `PER_SENDER_MAX_DRAFTS` messages draft, every one after that
 *    in the same window is `rate_limited` and drafts nothing, and every one
 *    of them is still recorded (never silently dropped). Robust under this
 *    config's `fullyParallel: true`, because the bucket this cap counts is
 *    scoped to `from_email` — a unique, per-test address never collides with
 *    whatever other spec files are doing to the shared local D1 at the same
 *    moment.
 * 2. The **attachment disclosure**: a message with a real MIME attachment
 *    part gets its payload dropped, its count recorded, and its drafted
 *    reply's own body (read back through the real `/replies/:id` screen,
 *    the same way `e2e/replies.spec.ts` reads a draft) says so without
 *    claiming the file was kept.
 *
 * ── WHAT IS DELIBERATELY NOT COVERED HERE ────────────────────────────────────
 *
 * The **total** cap (more than `TOTAL_MAX_DRAFTS` drafts across every sender
 * in the same window) is not given its own test in this file. Unlike the
 * per-sender cap, that bucket has no per-test scoping — it counts every
 * draft attempt from every spec file `wrangler dev` is serving at once, and
 * this config runs with `fullyParallel: true` (`playwright.config.ts`,
 * unlike the sealed suite's own `workers: 1, fullyParallel: false`). A test
 * asserting an exact threshold against a globally shared, concurrently
 * written counter would be inherently racy here. The total cap's own
 * behaviour is exhaustively covered by
 * `tests/acceptance/ms-5/169-em9-rate-limit-and-attachments.spec.ts`, which
 * runs single-worker for exactly this reason, and by
 * `test/inboundEmail.test.ts`'s own wiring tests against a fake D1.
 *
 * `serve:test` does NOT wipe `.wrangler/state` between runs, so every
 * fixture below carries a per-run unique sender address and Message-ID and
 * every assertion filters its own read-back to those — the same trick
 * `e2e/inbound-email.spec.ts` and `e2e/replies.spec.ts` already use.
 *
 * Every address, name, subject and body is invented on the reserved
 * `example.test` TLD (RFC 6761) — CLAUDE.md rule 1: this repo is public and a
 * real customer's words in a commit cannot be taken back.
 */

// Mirrors `PER_SENDER_MAX_DRAFTS` in `src/rateLimit.ts` — this contract's own
// invented number, not imported (e2e treats the running Worker as a black
// box, same posture every other file in this directory takes).
const PER_SENDER_MAX_DRAFTS = 5

const ACCESS_HEADER = "Cf-Access-Authenticated-User-Email"
const DEV_OPERATOR = "ops@example.test"

function tag(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

interface BlobOptions {
  from: string
  subject?: string
  messageId: string
  body?: string
  attachment?: boolean
}

/** One synthetic RFC 822 message — plain, or multipart/mixed with one attachment part. */
function blob(options: BlobOptions): string {
  const body = options.body ?? "Just checking in on this."
  if (!options.attachment) {
    return [
      `From: ${options.from}`,
      `To: intake@mail.example.test`,
      `Subject: ${options.subject ?? "Following up"}`,
      "Date: Tue, 25 Aug 2026 09:14:00 +0000",
      `Message-ID: <${options.messageId}>`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="utf-8"',
      "",
      body,
      "",
    ].join("\r\n")
  }

  const boundary = `e2e169-${tag()}`
  return [
    `From: ${options.from}`,
    `To: intake@mail.example.test`,
    `Subject: ${options.subject ?? "One more thing while I have you"}`,
    "Date: Tue, 25 Aug 2026 09:14:00 +0000",
    `Message-ID: <${options.messageId}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    "",
    body,
    `--${boundary}`,
    'Content-Type: image/png; name="layout-issue.png"',
    'Content-Disposition: attachment; filename="layout-issue.png"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("synthetic screenshot bytes, invented for e2e #169 — never a real customer file").toString(
      "base64",
    ),
    `--${boundary}--`,
    "",
  ].join("\r\n")
}

interface DoorResponse {
  id: string
  disposition: string
  outbox_id: string | null
  attachment_count: number
}

async function deliver(request: APIRequestContext, options: BlobOptions): Promise<DoorResponse> {
  const res = await request.post(`/__email?to=${encodeURIComponent("intake@mail.example.test")}&from=${encodeURIComponent(options.from)}`, {
    data: blob(options),
    headers: { "content-type": "message/rfc822" },
  })
  expect(res.status(), "POST /__email must exist under MAIL_PROVIDER=fake").toBe(200)
  return (await res.json()) as DoorResponse
}

async function operatorContext(browser: Browser, baseURL: string | undefined) {
  return browser.newContext({ baseURL, extraHTTPHeaders: { [ACCESS_HEADER]: DEV_OPERATOR } })
}

test.describe("issue #169 — EM-9: rate-limit inbound drafts, disclose dropped attachments", () => {
  test("a burst from one sender drafts up to the per-sender cap, records every overflow as rate_limited, and drafts nothing for it", async ({
    request,
  }) => {
    const from = `em9-burst-${tag()}@sender.example.test`
    const burstSize = PER_SENDER_MAX_DRAFTS + 2

    const results: DoorResponse[] = []
    for (let i = 0; i < burstSize; i++) {
      // eslint-disable-next-line no-await-in-loop -- ordering across the burst is the whole point
      const result = await deliver(request, { from, messageId: `${tag()}-${i}@sender.example.test` })
      results.push(result)
    }

    for (let i = 0; i < PER_SENDER_MAX_DRAFTS; i++) {
      expect(results[i]?.disposition, `message #${i + 1} is within the per-sender cap`).toBe("received")
      expect(results[i]?.outbox_id, `message #${i + 1} earns a draft`).not.toBeNull()
    }
    for (let i = PER_SENDER_MAX_DRAFTS; i < burstSize; i++) {
      expect(results[i]?.disposition, `message #${i + 1} exceeds the per-sender cap`).toBe("rate_limited")
      expect(results[i]?.outbox_id, "a rate-limited message earns no draft").toBeNull()
    }

    // Still recorded — "should not erase the evidence of itself" (#169's own words).
    const readBack = await request.get("/__email")
    expect(readBack.ok()).toBe(true)
    const body = (await readBack.json()) as { emails: Array<{ id: string; from_email: string }> }
    const own = body.emails.filter((email) => email.from_email === from)
    expect(own, "every message in the burst was recorded, overflow included").toHaveLength(burstSize)
  })

  test("an attachment is dropped, counted, and disclosed in the drafted reply's own body", async ({
    request,
    browser,
    baseURL,
  }) => {
    const from = `em9-attach-${tag()}@sender.example.test`
    const messageId = `${tag()}@sender.example.test`

    const result = await deliver(request, {
      from,
      messageId,
      attachment: true,
      body: "I attached a screenshot of the issue — let me know if you need anything else.",
    })

    expect(result.disposition, "an attachment alone must not change disposition").toBe("received")
    expect(result.attachment_count, "postal-mime's own count of MIME attachment parts").toBe(1)
    expect(result.outbox_id, "an attachment does not prevent a draft from being created").not.toBeNull()

    const operatorCtx = await operatorContext(browser, baseURL)
    const page = await operatorCtx.newPage()
    await page.goto(`/replies/${result.outbox_id}`)

    // The operator-facing count, present-iff-nonzero — EM-6's own hook,
    // already landed ahead of this issue.
    const badge = page.getByTestId("reply-attachments-dropped")
    await expect(badge).toHaveCount(1)
    await expect(badge).toContainText("1")

    // The drafted reply's own copy: mentions the attachment, but never claims
    // it was kept, saved, or is retrievable — and never quotes the sender's
    // own words back to them (#164's rule, unaffected by this being an
    // attachment-bearing message).
    const bodyField = page.getByTestId("reply-body-field")
    await expect(bodyField).toHaveValue(/attach/i)
    const draftBody = await bodyField.inputValue()
    expect(draftBody).not.toMatch(/\b(saved|kept|available|download|retrievable)\b/i)
    expect(draftBody).not.toContain("I attached a screenshot of the issue")

    await operatorCtx.close()
  })

  test("a message with no attachment shows no dropped-attachment badge and no disclosure in the draft", async ({
    request,
    browser,
    baseURL,
  }) => {
    const from = `em9-bare-${tag()}@sender.example.test`
    const result = await deliver(request, { from, messageId: `${tag()}@sender.example.test` })
    expect(result.attachment_count).toBe(0)
    expect(result.outbox_id).not.toBeNull()

    const operatorCtx = await operatorContext(browser, baseURL)
    const page = await operatorCtx.newPage()
    await page.goto(`/replies/${result.outbox_id}`)

    await expect(page.getByTestId("reply-attachments-dropped")).toHaveCount(0)
    await expect(page.getByTestId("reply-body-field")).not.toHaveValue(/attach/i)

    await operatorCtx.close()
  })
})
