import { describe, expect, it } from "vitest"
import {
  MAX_BODY_TEXT_CHARS,
  listInboundEmails,
  parseDmarcVerdict,
  recordInboundEmail,
  type InboundEmailRecord,
} from "../src/inboundEmail"
import { inboundTestDoor } from "../src/routes/inboundTestDoor"
import { PER_SENDER_MAX_DRAFTS } from "../src/rateLimit"
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
  routed_lead_id: string | null
  routed_project_id: string | null
  routed_submission_id: string | null
  outbox_id: string | null
}

/** A `leads` row, as `leadCreationStatement` (`src/leads.ts`) inserts one — issue #164, EM-4. */
interface StoredLead {
  id: string
  reference: string
  summary: string
  email: string
  name: string | null
  created_at: string
}

/**
 * An `outbox` row, as `intakeReplyStatement` (`src/notifications.ts`) inserts
 * one — issue #164, EM-4. Only the columns that statement actually binds; every
 * other `outbox` column (`status`, `attempts`, …) is a real D1 default this
 * fake has no reason to model, the same restraint `test/notifications.test.ts`'s
 * own `fakeDb` already takes.
 */
interface StoredOutbox {
  id: string
  submission_id: string
  coord_revision: number
  email_type: string
  to_email: string
  from_email: string
  subject: string
  preheader: string
  body: string
  cta_text: string
  cta_href: string
  queued_at: string
  approval_state: string
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
 * It models the redelivery guard the real statement carries — `WHERE NOT
 * EXISTS (… WHERE message_id = ?)`, one row per `Message-ID` (see
 * `src/inboundEmail.ts`'s own "one row per Message-ID" note for why that is
 * wider than `migrations/0020_inbound_emails.sql`'s composite index) — because
 * that guard is the whole point of the duplicate tests and a fake that ignored
 * it would make them vacuous.
 *
 * ── `batch()` IS THE WRITE PATH ────────────────────────────────────────────
 * EM-4 writes its three rows in one `DB.batch()` (issue #164), so this fake
 * implements `batch` as "run each statement in order, collect each result" —
 * which is D1's own semantics minus the rollback, and enough to assert what
 * these tests assert: that the `leads`/`outbox` statements' `WHERE EXISTS
 * (SELECT 1 FROM inbound_emails WHERE id = ?)` guard sees the `inbound_emails`
 * insert that ran ahead of them in the same batch, and writes nothing when
 * that insert was a redelivery that did nothing.
 *
 * ── EM-4 (ISSUE #164): `leads` AND `outbox` JOIN THE FAKE ──────────────────
 * Rung 6 ("nobody we know") is reachable from this file's own default fixture
 * (an authenticated stranger with no plus address, no quoted reference, and
 * the router's own reads answered as "nothing found" — see
 * `isRouterRead` above) — so `leadCreationStatement` and `intakeReplyStatement`
 * are live code paths here, not merely imported. `leads`/`outbox` get the same
 * unique-constraint enforcement `inbound_emails` already gets above:
 * `outbox`'s `(submission_id, coord_revision)` — see
 * `INTAKE_REPLY_REVISION` in `src/notifications.ts` for why that pair, not a
 * dedicated column, is this fake's (and the real schema's) idempotency key
 * for a drafted reply.
 */
function fakeInboundEnv(vars: Partial<Env> = {}): Env {
  const store: StoredRow[] = []
  const leads: StoredLead[] = []
  const outbox: StoredOutbox[] = []
  // EM-9 (#169): `isInboundDraftRateLimited` (`src/rateLimit.ts`) writes and
  // counts one row per draft attempt here, keyed on `from_email`/`at` exactly
  // like the real `inbound_draft_attempts` table (0024). Modelled with real
  // counting, not a stub that always answers "under budget", so a test that
  // sends a genuine burst (see "EM-9 — rate limiting" below) exercises it
  // honestly.
  const draftAttempts: Array<{ from_email: string; at: string }> = []
  const norm = (sql: string) => sql.replace(/\s+/g, " ").trim()

  /** The `WHERE EXISTS (SELECT 1 FROM inbound_emails WHERE id = ?)` tail EM-4's own writes carry. */
  const inboundRowExists = (id: unknown): boolean => store.some((s) => s.id === id)

  const DB = {
    batch(statements: Array<{ run: () => Promise<{ meta: { changes: number } }> }>) {
      return statements.reduce<Promise<Array<{ meta: { changes: number } }>>>(
        async (soFar, statement) => [...(await soFar), await statement.run()],
        Promise.resolve([]),
      )
    },
    prepare(sql: string) {
      const statement = norm(sql)
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              if (statement.startsWith("INSERT INTO inbound_emails")) {
                const row = rowFromBindings(args)
                // `WHERE NOT EXISTS (SELECT 1 FROM inbound_emails WHERE
                // message_id = ?)` — one row per Message-ID, whatever address
                // it was delivered to. A NULL id matches nothing.
                const collides =
                  row.message_id !== null && store.some((s) => s.message_id === row.message_id)
                if (collides) return { meta: { changes: 0 } }
                store.push(row)
                return { meta: { changes: 1 } }
              }
              if (statement.startsWith("INSERT INTO leads")) {
                const [id, reference, summary, email, name, created_at, guardInboundId] = args as [
                  string,
                  string,
                  string,
                  string,
                  string | null,
                  string,
                  string,
                ]
                if (!inboundRowExists(guardInboundId)) return { meta: { changes: 0 } }
                leads.push({ id, reference, summary, email, name, created_at })
                return { meta: { changes: 1 } }
              }
              if (statement.startsWith("INSERT INTO outbox")) {
                const [
                  id,
                  submission_id,
                  to_email,
                  from_email,
                  subject,
                  preheader,
                  body,
                  cta_text,
                  cta_href,
                  coord_revision,
                  queued_at,
                  guardInboundId,
                ] = args as [
                  string,
                  string,
                  string,
                  string,
                  string,
                  string,
                  string,
                  string,
                  string,
                  number,
                  string,
                  string,
                ]
                if (!inboundRowExists(guardInboundId)) return { meta: { changes: 0 } }
                const collides = outbox.some(
                  (o) => o.submission_id === submission_id && o.coord_revision === coord_revision,
                )
                if (collides) return { meta: { changes: 0 } }
                outbox.push({
                  id,
                  submission_id,
                  coord_revision,
                  email_type: "intake-reply",
                  to_email,
                  from_email,
                  subject,
                  preheader,
                  body,
                  cta_text,
                  cta_href,
                  queued_at,
                  approval_state: "pending",
                })
                return { meta: { changes: 1 } }
              }
              // EM-9 (#169): `isInboundDraftRateLimited`'s own insert+delete
              // batch, mirrored on this fake table — see `draftAttempts` above.
              if (statement.startsWith("INSERT INTO inbound_draft_attempts")) {
                const [from_email, at] = args as [string, string]
                draftAttempts.push({ from_email, at })
                return { meta: { changes: 1 } }
              }
              if (statement.startsWith("DELETE FROM inbound_draft_attempts")) {
                const [fromEmail, retentionStart] = args as [string, string]
                for (let i = draftAttempts.length - 1; i >= 0; i--) {
                  const row = draftAttempts[i]
                  if (row !== undefined && row.from_email === fromEmail && row.at < retentionStart) {
                    draftAttempts.splice(i, 1)
                  }
                }
                return { meta: { changes: 0 } }
              }
              throw new Error(`unrecognized run statement: ${statement}`)
            },
            async first<T>(): Promise<T | null> {
              if (isRouterRead(statement)) return null
              // EM-9 (#169): the per-sender and total draft-rate-limit counts —
              // see `isInboundDraftRateLimited` (`src/rateLimit.ts`). Told apart
              // by whether the query also filters on `from_email`.
              if (statement.includes("FROM inbound_draft_attempts") && statement.includes("COUNT(*)")) {
                if (statement.includes("from_email = ?")) {
                  const [fromEmail, windowStart] = args as [string, string]
                  const count = draftAttempts.filter(
                    (a) => a.from_email === fromEmail && a.at >= windowStart,
                  ).length
                  return { count } as unknown as T
                }
                const [windowStart] = args as [string]
                const count = draftAttempts.filter((a) => a.at >= windowStart).length
                return { count } as unknown as T
              }
              if (!statement.includes("WHERE message_id = ?")) {
                throw new Error(`unrecognized first statement: ${statement}`)
              }
              const [messageId] = args as [string]
              return ((store.find((s) => s.message_id === messageId) ?? null) as T | null)
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

  return {
    DB,
    ...vars,
    rows: store,
    leadRows: leads,
    outboxRows: outbox,
    draftAttemptRows: draftAttempts,
  } as unknown as Env & {
    rows: StoredRow[]
    leadRows: StoredLead[]
    outboxRows: StoredOutbox[]
    draftAttemptRows: Array<{ from_email: string; at: string }>
  }
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
    routed_lead_id,
    routed_project_id,
    routed_submission_id,
    outbox_id,
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
    string | null,
    string | null,
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
    // Bound by the `INSERT` itself since issue #164/#165: the lead (or
    // message) and its draft are minted before the write and land in the
    // same batch, so the row is never briefly recorded as routed to
    // something it does not name.
    routed_lead_id,
    routed_project_id,
    routed_submission_id,
    outbox_id,
  }
}

function storedRows(env: Env): StoredRow[] {
  return (env as unknown as { rows: StoredRow[] }).rows
}

function storedLeads(env: Env): StoredLead[] {
  return (env as unknown as { leadRows: StoredLead[] }).leadRows
}

function storedOutbox(env: Env): StoredOutbox[] {
  return (env as unknown as { outboxRows: StoredOutbox[] }).outboxRows
}

/** EM-9 (#169): every recorded draft-rate-limit attempt — see `fakeInboundEnv`'s `draftAttempts`. */
function storedDraftAttempts(env: Env): Array<{ from_email: string; at: string }> {
  return (env as unknown as { draftAttemptRows: Array<{ from_email: string; at: string }> }).draftAttemptRows
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

/**
 * Issue #169 (EM-9 of milestone #5): "Cap drafts created, per sender and in
 * total, reusing the shape `src/rateLimit.ts` already has." What this file's
 * own fake DB earns its keep on is the *wiring* in `recordInboundEmail` —
 * that the cap is checked after suppression and before routing, that a
 * tripped cap produces `disposition = 'rate_limited'` with no lead, no
 * message and no draft, and that it does not touch a message the suppression
 * rules already refused. The underlying D1 sliding-window count itself is
 * `isRateLimited`'s own territory (`src/rateLimit.ts`) and, per this repo's
 * "a mocked D1 only proves the stub does what I wrote it to do" convention
 * (`test/rateLimit.test.ts`'s own module doc), is covered against real D1 by
 * `e2e/inbound-rate-limit.spec.ts` and the sealed acceptance suite instead.
 */
describe("EM-9 — rate limiting drafts, per sender and in total (issue #169)", () => {
  it("a sender under the cap gets a recorded row and a new draft — issue #169's own acceptance wording", async () => {
    const env = fakeInboundEnv()
    const { record: row } = await record(env)
    expect(row.disposition).toBe("received")
    expect(row.outboxId, "\"a sender under it gets both\"").not.toBeNull()
  })

  it("rate-limits a sender's own overflow message, while their earlier messages in the same burst still draft", async () => {
    const env = fakeInboundEnv()
    const burstSize = PER_SENDER_MAX_DRAFTS + 2 // two messages should overflow

    const results: Array<{
      disposition: InboundEmailRecord["disposition"]
      outboxId: string | null
      routedKind: string | null
    }> = []
    for (let i = 0; i < burstSize; i++) {
      // eslint-disable-next-line no-await-in-loop -- ordering across the burst is the whole point
      const { record: row } = await record(env, { messageId: `em9-sender-burst-${i}@sender.example.test` })
      results.push({ disposition: row.disposition, outboxId: row.outboxId, routedKind: row.routedKind })
    }

    for (let i = 0; i < PER_SENDER_MAX_DRAFTS; i++) {
      expect(results[i]?.disposition, `message #${i + 1} is within the per-sender cap`).toBe("received")
      expect(results[i]?.outboxId, `message #${i + 1} earns a draft`).not.toBeNull()
    }
    for (let i = PER_SENDER_MAX_DRAFTS; i < burstSize; i++) {
      expect(results[i]?.disposition, `message #${i + 1} exceeds the per-sender cap`).toBe("rate_limited")
      expect(results[i]?.outboxId, "a rate-limited message earns no draft").toBeNull()
      expect(results[i]?.routedKind, "a rate-limited message is never routed at all").toBeNull()
    }

    // Still recorded, "should not erase the evidence of itself" — #169's own words.
    expect(storedRows(env)).toHaveLength(burstSize)
    expect(storedOutbox(env)).toHaveLength(PER_SENDER_MAX_DRAFTS)
    expect(storedLeads(env)).toHaveLength(PER_SENDER_MAX_DRAFTS)
  })

  it("does not spend the draft-rate-limit budget on a message the suppression rules already refused", async () => {
    const env = fakeInboundEnv()
    const burstSize = PER_SENDER_MAX_DRAFTS + 2

    for (let i = 0; i < burstSize; i++) {
      const { record: row } = await record(env, {
        // eslint-disable-next-line no-await-in-loop -- ordering is the point
        messageId: `em9-suppressed-burst-${i}@sender.example.test`,
        extraHeaders: { "Auto-Submitted": "auto-replied" },
      })
      expect(row.disposition, "an auto-responder is suppressed, never rate-limited").toBe("suppressed")
    }

    expect(
      storedDraftAttempts(env),
      "a suppressed message was never going to draft anything, so it must not cost this budget",
    ).toHaveLength(0)
  })
})

/**
 * Issue #169 (EM-9): "Dropped, and the reply says so." `attachmentCount` was
 * already computed and stored by EM-1; this issue is the first thing that
 * actually reads it back out on the way to a draft. See
 * `test/notifications.test.ts`'s own coverage of `intakeReplyContent`'s and
 * `routedReplyContent`'s attachment-disclosure copy for the templates in
 * isolation — this describes the wiring that gets a real message's count to
 * them.
 */
describe("EM-9 — attachments: dropped, counted, and disclosed in the draft (issue #169)", () => {
  const attachmentBlob = [
    "From: wren@sender.example.test",
    "Subject: with an attachment",
    "Message-ID: <em9-attach@sender.example.test>",
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

  it("the drafted body says the attachment did not come through, without claiming it was kept", async () => {
    const env = fakeInboundEnv()
    const { record: row } = await recordInboundEmail(env, {
      from: "wren@sender.example.test",
      to: "intake@mail.example.test",
      raw: attachmentBlob,
    })
    expect(row.attachmentCount).toBe(1)
    expect(row.outboxId).not.toBeNull()

    const draft = storedOutbox(env).find((o) => o.id === row.outboxId)
    expect(draft?.body).toMatch(/attach/i)
    expect(draft?.body).not.toMatch(/\b(saved|kept|available|download|retrievable)\b/i)
    // #164's own rule holds for an attachment-bearing message too: never
    // quote the sender's own words back to them.
    expect(draft?.body).not.toContain("See attached.")
  })

  it("drafts no attachment disclosure at all when there is nothing to disclose", async () => {
    const env = fakeInboundEnv()
    const { record: row } = await record(env)
    expect(row.attachmentCount).toBe(0)
    const draft = storedOutbox(env).find((o) => o.id === row.outboxId)
    expect(draft?.body).not.toMatch(/attach/i)
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

  it("resolves the same Message-ID delivered to a different envelope recipient to the row already recorded", async () => {
    const env = fakeInboundEnv()
    const first = await record(env, { messageId: "dup002@sender.example.test" })
    const second = await record(env, {
      messageId: "dup002@sender.example.test",
      envelopeTo: "intake+SUB-ZZ9900@mail.example.test",
    })

    // One message that Cloudflare delivered to two of our addresses is still
    // one message — answering it twice would mean two acknowledgements to the
    // sender and two leads for an operator to triage. See "one row per
    // Message-ID" in `src/inboundEmail.ts`.
    expect(second.duplicate).toBe(true)
    expect(second.record.id).toBe(first.record.id)
    expect(second.record.toEmail).toBe(first.record.toEmail)
    expect(storedRows(env)).toHaveLength(1)
  })

  it("records two rows for two messages with no Message-ID at all — there is no identity to dedupe on", async () => {
    const env = fakeInboundEnv()
    await record(env, { messageId: null })
    await record(env, { messageId: null })
    expect(storedRows(env)).toHaveLength(2)
  })
})

/**
 * Issue #164 (EM-4 of milestone #5): rung 6 ("nobody we know") creates a lead
 * — via `leadCreationStatement`, the exact statement `POST /start` writes —
 * and drafts its acknowledgement via `intakeReplyStatement`, both in the same
 * `DB.batch()` as the `inbound_emails` row itself. `passHeaders()` below is what gets
 * a fixture past rung 6's own auth gate (`decideRoute` in
 * `src/inboundRouter.ts` falls to `unrouted`, not `lead`, unless
 * `authResult === "pass"`) — every case here is a genuine, authenticated
 * stranger: no plus address, no quoted reference, and the router's own
 * `clients`/`submissions`/`projects` reads answered as "nothing found" (see
 * `isRouterRead` above), which is exactly rung 6's own precondition.
 */
describe("EM-4 — rung 6 creates a lead and drafts an acknowledgement (issue #164)", () => {
  function passHeaders(): Record<string, string> {
    return {
      "Authentication-Results": "mx.forwarder.example.test; dmarc=pass header.from=sender.example.test",
    }
  }

  it("creates exactly one leads row and one outbox row, and links both back onto the inbound_emails row", async () => {
    const env = fakeInboundEnv()
    const { record: row } = await record(env, {
      from: "Priya Nair <priya@sender.example.test>",
      body: "Could someone help us build a small booking page?",
      extraHeaders: passHeaders(),
    })

    expect(row.routedKind, "rung 6 — nobody the router's reads found anything for").toBe("lead")
    expect(row.routedLeadId).not.toBeNull()
    expect(row.outboxId).not.toBeNull()

    const leads = storedLeads(env)
    expect(leads).toHaveLength(1)
    expect(leads[0]?.id).toBe(row.routedLeadId)
    // Issue #164 scope item 1, verbatim: summary/email/name.
    expect(leads[0]?.summary).toBe("Could someone help us build a small booking page?")
    expect(leads[0]?.email).toBe("priya@sender.example.test")
    expect(leads[0]?.name).toBe("Priya Nair")

    const drafts = storedOutbox(env)
    expect(drafts).toHaveLength(1)
    expect(drafts[0]?.id).toBe(row.outboxId)
    expect(drafts[0]?.email_type).toBe("intake-reply")
    expect(drafts[0]?.approval_state, "issue #164 scope item 3").toBe("pending")
    expect(drafts[0]?.to_email).toBe("priya@sender.example.test")
  })

  it("leaves the lead's name null when the `From:` header carries no display name — same optionality /start's own leads get", async () => {
    const env = fakeInboundEnv()
    const { record: row } = await record(env, {
      from: "bare@sender.example.test",
      extraHeaders: passHeaders(),
    })
    const lead = storedLeads(env).find((l) => l.id === row.routedLeadId)
    expect(lead?.name).toBeNull()
  })

  it("the drafted body carries the lead's own LEAD-XXXXXX reference and never the sender's own message", async () => {
    const env = fakeInboundEnv()
    const canary = "purple-narwhal-invoice-4471"
    const { record: row } = await record(env, {
      body: `Please quote a job referencing ${canary}.`,
      extraHeaders: passHeaders(),
    })
    const lead = storedLeads(env).find((l) => l.id === row.routedLeadId)
    const draft = storedOutbox(env).find((o) => o.id === row.outboxId)

    expect(draft?.body).toContain(lead?.reference)
    expect(draft?.body).not.toContain(canary)
    expect(draft?.subject).not.toContain(canary)
  })

  it("does not create a lead or a draft for a suppressed message — it is never routed at all", async () => {
    // #161's own rule, restated by `src/inboundEmail.ts`'s module doc: a
    // suppressed message never reaches the router (`decision` stays `null`),
    // so it can never reach EM-4's `kind === "lead"` branch either — an
    // auto-responder must never be resolved to a person or given a draft.
    const env = fakeInboundEnv()
    const { record: row } = await record(env, { extraHeaders: { "Auto-Submitted": "auto-replied" } })
    expect(row.disposition).toBe("suppressed")
    expect(row.routedKind).toBeNull()
    expect(row.routedLeadId).toBeNull()
    expect(row.outboxId).toBeNull()
    expect(storedLeads(env)).toHaveLength(0)
    expect(storedOutbox(env)).toHaveLength(0)
  })

  /**
   * Issue #164 (EM-4)'s own correction to #163's DMARC gate (see
   * `src/inboundRouter.ts`'s module doc and `test/inboundRouter.test.ts`'s
   * "decideRoute — rung 6 (default)" tests for the full reasoning): an address
   * that matches nothing has no identity for a spoofed `From:` to steal, so it
   * still reaches rung 6's `lead` outcome regardless of DMARC. This file's own
   * fake (`isRouterRead`, above) always answers the router's `clients`/
   * `submissions`/`projects` reads as "nothing found" — so within this fake
   * there is no way to construct a genuine `unrouted` outcome at all, and that
   * is itself the behaviour under test: a DMARC failure alone, with nothing
   * else to disambiguate, is not enough to keep this out of rung 6's lead
   * branch.
   */
  it("still creates a lead when DMARC fails outright, as long as nothing else matches either", async () => {
    const env = fakeInboundEnv()
    const { record: row } = await record(env, { extraHeaders: { "Authentication-Results": "mx.example.test; dmarc=fail" } })
    expect(row.routedKind).toBe("lead")
    expect(row.routedLeadId).not.toBeNull()
    expect(row.outboxId).not.toBeNull()
  })

  it("re-delivering the same stranger message creates no second lead and no second draft", async () => {
    const env = fakeInboundEnv()
    const opts = {
      messageId: "em4-dup@sender.example.test",
      extraHeaders: passHeaders(),
    }
    const first = await record(env, opts)
    expect(first.duplicate).toBe(false)
    expect(first.record.routedLeadId).not.toBeNull()
    expect(first.record.outboxId).not.toBeNull()

    const second = await record(env, opts)
    expect(second.duplicate, "the redelivery guard resolves this to the same row").toBe(true)
    expect(second.record.routedLeadId).toBe(first.record.routedLeadId)
    expect(second.record.outboxId).toBe(first.record.outboxId)

    expect(
      storedLeads(env),
      "issue #164: \"an inbound message that is processed twice must produce one lead\"",
    ).toHaveLength(1)
    expect(
      storedOutbox(env),
      "issue #164: \"an inbound message that is processed twice must produce ... one draft\"",
    ).toHaveLength(1)
  })

  it("creates no second lead when the same message reaches a second one of our addresses", async () => {
    const env = fakeInboundEnv()
    const opts = {
      messageId: "em4-two-addresses@sender.example.test",
      extraHeaders: passHeaders(),
    }
    const first = await record(env, opts)
    const second = await record(env, {
      ...opts,
      envelopeTo: "intake+SUB-ZZ9900@mail.example.test",
    })

    expect(second.record.id).toBe(first.record.id)
    expect(second.record.routedLeadId).toBe(first.record.routedLeadId)
    expect(storedLeads(env), "one message, one lead — whatever it was addressed to").toHaveLength(1)
    expect(storedOutbox(env)).toHaveLength(1)
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
