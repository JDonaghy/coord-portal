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
    expect(messageAuthorLabel(message({ authorRole: "customer" }), "customer")).toBe("You")
  })

  it("labels the viewer's own message 'You', for an operator viewing their own message", () => {
    expect(messageAuthorLabel(message({ authorRole: "operator" }), "operator")).toBe("You")
  })

  it("labels an operator's message with the business name, never the operator's address, for a customer", () => {
    expect(
      messageAuthorLabel(
        message({ authorRole: "operator", authorEmail: "ops-personal@example.test" }),
        "customer",
      ),
    ).toBe("Heuron Technology")
  })

  it("labels a customer's message with their own email, for an operator", () => {
    expect(
      messageAuthorLabel(
        message({ authorRole: "customer", authorEmail: "someone@example.test" }),
        "operator",
      ),
    ).toBe("someone@example.test")
  })
})
