import { describe, expect, it } from "vitest"

import { messageAuthorLabel } from "../src/routes/submission"
import type { Message } from "../src/messages"

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
