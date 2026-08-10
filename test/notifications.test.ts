import { describe, expect, it } from "vitest"

import {
  SENDING_TYPES,
  emailContent,
  listOutboxForCustomer,
  recordNotificationForStatus,
  sendTypeForStatus,
} from "../src/notifications"
import type { Submission } from "../src/submissions"
import type { Env } from "../src/types"

/**
 * Unit coverage for the decidable parts of issue #14's notification module:
 * the status -> send-type mapping (the whole restraint half of the feature)
 * and the per-type copy `emailContent` produces.
 *
 * A row actually landing in `outbox`, surviving a replayed push, and reading
 * back through `GET /outbox` scoped to the right customer are covered
 * black-box against real D1 in `e2e/notifications.spec.ts` — a mocked D1 here
 * would only prove the stub does what this file told it to do. What a fake
 * DB earns its keep on is `recordNotificationForStatus`'s gating (no query at
 * all for a non-sending status, no query for a submission with no address)
 * and `emailContent`'s branch coverage, including the one branch
 * (`signoff-ready`) that reads the current round back out of D1.
 *
 * Every string below is invented — see CLAUDE.md rule 1.
 */

function submission(overrides: Partial<Submission> = {}): Submission {
  return {
    id: "sub_000001",
    reference: "SUB-000001",
    status: "in-design",
    customerEmail: "customer@example.test",
    outcome: "A printable watering rota for the community greenhouse.",
    audience: "Saturday volunteers",
    doneDefinition: "Anyone on shift can see which beds are due without asking.",
    constraints: null,
    projectScope: null,
    createdAt: "2026-01-01T00:00:00Z",
    coordRevision: 3,
    ...overrides,
  }
}

/** A fake D1 tracking every `outbox` insert and answering `getCurrentRound`'s query. */
function fakeDb(options: { round?: Record<string, unknown> | null } = {}) {
  const inserted: unknown[][] = []
  let queries = 0

  const DB = {
    prepare(sql: string) {
      queries++
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              if (sql.includes("INSERT INTO outbox")) inserted.push(args)
              return {}
            },
            async first() {
              if (sql.includes("FROM design_rounds")) return options.round ?? null
              return null
            },
            async all() {
              return { results: [] }
            },
          }
        },
      }
    },
  }

  return { env: { DB } as unknown as Env, inserted, queryCount: () => queries }
}

describe("sendTypeForStatus", () => {
  it("maps exactly the three sending states to their pinned data-email-type", () => {
    expect(sendTypeForStatus("awaiting-signoff")).toBe("signoff-ready")
    expect(sendTypeForStatus("needs-input")).toBe("needs-input")
    expect(sendTypeForStatus("shipped")).toBe("shipped")
  })

  it("maps every other slug in the pinned vocabulary to nothing", () => {
    for (const status of ["describing", "in-design", "planned", "in-progress", "quality-check", "on-hold"]) {
      expect(sendTypeForStatus(status)).toBeNull()
    }
  })

  it("is null for a slug outside the pinned vocabulary entirely", () => {
    expect(sendTypeForStatus("")).toBeNull()
    expect(sendTypeForStatus("Shipped")).toBeNull()
    expect(sendTypeForStatus("awaiting_signoff")).toBeNull()
  })
})

describe("SENDING_TYPES", () => {
  it("is exactly signoff-ready / needs-input / shipped", () => {
    expect([...SENDING_TYPES]).toEqual(["signoff-ready", "needs-input", "shipped"])
  })
})

describe("emailContent", () => {
  it("signoff-ready: names the round in the preheader when one is on record", async () => {
    const { env } = fakeDb({
      round: {
        round: 2,
        outcome_definition: "Volunteers can see a rota on their phone.",
        decomposition: "[]",
        mock_bundle: null,
        opened_at: "2026-01-02T00:00:00Z",
        verdict: null,
        comment: null,
        decided_at: null,
      },
    })
    const content = await emailContent(env, submission(), "signoff-ready")
    expect(content.subject.length).toBeGreaterThan(0)
    expect(content.preheader).toContain("Round 2")
    expect(content.ctaText.length).toBeGreaterThan(0)
    expect(content.ctaHref).toBe("/submissions/sub_000001")
  })

  it("signoff-ready: falls back to the title alone when no round is on record", async () => {
    const { env } = fakeDb({ round: null })
    const content = await emailContent(env, submission(), "signoff-ready")
    expect(content.preheader).not.toContain("Round")
    expect(content.preheader.length).toBeGreaterThan(0)
  })

  it("needs-input: asks the customer to answer, without touching the round table", async () => {
    const { env, queryCount } = fakeDb()
    const content = await emailContent(env, submission(), "needs-input")
    expect(content.ctaText.length).toBeGreaterThan(0)
    expect(content.body).toContain("paused")
    // No reason to read a design round for a question — the branch must not.
    expect(queryCount()).toBe(0)
  })

  it("shipped: is the terminal copy, and reads no round either", async () => {
    const { env, queryCount } = fakeDb()
    const content = await emailContent(env, submission(), "shipped")
    expect(content.body.length).toBeGreaterThan(0)
    expect(content.ctaText.length).toBeGreaterThan(0)
    expect(queryCount()).toBe(0)
  })

  it("never puts an engineer-side title fragment into a customer-facing subject", async () => {
    const { env } = fakeDb()
    for (const type of SENDING_TYPES) {
      const content = await emailContent(env, submission(), type)
      expect(content.subject).not.toMatch(/#\d+/)
    }
  })
})

describe("recordNotificationForStatus", () => {
  it("writes nothing at all for a non-sending status — no query, no insert", async () => {
    const { env, inserted, queryCount } = fakeDb()
    await recordNotificationForStatus(env, submission(), "in-progress", 4, "2026-01-03T00:00:00Z")
    expect(inserted).toHaveLength(0)
    expect(queryCount()).toBe(0)
  })

  it("writes nothing when the submission has no recorded address", async () => {
    const { env, inserted } = fakeDb()
    await recordNotificationForStatus(
      env,
      submission({ customerEmail: null }),
      "shipped",
      4,
      "2026-01-03T00:00:00Z",
    )
    expect(inserted).toHaveLength(0)
  })

  it("inserts exactly one outbox row for a sending status, addressed to the customer", async () => {
    const { env, inserted } = fakeDb()
    await recordNotificationForStatus(env, submission(), "needs-input", 4, "2026-01-03T00:00:00Z")
    expect(inserted).toHaveLength(1)

    const [id, submissionId, type, to, from, subject, , , , , revision, sentAt] = inserted[0] as [
      string,
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
    ]
    expect(id).toMatch(/^ntf_/)
    expect(submissionId).toBe("SUB-000001")
    expect(type).toBe("needs-input")
    expect(to).toBe("customer@example.test")
    expect(from).toContain("@")
    expect(subject.length).toBeGreaterThan(0)
    expect(revision).toBe(4)
    expect(sentAt).toBe("2026-01-03T00:00:00Z")
  })
})

describe("listOutboxForCustomer", () => {
  it("skips a row whose email_type is not one of the pinned sending types", async () => {
    const DB = {
      prepare(_sql: string) {
        return {
          bind(_email: string) {
            return {
              async all() {
                return {
                  results: [
                    {
                      id: "ntf_1",
                      submission_id: "SUB-000001",
                      email_type: "shipped",
                      to_email: "customer@example.test",
                      from_email: "coord-portal <notify@example.test>",
                      subject: "Your work has shipped",
                      preheader: "A rota",
                      body: "It is live.",
                      cta_text: "View the result",
                      cta_href: "/submissions/sub_000001",
                      sent_at: "2026-01-04T00:00:00Z",
                    },
                    {
                      id: "ntf_2",
                      submission_id: "SUB-000001",
                      email_type: "a-hand-edited-value",
                      to_email: "customer@example.test",
                      from_email: "coord-portal <notify@example.test>",
                      subject: "corrupt row",
                      preheader: "corrupt row",
                      body: "corrupt row",
                      cta_text: "corrupt row",
                      cta_href: "/submissions/sub_000001",
                      sent_at: "2026-01-05T00:00:00Z",
                    },
                  ],
                }
              },
            }
          },
        }
      },
    }

    const emails = await listOutboxForCustomer({ DB } as unknown as Env, "customer@example.test")
    expect(emails).toHaveLength(1)
    expect(emails[0]?.id).toBe("ntf_1")
  })
})
