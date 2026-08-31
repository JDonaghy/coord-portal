import { describe, expect, it } from "vitest"

import { messageAuthorLabel } from "../src/routes/submission"
import { messageCreationStatement, mintMessage } from "../src/messages"
import type { Message } from "../src/messages"
import type { Env } from "../src/types"

/**
 * Unit coverage for `messageAuthorLabel` (issue #110) — the one pure function
 * in the chat-thread rendering path. Everything else in `src/routes/submission.ts`
 * and `src/routes/leads.ts` that touches the thread needs a real D1 database
 * (a message actually landing, a customer and an operator each posting one,
 * the operator route's own ownership gate) and is covered black-box in
 * `e2e/messages.spec.ts` instead — the same split `test/rounds.test.ts`
 * documents for issue #13's decidable-vs-database-backed logic.
 *
 * Every string below is invented — see CLAUDE.md rule 1.
 */

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg_0000000000000000000000",
    submissionId: "SUB-000000",
    authorRole: "customer",
    authorEmail: "customer@example.test",
    body: "A synthetic message body.",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

describe("messageAuthorLabel", () => {
  it("labels the viewer's own message 'You', for a customer viewing their own message", () => {
    expect(
      messageAuthorLabel(
        message({ authorRole: "customer", authorEmail: "customer@example.test" }),
        "customer",
        "customer@example.test",
      ),
    ).toBe("You")
  })

  it("labels the viewer's own message 'You', for an operator viewing their own message", () => {
    expect(
      messageAuthorLabel(
        message({ authorRole: "operator", authorEmail: "alice@example.test" }),
        "operator",
        "alice@example.test",
      ),
    ).toBe("You")
  })

  it("labels an operator's message with the business name, never the operator's address, for a customer", () => {
    expect(
      messageAuthorLabel(
        message({ authorRole: "operator", authorEmail: "ops-personal@example.test" }),
        "customer",
        "customer@example.test",
      ),
    ).toBe("Heuron Technology")
  })

  it("labels a customer's message with their own email, for an operator", () => {
    expect(
      messageAuthorLabel(
        message({ authorRole: "customer", authorEmail: "someone@example.test" }),
        "operator",
        "ops@example.test",
      ),
    ).toBe("someone@example.test")
  })

  it("labels a colleague operator's message with their own email, never 'You' — two distinct operator identities", () => {
    // OPERATOR_EMAILS (src/operators.ts) is a list: alice@x.com and bob@x.com
    // can both be configured operators. Alice posts on a lead's thread; Bob
    // views it. Comparing only `authorRole === viewerRole` (both "operator")
    // would wrongly render "You" for Alice's message on Bob's screen — the
    // comparison has to be identity (`authorEmail` vs `viewerEmail`), not role.
    expect(
      messageAuthorLabel(
        message({ authorRole: "operator", authorEmail: "alice@example.test" }),
        "operator",
        "bob@example.test",
      ),
    ).toBe("alice@example.test")
  })
})

describe("mintMessage — issue #165 (EM-5 of milestone #5)", () => {
  it("mints an id and a created_at without writing anything", () => {
    const message = mintMessage({
      submissionId: "SUB-A1B2C3",
      authorRole: "customer",
      authorEmail: "sender@example.test",
      body: "A synthetic inbound reply, routed to its own thread.",
    })
    expect(message.id).toMatch(/^msg_/)
    expect(Date.parse(message.createdAt)).not.toBeNaN()
    expect(message.submissionId).toBe("SUB-A1B2C3")
    expect(message.authorRole).toBe("customer")
    expect(message.authorEmail).toBe("sender@example.test")
    expect(message.body).toBe("A synthetic inbound reply, routed to its own thread.")
  })

  it("mints a fresh id on every call", () => {
    const input = {
      submissionId: "SUB-A1B2C3",
      authorRole: "customer" as const,
      authorEmail: "sender@example.test",
      body: "same body",
    }
    expect(mintMessage(input).id).not.toBe(mintMessage(input).id)
  })
})

describe("messageCreationStatement — issue #165 (EM-5 of milestone #5)", () => {
  /**
   * A fake `messages` table that enforces the `WHERE EXISTS (SELECT 1 FROM
   * inbound_emails WHERE id = ?)` guard `src/inboundEmail.ts` carries — the
   * same "no window where a message exists without the `inbound_emails` row
   * that justifies it" argument `test/notifications.test.ts`'s own
   * `fakeOutboxDb` makes for `intakeReplyStatement`'s guard.
   */
  function fakeMessagesDb() {
    const rows: Array<{ id: string; submission_id: string; author_role: string; author_email: string; body: string }> = []
    const recordedInboundIds = new Set<string>()
    const DB = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async run() {
                if (sql.includes("INSERT INTO messages")) {
                  const [id, submission_id, author_role, author_email, body] = args as [
                    string,
                    string,
                    string,
                    string,
                    string,
                  ]
                  const guardInboundId = args[args.length - 1] as string | undefined
                  if (sql.includes("WHERE EXISTS") && !recordedInboundIds.has(guardInboundId ?? "")) {
                    return { meta: { changes: 0 } }
                  }
                  rows.push({ id, submission_id, author_role, author_email, body })
                  return { meta: { changes: 1 } }
                }
                throw new Error(`unrecognized run statement: ${sql}`)
              },
            }
          },
        }
      },
    }
    return { env: { DB } as unknown as Env, rows, recordedInboundIds }
  }

  function guardOn(inboundEmailId: string) {
    return {
      clause: "WHERE EXISTS (SELECT 1 FROM inbound_emails WHERE id = ?)",
      bindings: [inboundEmailId],
    }
  }

  it("writes the message with no guard when none is given — postMessage's own ordinary shape", async () => {
    const { env, rows } = fakeMessagesDb()
    const message = mintMessage({
      submissionId: "SUB-A1B2C3",
      authorRole: "operator",
      authorEmail: "ops@example.test",
      body: "A synthetic operator reply.",
    })
    const result = await messageCreationStatement(env, message).run()
    expect(result.meta?.changes).toBe(1)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(message.id)
  })

  it("writes nothing when the inbound_emails row it belongs to never landed — the batch guard", async () => {
    const { env, rows } = fakeMessagesDb()
    const message = mintMessage({
      submissionId: "SUB-A1B2C3",
      authorRole: "customer",
      authorEmail: "sender@example.test",
      body: "A synthetic inbound reply.",
    })
    const result = await messageCreationStatement(env, message, guardOn("inb_never")).run()
    expect(result.meta?.changes).toBe(0)
    expect(rows, "a redelivery whose inbound insert did nothing must post no message").toHaveLength(0)
  })

  it("writes the message once its guard's inbound_emails row exists", async () => {
    const { env, rows, recordedInboundIds } = fakeMessagesDb()
    recordedInboundIds.add("inb_abc123")
    const message = mintMessage({
      submissionId: "SUB-A1B2C3",
      authorRole: "customer",
      authorEmail: "sender@example.test",
      body: "A synthetic inbound reply.",
    })
    const result = await messageCreationStatement(env, message, guardOn("inb_abc123")).run()
    expect(result.meta?.changes).toBe(1)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.author_role).toBe("customer")
    expect(rows[0]?.submission_id).toBe("SUB-A1B2C3")
  })
})
