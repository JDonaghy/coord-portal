import { expect, test, type APIRequestContext } from "@playwright/test"

/**
 * Black-box coverage for issue #161 ([portal] EM-1: the inbound seam), driving
 * the real Worker under `wrangler dev` with real local D1 — see
 * `playwright.config.ts`. This is the project's own `e2e/` tier, not the sealed
 * acceptance suite under `tests/acceptance/`; per CLAUDE.md this repo still
 * ships its own behavioural coverage for behaviour-changing work.
 *
 * Everything here goes through `POST /__email` (`src/routes/inboundTestDoor.ts`),
 * the dev-only door onto the Worker's `email()` export — an email handler is no
 * more reachable from a browser than `scheduled()` is, which is exactly why the
 * door ships in this issue. `serve:test` already passes `--var
 * MAIL_PROVIDER:fake` (package.json), the same flag `GET /__outbound` gates on,
 * so no new server flag was needed.
 *
 * `serve:test` does NOT wipe `.wrangler/state` between runs, so every fixture
 * below carries a per-run unique `Message-ID` and envelope recipient and every
 * assertion filters the read-back to its own rows — the same trick
 * `e2e/drain.spec.ts` and `e2e/notifications.spec.ts` already use.
 *
 * Every address, name, subject and body is invented on the reserved
 * `example.test` TLD (RFC 6761) — CLAUDE.md rule 1: this repo is public and a
 * real customer's words in a commit cannot be taken back.
 */

function tag(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

interface BlobOptions {
  from?: string
  to?: string
  subject?: string
  messageId: string
  extraHeaders?: Record<string, string>
  body?: string
}

function blob(options: BlobOptions): string {
  const headers = [
    // Issue #169 (EM-9): a real per-sender draft cap now lives behind
    // `POST /__email`, and this suite's own `playwright.config.ts` runs with
    // `fullyParallel: true` — several of this file's own tests can be inside
    // the same 5-second window at once. The default sender is therefore
    // unique to each `blob()` call, not a single shared literal, so this
    // file's own concurrency cannot trip a cap meant for a genuine flood.
    // Tests that assert on the sender address pass `from` explicitly.
    `From: ${options.from ?? `Wren Alcott <wren-${tag()}@sender.example.test>`}`,
    `To: ${options.to ?? "intake@mail.example.test"}`,
    `Subject: ${options.subject ?? "About the booking screen"}`,
    "Date: Tue, 25 Aug 2026 09:14:00 +0000",
    `Message-ID: <${options.messageId}>`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    ...Object.entries(options.extraHeaders ?? {}).map(([k, v]) => `${k}: ${v}`),
  ]
  return `${headers.join("\r\n")}\r\n\r\n${options.body ?? "Could we move the date picker above the fold?"}\r\n`
}

interface DoorResponse {
  id: string
  disposition: string
  message_id: string | null
  from_email: string
  from_name: string | null
  to_email: string
  subject: string
  body_text: string
  received_at: string
  auth_result: string
  suppression_reason: string | null
  attachment_count: number
  body_truncated: boolean
  duplicate?: boolean
}

async function deliver(
  request: APIRequestContext,
  raw: string,
  envelope: { to?: string; from?: string } = {},
): Promise<DoorResponse> {
  const params = new URLSearchParams()
  if (envelope.to !== undefined) params.set("to", envelope.to)
  if (envelope.from !== undefined) params.set("from", envelope.from)
  const query = params.toString() === "" ? "" : `?${params.toString()}`

  const res = await request.post(`/__email${query}`, {
    data: raw,
    headers: { "content-type": "message/rfc822" },
  })
  expect(res.status(), "POST /__email must exist under MAIL_PROVIDER=fake").toBe(200)
  return (await res.json()) as DoorResponse
}

/**
 * `messageId` here is the bare `addr-spec` the fixtures build with; the stored
 * column is the header VERBATIM, angle brackets included, so this wraps before
 * comparing rather than the module unwrapping on the way in.
 */
async function recorded(request: APIRequestContext, messageId: string): Promise<DoorResponse[]> {
  const res = await request.get("/__email")
  expect(res.ok(), "GET /__email must read the recorded rows back").toBe(true)
  const body = (await res.json()) as { emails: DoorResponse[] }
  return body.emails.filter((email) => email.message_id === `<${messageId}>`)
}

test("a plain message lands as exactly one row with the parsed fields", async ({ request }) => {
  const messageId = `plain-${tag()}@sender.example.test`
  const envelopeTo = `intake+e2e-${tag()}@mail.example.test`

  const result = await deliver(
    request,
    blob({
      messageId,
      to: "hello@mail.example.test",
      subject: "About the booking screen",
      // Explicit, not the (now per-call-unique) default — this test asserts
      // on the literal parsed `from_email` below.
      from: "Wren Alcott <wren@sender.example.test>",
    }),
    { to: envelopeTo, from: "wren@sender.example.test" },
  )

  expect(result.id).toMatch(/^inb_/)
  expect(result.disposition).toBe("received")
  expect(result.from_email).toBe("wren@sender.example.test")
  expect(result.from_name).toBe("Wren Alcott")
  expect(result.subject).toBe("About the booking screen")
  expect(result.body_text).toBe("Could we move the date picker above the fold?")
  expect(result.suppression_reason).toBeNull()
  expect(result.body_truncated).toBe(false)
  expect(result.attachment_count).toBe(0)

  // The envelope recipient, NOT the `To:` header — this column carries the
  // plus-address token EM-3's rung 1 resolves a thread from.
  expect(result.to_email).toBe(envelopeTo.toLowerCase())

  const rows = await recorded(request, messageId)
  expect(rows, "exactly one row per accepted message").toHaveLength(1)
  expect(rows[0]?.id).toBe(result.id)
})

test("the DMARC verdict a forwarding hop stamped is recorded in auth_result", async ({
  request,
}) => {
  const messageId = `dmarc-${tag()}@sender.example.test`

  // Two hops, in the order a real relayed message actually carries them: each
  // MTA PREPENDS its own trace headers, so the outermost (most recent) hop is
  // at the top and the deepest one — the forwarder that saw the original
  // sender — is below it. The outermost verdict fails, as plain forwarding
  // routinely does once SPF alignment breaks; the deeper one is the verdict
  // worth trusting. See `parseDmarcVerdict` in `src/inboundEmail.ts`.
  const raw = [
    "Authentication-Results: mx.cloudflare.example; dmarc=fail header.from=sender.example.test",
    "Authentication-Results: mx.forwarder.example.test; dmarc=pass header.from=sender.example.test",
    // Own, unique sender — see `blob()`'s own note on issue #169's per-sender cap.
    `From: Wren Alcott <wren-${tag()}@sender.example.test>`,
    "To: intake@mail.example.test",
    "Subject: About the booking screen",
    `Message-ID: <${messageId}>`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "",
    "Could we move the date picker above the fold?",
    "",
  ].join("\r\n")

  const result = await deliver(request, raw)
  expect(["pass", "fail", "none"]).toContain(result.auth_result)
  expect(result.auth_result).toBe("pass")
})

test("a message with no authentication evidence records auth_result none, not an empty string", async ({
  request,
}) => {
  const result = await deliver(request, blob({ messageId: `noauth-${tag()}@sender.example.test` }))
  expect(result.auth_result).toBe("none")
})

test("an Auto-Submitted message is recorded suppressed, with a reason and no answer earned", async ({
  request,
}) => {
  const messageId = `auto-${tag()}@sender.example.test`
  const result = await deliver(
    request,
    blob({ messageId, extraHeaders: { "Auto-Submitted": "auto-replied" } }),
  )

  expect(result.disposition).toBe("suppressed")
  expect(result.suppression_reason, "the reason must be recorded, not just the refusal").toBeTruthy()

  // Suppressed is RECORDED, not dropped — the evidence survives the refusal.
  const rows = await recorded(request, messageId)
  expect(rows).toHaveLength(1)
  expect(rows[0]?.disposition).toBe("suppressed")
})

test("Precedence: bulk and a mailing-list header are each suppressed on their own", async ({
  request,
}) => {
  const bulk = await deliver(
    request,
    blob({ messageId: `bulk-${tag()}@sender.example.test`, extraHeaders: { Precedence: "bulk" } }),
  )
  expect(bulk.disposition).toBe("suppressed")

  const list = await deliver(
    request,
    blob({
      messageId: `list-${tag()}@sender.example.test`,
      extraHeaders: { "List-Unsubscribe": "<mailto:leave@lists.example.test>" },
    }),
  )
  expect(list.disposition).toBe("suppressed")
})

test("a bounce — an empty envelope sender — is suppressed rather than answered", async ({
  request,
}) => {
  const result = await deliver(request, blob({ messageId: `bounce-${tag()}@sender.example.test` }), {
    from: "",
  })
  expect(result.disposition).toBe("suppressed")
  expect(result.suppression_reason).toBe("bounce")
})

test("a message from the portal's own sending domain is suppressed — the auto-responder loop", async ({
  request,
}) => {
  // `serve:test` sets EMAIL_FROM to `notify@intake.heurontech.com` (package.json).
  const result = await deliver(
    request,
    blob({
      messageId: `self-${tag()}@intake.heurontech.com`,
      from: "postmaster@intake.heurontech.com",
    }),
    { from: "postmaster@intake.heurontech.com" },
  )
  expect(result.disposition).toBe("suppressed")
  expect(result.suppression_reason).toBe("own-sending-domain")
})

test("an ordinary human reply is NOT suppressed — the rules must not swallow real mail", async ({
  request,
}) => {
  const result = await deliver(
    request,
    blob({
      messageId: `human-${tag()}@sender.example.test`,
      extraHeaders: { "Auto-Submitted": "no" },
    }),
  )
  expect(result.disposition).toBe("received")
  expect(result.suppression_reason).toBeNull()
})

test("a redelivery of the same Message-ID produces no second row", async ({ request }) => {
  const messageId = `redeliver-${tag()}@sender.example.test`
  const envelopeTo = `intake+e2e-${tag()}@mail.example.test`
  const raw = blob({ messageId })

  const first = await deliver(request, raw, { to: envelopeTo, from: "wren@sender.example.test" })
  const second = await deliver(request, raw, { to: envelopeTo, from: "wren@sender.example.test" })

  expect(second.id, "a redelivery converges on the row that already exists").toBe(first.id)
  const rows = await recorded(request, messageId)
  expect(rows, "one message, one row, however many times it is delivered").toHaveLength(1)
})

test("an oversized body is stored truncated and flagged, never dropped silently", async ({
  request,
}) => {
  const messageId = `huge-${tag()}@sender.example.test`
  const oversized = "The quick brown fox jumps over the lazy dog. ".repeat(6_000)

  const result = await deliver(request, blob({ messageId, body: oversized }))

  expect(result.body_truncated, "an oversized body must be flagged").toBe(true)
  expect(result.body_text.length).toBeLessThan(oversized.length)
  expect(result.body_text.length, "truncated, not emptied").toBeGreaterThan(0)
  expect(result.body_text).toBe(oversized.slice(0, result.body_text.length))

  // Still recorded, and still processed normally — truncation is not a refusal.
  expect(result.disposition).toBe("received")
  const rows = await recorded(request, messageId)
  expect(rows).toHaveLength(1)
  expect(rows[0]?.body_truncated).toBe(true)
})

test("an attachment is counted and its payload is not stored", async ({ request }) => {
  const messageId = `attach-${tag()}@sender.example.test`
  const raw = [
    // Own, unique sender — see `blob()`'s own note on issue #169's per-sender cap.
    `From: Wren Alcott <wren-${tag()}@sender.example.test>`,
    "To: intake@mail.example.test",
    "Subject: with an attachment",
    `Message-ID: <${messageId}>`,
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="bnd"',
    "",
    "--bnd",
    'Content-Type: text/plain; charset="utf-8"',
    "",
    "See attached.",
    "--bnd",
    'Content-Type: text/plain; name="notes.txt"',
    'Content-Disposition: attachment; filename="notes.txt"',
    "",
    "some synthetic notes",
    "--bnd--",
    "",
  ].join("\r\n")

  const result = await deliver(request, raw)
  expect(result.attachment_count).toBe(1)
  expect(result.body_text).toBe("See attached.")
  expect(result.body_text).not.toContain("some synthetic notes")
})
