import { describe, expect, it } from "vitest"
import {
  MAX_BODY_TEXT_CHARS,
  listInboundEmails,
  parseDmarcVerdict,
  recordInboundEmail,
  type InboundEmailRecord,
} from "../src/inboundEmail"
import { inboundTestDoor } from "../src/routes/inboundTestDoor"
import type { Env } from "../src/types"

/**
 * Unit coverage for issue #161's inbound seam — the parse, the "never answer a
 * machine" suppression rules, the DMARC verdict, the size cap and the
 * redelivery guard — against a minimal in-memory fake of exactly the D1
 * statements `src/inboundEmail.ts` issues.
 *
 * The behavioural bar for this issue is `e2e/inbound-email.spec.ts`, which
 * drives the real Worker under `wrangler dev` with real local D1 through
 * `POST /__email`. This file exists so each suppression rule and each parse
 * edge can be asserted in milliseconds and in isolation, the same posture
 * `test/drain.test.ts` takes next to `e2e/drain.spec.ts`.
 *
 * Every address, name, subject and body below is invented on the reserved
 * `example.test` TLD (RFC 6761) — CLAUDE.md rule 1: no customer material in
 * git, ever, in this public repo.
 */

interface StoredRow {
  id: string
  message_id: string | null
  from_email: string
  from_name: string | null
  to_email: string
  subject: string
  body_text: string
  received_at: string
  auth_result: string
  disposition: string
  suppression_reason: string | null
  attachment_count: number
  body_truncated: number
  routed_kind: string | null
  routed_rung: number | null
  routed_reason: string | null
  routed_runner_up: string | null
}

/**
 * The router's own read-only lookups (issue #163), which `recordInboundEmail`
 * now runs for every non-suppressed message before it inserts.
 *
 * They are answered here as "nothing found" — an empty portal — rather than
 * being modelled, because this file's subject is the *seam*: the parse, the
 * suppression rules, the DMARC verdict, the cap and the redelivery guard. The
 * ladder itself has exhaustive, database-free coverage in
 * `test/inboundRouter.test.ts` (which drives `decideRoute` over hand-built
 * `RoutingLookup` fixtures), and the wired-up end-to-end behaviour is
 * `e2e/inbound-router.spec.ts` against real D1. Modelling `clients` /
 * `projects` / `submissions` a third time here would duplicate both without
 * asserting anything neither already covers.
 *
 * Matching is still by explicit table, not a blanket allow: a statement against
 * a table this seam has no business touching still throws.
 */
const ROUTER_READ_TABLES = ["FROM clients", "FROM submissions", "FROM projects"]

function isRouterRead(statement: string): boolean {
  return ROUTER_READ_TABLES.some((table) => statement.includes(table))
}

/**
 * A fake `Env["DB"]` that understands the statements this module issues and
 * nothing else — an unrecognised statement throws loudly rather than silently
 * returning nothing, so a query this file has not kept in step with fails the
 * test that exercises it instead of passing for the wrong reason
 * (`test/drain.test.ts`'s own convention).
 *
 * It enforces the partial unique index from
 * `migrations/0020_inbound_emails.sql` — `(message_id, to_email)` where
 * `message_id IS NOT NULL` — because the redelivery guard is the whole point of
 * that index and a fake that ignored it would make the duplicate test vacuous.
 */
function fakeInboundEnv(vars: Partial<Env> = {}): Env {
  const store: StoredRow[] = []
  const norm = (sql: string) => sql.replace(/\s+/g, " ").trim()

  const DB = {
    prepare(sql: string) {
      const statement = norm(sql)
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              if (!statement.startsWith("INSERT INTO inbound_emails")) {
                throw new Error(`unrecognized run statement: ${statement}`)
              }
              const row = rowFromBindings(args)
              const collides =
                row.message_id !== null &&
                store.some((s) => s.message_id === row.message_id && s.to_email === row.to_email)
              if (collides) return { meta: { changes: 0 } }
              store.push(row)
              return { meta: { changes: 1 } }
            },
            async first<T>(): Promise<T | null> {
              if (isRouterRead(statement)) return null
              if (!statement.includes("WHERE message_id = ?")) {
                throw new Error(`unrecognized first statement: ${statement}`)
              }
              const [messageId, toEmail] = args as [string, string]
              return ((store.find((s) => s.message_id === messageId && s.to_email === toEmail) ??
                null) as T | null)
            },
            async all<T>(): Promise<{ results: T[] }> {
              if (isRouterRead(statement)) return { results: [] }
              if (!statement.includes("ORDER BY received_at DESC")) {
                throw new Error(`unrecognized all statement: ${statement}`)
              }
              const [limit] = args as [number]
              const results = [...store]
                .sort((a, b) =>
                  a.received_at === b.received_at
                    ? b.id.localeCompare(a.id)
                    : b.received_at.localeCompare(a.received_at),
                )
                .slice(0, limit)
              return { results: results as unknown as T[] }
            },
          }
        },
      }
    },
  }

  return { DB, ...vars, rows: store } as unknown as Env & { rows: StoredRow[] }
}

function rowFromBindings(args: unknown[]): StoredRow {
  const [
    id,
    message_id,
    from_email,
    from_name,
    to_email,
    subject,
    body_text,
    received_at,
    auth_result,
    disposition,
    suppression_reason,
    attachment_count,
    body_truncated,
    routed_kind,
    routed_rung,
    routed_reason,
    routed_runner_up,
  ] = args as [
    string,
    string | null,
    string,
    string | null,
    string,
    string,
    string,
    string,
    string,
    string,
    string | null,
    number,
    number,
    string | null,
    number | null,
    string | null,
    string | null,
  ]
  return {
    id,
    message_id,
    from_email,
    from_name,
    to_email,
    subject,
    body_text,
    received_at,
    auth_result,
    disposition,
    suppression_reason,
    attachment_count,
    body_truncated,
    routed_kind,
    routed_rung,
    routed_reason,
    routed_runner_up,
  }
}

function storedRows(env: Env): StoredRow[] {
  return (env as unknown as { rows: StoredRow[] }).rows
}

interface BlobOptions {
  from?: string
  to?: string
  subject?: string
  messageId?: string | null
  extraHeaders?: Record<string, string>
  body?: string
}

/** A minimal, well-formed RFC 822 blob. Synthetic in every field. */
function blob(options: BlobOptions = {}): string {
  const headers: string[] = [
    `From: ${options.from ?? "Wren Alcott <wren@sender.example.test>"}`,
    `To: ${options.to ?? "intake@mail.example.test"}`,
    `Subject: ${options.subject ?? "About the booking screen"}`,
    "Date: Tue, 25 Aug 2026 09:14:00 +0000",
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
  ]
  if (options.messageId !== null) {
    headers.push(`Message-ID: <${options.messageId ?? "aaa11122@sender.example.test"}>`)
  }
  for (const [key, value] of Object.entries(options.extraHeaders ?? {})) {
    headers.push(`${key}: ${value}`)
  }
  return `${headers.join("\r\n")}\r\n\r\n${options.body ?? "Could we move the date picker above the fold?"}\r\n`
}

async function record(env: Env, options: BlobOptions & { envelopeFrom?: string; envelopeTo?: string } = {}) {
  return recordInboundEmail(env, {
    from: options.envelopeFrom ?? "wren@sender.example.test",
    to: options.envelopeTo ?? "intake@mail.example.test",
    raw: blob(options),
  })
}

describe("recordInboundEmail — the ordinary case", () => {
  it("records exactly one row with the parsed fields", async () => {
    const env = fakeInboundEnv()
    const { record: row, duplicate } = await record(env)

    expect(duplicate).toBe(false)
    expect(storedRows(env)).toHaveLength(1)
    expect(row.id).toMatch(/^inb_[0-9a-f]{24}$/)
    expect(row.fromEmail).toBe("wren@sender.example.test")
    expect(row.fromName).toBe("Wren Alcott")
    expect(row.subject).toBe("About the booking screen")
    expect(row.bodyText).toBe("Could we move the date picker above the fold?")
    // Verbatim, angle brackets and all — `<…>` is part of RFC 5322's `msg-id`.
    expect(row.messageId).toBe("<aaa11122@sender.example.test>")
    expect(row.disposition).toBe("received")
    expect(row.suppressionReason).toBeNull()
    expect(row.attachmentCount).toBe(0)
    expect(row.bodyTruncated).toBe(false)
    expect(Date.parse(row.receivedAt)).not.toBeNaN()
  })

  it("stores the ENVELOPE recipient, not the `To:` header — EM-3 rung 1 reads this column", async () => {
    const env = fakeInboundEnv()
    const { record: row } = await record(env, {
      to: "hello@mail.example.test",
      envelopeTo: "intake+SUB-A1B2C3@mail.example.test",
    })
    expect(row.toEmail).toBe("intake+sub-a1b2c3@mail.example.test")
  })

  it("falls back to the envelope sender when the blob has no parseable `From:`", async () => {
    const env = fakeInboundEnv()
    const { record: row } = await recordInboundEmail(env, {
      from: "Fallback@Sender.Example.Test",
      to: "intake@mail.example.test",
      raw: "Subject: no from header\r\n\r\nbody",
    })
    expect(row.fromEmail).toBe("fallback@sender.example.test")
    expect(row.fromName).toBeNull()
  })

  it("reads a body out of an HTML-only message rather than recording it as empty", async () => {
    const env = fakeInboundEnv()
    const { record: row } = await recordInboundEmail(env, {
      from: "wren@sender.example.test",
      to: "intake@mail.example.test",
      raw: [
        "From: wren@sender.example.test",
        "Subject: html only",
        'Content-Type: text/html; charset="utf-8"',
        "",
        "<p>Move the <b>date picker</b> up</p><p>Thanks &amp; regards</p>",
      ].join("\r\n"),
    })
    expect(row.bodyText).toContain("Move the date picker up")
    expect(row.bodyText).toContain("Thanks & regards")
    expect(row.bodyText).not.toContain("<p>")
  })

  it("counts attachments without storing them", async () => {
    const env = fakeInboundEnv()
    const raw = [
      "From: wren@sender.example.test",
      "Subject: with an attachment",
      "Message-ID: <att001@sender.example.test>",
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
      "some notes",
      "--bnd--",
      "",
    ].join("\r\n")
    const { record: row } = await recordInboundEmail(env, {
      from: "wren@sender.example.test",
      to: "intake@mail.example.test",
      raw,
    })
    expect(row.attachmentCount).toBe(1)
    expect(row.bodyText).toBe("See attached.")
  })
})

describe("never answer a machine — #161 scope item 4", () => {
  const cases: Array<[string, BlobOptions & { envelopeFrom?: string }, string]> = [
    [
      "Auto-Submitted: auto-replied",
      { extraHeaders: { "Auto-Submitted": "auto-replied" } },
      "auto-submitted",
    ],
    [
      "Auto-Submitted: auto-generated",
      { extraHeaders: { "Auto-Submitted": "auto-generated (out of office)" } },
      "auto-submitted",
    ],
    ["Precedence: bulk", { extraHeaders: { Precedence: "bulk" } }, "bulk-precedence"],
    ["Precedence: list", { extraHeaders: { Precedence: "list" } }, "bulk-precedence"],
    ["Precedence: junk", { extraHeaders: { Precedence: "junk" } }, "bulk-precedence"],
    [
      "List-Id",
      { extraHeaders: { "List-Id": "Announcements <ann.lists.example.test>" } },
      "mailing-list",
    ],
    [
      "List-Unsubscribe",
      { extraHeaders: { "List-Unsubscribe": "<mailto:leave@lists.example.test>" } },
      "mailing-list",
    ],
    ["an empty envelope sender (a bounce)", { envelopeFrom: "" }, "bounce"],
    ["an SMTP `<>` envelope sender", { envelopeFrom: "<>" }, "bounce"],
  ]

  for (const [label, options, reason] of cases) {
    it(`suppresses ${label}, recording the row and the reason`, async () => {
      const env = fakeInboundEnv()
      const { record: row } = await record(env, options)
      expect(row.disposition).toBe("suppressed")
      expect(row.suppressionReason).toBe(reason)
      // Recorded, never dropped: the evidence survives the refusal.
      expect(storedRows(env)).toHaveLength(1)
    })
  }

  it("does NOT suppress `Auto-Submitted: no` — that header value means a human sent it", async () => {
    const env = fakeInboundEnv()
    const { record: row } = await record(env, { extraHeaders: { "Auto-Submitted": "no" } })
    expect(row.disposition).toBe("received")
    expect(row.suppressionReason).toBeNull()
  })

  it("suppresses a message from our own EMAIL_FROM domain — the auto-responder loop", async () => {
    const env = fakeInboundEnv({ EMAIL_FROM: "Heuron <notify@mail.example.test>" })
    const { record: row } = await record(env, {
      from: "bounces@mail.example.test",
      envelopeFrom: "bounces@mail.example.test",
    })
    expect(row.disposition).toBe("suppressed")
    expect(row.suppressionReason).toBe("own-sending-domain")
  })

  it("suppresses a message from our own REPLY_TO domain too", async () => {
    const env = fakeInboundEnv({ REPLY_TO: "ops@replies.example.test" })
    const { record: row } = await record(env, {
      from: "ops@replies.example.test",
      envelopeFrom: "ops@replies.example.test",
    })
    expect(row.suppressionReason).toBe("own-sending-domain")
  })

  it("leaves a stranger alone when neither sending var is configured", async () => {
    const env = fakeInboundEnv()
    const { record: row } = await record(env)
    expect(row.disposition).toBe("received")
  })
})

describe("parseDmarcVerdict — authentication evidence", () => {
  it("returns `none` when no hop stamped an Authentication-Results header", () => {
    expect(parseDmarcVerdict([])).toBe("none")
  })

  it("returns `none` when a header carries no DMARC token at all", () => {
    expect(parseDmarcVerdict(["mx.example.test; spf=pass smtp.mailfrom=a@b.example.test"])).toBe(
      "none",
    )
  })

  it("reads pass and fail", () => {
    expect(parseDmarcVerdict(["mx.example.test; dmarc=pass header.from=sender.example.test"])).toBe(
      "pass",
    )
    expect(parseDmarcVerdict(["mx.example.test; dmarc=fail header.from=sender.example.test"])).toBe(
      "fail",
    )
  })

  it("maps temperror/permerror to `none` rather than inventing a fourth value", () => {
    expect(parseDmarcVerdict(["mx.example.test; dmarc=temperror"])).toBe("none")
    expect(parseDmarcVerdict(["mx.example.test; dmarc=permerror"])).toBe("none")
  })

  /**
   * The topology note from #161 and `migrations/0020_inbound_emails.sql`: mail
   * arrives via a Zoho forward, so the trustworthy verdict is the one the
   * FORWARDER stamped for the original sender (deepest in the header stack),
   * not the one Cloudflare stamped for the forwarder — plain forwarding breaks
   * SPF alignment, so the outermost hop routinely reads `fail` for a message
   * that was authentic when it left the sender.
   */
  it("prefers the deepest hop's verdict over the outermost relay's", () => {
    expect(
      parseDmarcVerdict([
        "mx.cloudflare.example; dmarc=fail header.from=sender.example.test",
        "mx.forwarder.example; dmarc=pass header.from=sender.example.test",
      ]),
    ).toBe("pass")
  })

  it("is read off a real message's headers", async () => {
    const env = fakeInboundEnv()
    const { record: row } = await record(env, {
      extraHeaders: {
        "Authentication-Results": "mx.forwarder.example.test; dmarc=pass header.from=sender.example.test",
      },
    })
    expect(row.authResult).toBe("pass")
  })

  it("records `none` for a message with no authentication evidence", async () => {
    const env = fakeInboundEnv()
    const { record: row } = await record(env)
    expect(row.authResult).toBe("none")
  })
})

describe("size caps", () => {
  it("stores an oversized body truncated and flagged, never dropped", async () => {
    const env = fakeInboundEnv()
    const oversized = "x".repeat(MAX_BODY_TEXT_CHARS + 5_000)
    const { record: row } = await record(env, { body: oversized })

    expect(row.bodyTruncated).toBe(true)
    expect(row.bodyText.length).toBe(MAX_BODY_TEXT_CHARS)
    // Still a real, processed row — truncation is not a rejection.
    expect(row.disposition).toBe("received")
    expect(storedRows(env)).toHaveLength(1)
  })

  it("leaves an ordinary body untouched and unflagged", async () => {
    const env = fakeInboundEnv()
    const { record: row } = await record(env, { body: "short and sweet" })
    expect(row.bodyTruncated).toBe(false)
    expect(row.bodyText).toBe("short and sweet")
  })
})

describe("redelivery", () => {
  it("records one row for the same Message-ID delivered twice, and returns the same id", async () => {
    const env = fakeInboundEnv()
    const first = await record(env, { messageId: "dup001@sender.example.test" })
    const second = await record(env, { messageId: "dup001@sender.example.test" })

    expect(first.duplicate).toBe(false)
    expect(second.duplicate).toBe(true)
    expect(second.record.id).toBe(first.record.id)
    expect(storedRows(env)).toHaveLength(1)
  })

  it("treats the same Message-ID delivered to a different envelope recipient as a separate message", async () => {
    const env = fakeInboundEnv()
    await record(env, { messageId: "dup002@sender.example.test" })
    const second = await record(env, {
      messageId: "dup002@sender.example.test",
      envelopeTo: "intake+SUB-ZZ9900@mail.example.test",
    })
    expect(second.duplicate).toBe(false)
    expect(storedRows(env)).toHaveLength(2)
  })

  it("records two rows for two messages with no Message-ID at all — there is no identity to dedupe on", async () => {
    const env = fakeInboundEnv()
    await record(env, { messageId: null })
    await record(env, { messageId: null })
    expect(storedRows(env)).toHaveLength(2)
  })
})

describe("listInboundEmails", () => {
  it("returns rows newest first", async () => {
    const env = fakeInboundEnv()
    await record(env, { messageId: "one@sender.example.test", subject: "first" })
    await new Promise((resolve) => setTimeout(resolve, 2))
    await record(env, { messageId: "two@sender.example.test", subject: "second" })

    const rows: InboundEmailRecord[] = await listInboundEmails(env)
    expect(rows).toHaveLength(2)
    expect(rows[0]?.subject).toBe("second")
  })
})

describe("POST /__email — the test door", () => {
  function post(body: string, query = ""): Request {
    return new Request(`https://portal.test/__email${query}`, {
      method: "POST",
      body,
      headers: { "content-type": "message/rfc822" },
    })
  }

  it("404s when the fake provider is not selected — it must be unreachable in production", async () => {
    const env = fakeInboundEnv()
    const res = await inboundTestDoor(post(blob()), env)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "not_found" })
    expect(storedRows(env)).toHaveLength(0)
  })

  it("404s a GET read-back for the same reason", async () => {
    const env = fakeInboundEnv()
    const res = await inboundTestDoor(new Request("https://portal.test/__email"), env)
    expect(res.status).toBe(404)
  })

  it("runs a raw RFC 822 blob through the same handler and answers with the id and disposition", async () => {
    const env = fakeInboundEnv({ MAIL_PROVIDER: "fake" })
    const res = await inboundTestDoor(post(blob()), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body["id"]).toMatch(/^inb_/)
    expect(body["disposition"]).toBe("received")
    expect(body["subject"]).toBe("About the booking screen")
    expect(storedRows(env)).toHaveLength(1)
  })

  it("takes the envelope recipient from `?to=`, out of band from the blob's own `To:`", async () => {
    const env = fakeInboundEnv({ MAIL_PROVIDER: "fake" })
    const res = await inboundTestDoor(
      post(blob({ to: "hello@mail.example.test" }), "?to=intake%2BSUB-QQ1122@mail.example.test"),
      env,
    )
    const body = (await res.json()) as Record<string, unknown>
    expect(body["to_email"]).toBe("intake+sub-qq1122@mail.example.test")
  })

  it("accepts an `X-Envelope-To` header as an equivalent to `?to=`", async () => {
    const env = fakeInboundEnv({ MAIL_PROVIDER: "fake" })
    const request = new Request("https://portal.test/__email", {
      method: "POST",
      body: blob({ to: "hello@mail.example.test" }),
      headers: { "x-envelope-to": "intake+SUB-HH3344@mail.example.test" },
    })
    const body = (await (await inboundTestDoor(request, env)).json()) as Record<string, unknown>
    expect(body["to_email"]).toBe("intake+sub-hh3344@mail.example.test")
  })

  it("treats an explicitly empty `?from=` as a bounce, distinct from omitting it", async () => {
    const env = fakeInboundEnv({ MAIL_PROVIDER: "fake" })
    const bounced = (await (await inboundTestDoor(post(blob(), "?from="), env)).json()) as Record<
      string,
      unknown
    >
    expect(bounced["disposition"]).toBe("suppressed")
    expect(bounced["suppression_reason"]).toBe("bounce")

    const ordinary = (await (
      await inboundTestDoor(post(blob({ messageId: "ord001@sender.example.test" })), env)
    ).json()) as Record<string, unknown>
    expect(ordinary["disposition"]).toBe("received")
  })

  it("falls back to the blob's own headers when no envelope is supplied", async () => {
    const env = fakeInboundEnv({ MAIL_PROVIDER: "fake" })
    const body = (await (await inboundTestDoor(post(blob()), env)).json()) as Record<string, unknown>
    expect(body["to_email"]).toBe("intake@mail.example.test")
    expect(body["from_email"]).toBe("wren@sender.example.test")
  })

  it("reports a redelivery as a duplicate of the same row", async () => {
    const env = fakeInboundEnv({ MAIL_PROVIDER: "fake" })
    const raw = blob({ messageId: "door-dup@sender.example.test" })
    const first = (await (await inboundTestDoor(post(raw), env)).json()) as Record<string, unknown>
    const second = (await (await inboundTestDoor(post(raw), env)).json()) as Record<string, unknown>
    expect(second["id"]).toBe(first["id"])
    expect(second["duplicate"]).toBe(true)
    expect(storedRows(env)).toHaveLength(1)
  })

  it("refuses an empty body rather than recording a blank row", async () => {
    const env = fakeInboundEnv({ MAIL_PROVIDER: "fake" })
    const res = await inboundTestDoor(post("   "), env)
    expect(res.status).toBe(400)
    expect(storedRows(env)).toHaveLength(0)
  })

  it("reads recorded rows back over GET, for a test with nothing else to look at", async () => {
    const env = fakeInboundEnv({ MAIL_PROVIDER: "fake" })
    await inboundTestDoor(post(blob({ messageId: "readback@sender.example.test" })), env)
    const res = await inboundTestDoor(new Request("https://portal.test/__email"), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { emails: Array<Record<string, unknown>> }
    expect(body.emails).toHaveLength(1)
    expect(body.emails[0]?.["message_id"]).toBe("<readback@sender.example.test>")
  })

  it("405s a method it does not implement, naming what it allows", async () => {
    const env = fakeInboundEnv({ MAIL_PROVIDER: "fake" })
    const res = await inboundTestDoor(
      new Request("https://portal.test/__email", { method: "DELETE" }),
      env,
    )
    expect(res.status).toBe(405)
    expect(res.headers.get("allow")).toBe("GET, POST")
  })
})
