import { describe, expect, it } from "vitest"

import {
  SENDING_TYPES,
  emailContent,
  listAllOutbox,
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
    projectId: null,
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

  // ── issue #105: the copy names a business and a person ────────────────────
  //
  // Reported for real (dogfood, SUB-C467AA): a `signoff-ready` send landed in
  // Hotmail's spam folder and was nearly dismissed as spam even after being
  // found there. The three bodies were one canned sentence each, with no
  // sender, no business name and no reason-for-receipt — indistinguishable
  // from the boilerplate a bulk sender emits.

  it("every subject names Heuron Technology, so the inbox list is not anonymous", async () => {
    const { env } = fakeDb({ round: null })
    for (const type of SENDING_TYPES) {
      const content = await emailContent(env, submission(), type)
      expect(content.subject, `${type} subject`).toContain("Heuron Technology")
    }
  })

  it("every body closes with a first-person signature naming the sender", async () => {
    const { env } = fakeDb({ round: null })
    for (const type of SENDING_TYPES) {
      const content = await emailContent(env, submission(), type)
      expect(content.body, `${type} body`).toContain("— John, Heuron Technology")
      // Blank-line separated, so `composeHtmlBody` renders it as its own
      // paragraph rather than running it onto the sentence above.
      expect(content.body, `${type} body`).toMatch(/\n\n— John, Heuron Technology$/)
    }
  })

  it("speaks as one person, not an anonymous corporate 'we'", async () => {
    // The portal fronts a one-person shop. "We've put together a design" named
    // nobody; the site's own voice is first-person singular, and matching it is
    // both truer and more trustworthy.
    const { env } = fakeDb({ round: null })
    for (const type of SENDING_TYPES) {
      const content = await emailContent(env, submission(), type)
      expect(content.body, `${type} body`).not.toMatch(/\b(we|we've|us|our)\b/i)
    }
  })

  it("the new copy still leaks no engineer-side identifier", async () => {
    // ms-1 contract note 6, treated as an absolute by
    // `tests/acceptance/ms-1/14-notifications.spec.ts`: an email is the one
    // customer-facing surface that leaves the product and is kept forever, so
    // rewritten copy must clear the same wall the old copy did.
    const { env } = fakeDb({ round: null })
    const forbidden = /#\d+|\bissue\s*#?\d+|\bepic\b|\bmilestone\b|\bpull request\b|\bPR\b|\bbranch|\bcommit|\bworktree\b|\bagent\b|\bworker\b|\bgithub\b|\bdaemon\b|\bcoord\b/i
    for (const type of SENDING_TYPES) {
      const content = await emailContent(env, submission(), type)
      for (const [field, value] of Object.entries(content)) {
        expect(value, `${type}.${field}`).not.toMatch(forbidden)
      }
    }
  })

  it("leaves the round-aware preheader and the CTA destination exactly as they were", async () => {
    // #105 is a copy and branding change. The preheader is the one string the
    // sealed suite reads a round number out of, and the CTA's destination is
    // #14's whole premise — neither was part of the defect.
    const { env } = fakeDb({
      round: {
        round: 3,
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
    expect(content.preheader).toContain("Round 3")
    expect(content.preheader).not.toContain("Heuron")
    expect(content.ctaText).toBe("Review the design")
    expect(content.ctaHref).toBe("/submissions/sub_000001")
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

    const [id, submissionId, type, to, from, subject, , , , , revision, queuedAt] = inserted[0] as [
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
    // Issue #49: a freshly-decided send is born `queued` — `status`,
    // `attempts`, `provider_message_id` and `sent_at` (delivery time) are all
    // left to their column defaults, never bound explicitly here. This column
    // is `queued_at` (decision time), not delivery time.
    expect(queuedAt).toBe("2026-01-03T00:00:00Z")
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
                      queued_at: "2026-01-04T00:00:00Z",
                      status: "queued",
                      provider_message_id: null,
                      attempts: 0,
                      last_error: null,
                      sent_at: null,
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
                      queued_at: "2026-01-05T00:00:00Z",
                      status: "queued",
                      provider_message_id: null,
                      attempts: 0,
                      last_error: null,
                      sent_at: null,
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

  /** A fake D1 answering `SELECT * FROM outbox WHERE to_email = ?` with fixed rows. */
  function dbWithRows(results: unknown[]) {
    return {
      DB: {
        prepare(_sql: string) {
          return {
            bind(_email: string) {
              return { async all() { return { results } } }
            },
          }
        },
      },
    } as unknown as Env
  }

  it("skips a row whose status is not one of the pinned delivery states — issue #49's CHECK backstop", async () => {
    const env = dbWithRows([
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
        queued_at: "2026-01-04T00:00:00Z",
        status: "a-hand-edited-value",
        provider_message_id: null,
        attempts: 0,
        last_error: null,
        sent_at: null,
      },
    ])

    const emails = await listOutboxForCustomer(env, "customer@example.test")
    expect(emails).toHaveLength(0)
  })

  it("maps a sent row's delivery fields straight through", async () => {
    const env = dbWithRows([
      {
        id: "ntf_1",
        submission_id: "SUB-000001",
        email_type: "signoff-ready",
        to_email: "customer@example.test",
        from_email: "coord-portal <notify@example.test>",
        subject: "Your design is ready for sign-off",
        preheader: "A rota",
        body: "Take a look.",
        cta_text: "Review the design",
        cta_href: "/submissions/sub_000001",
        queued_at: "2026-01-04T00:00:00Z",
        status: "sent",
        provider_message_id: "prov_abc123",
        attempts: 1,
        last_error: null,
        sent_at: "2026-01-04T00:05:00Z",
      },
    ])

    const [email] = await listOutboxForCustomer(env, "customer@example.test")
    expect(email?.status).toBe("sent")
    expect(email?.providerMessageId).toBe("prov_abc123")
    expect(email?.sentAt).toBe("2026-01-04T00:05:00Z")
    expect(email?.queuedAt).toBe("2026-01-04T00:00:00Z")
  })

  it("maps a failed row's attempts and raw last_error straight through", async () => {
    const env = dbWithRows([
      {
        id: "ntf_1",
        submission_id: "SUB-000001",
        email_type: "needs-input",
        to_email: "customer@example.test",
        from_email: "coord-portal <notify@example.test>",
        subject: "We have a question for you",
        preheader: "A rota",
        body: "Work is paused.",
        cta_text: "Answer the question",
        cta_href: "/submissions/sub_000001",
        queued_at: "2026-01-04T00:00:00Z",
        status: "failed",
        provider_message_id: null,
        attempts: 5,
        last_error: "Resend API returned 401",
        sent_at: null,
      },
    ])

    const [email] = await listOutboxForCustomer(env, "customer@example.test")
    expect(email?.status).toBe("failed")
    expect(email?.attempts).toBe(5)
    // The raw column — src/routes/outbox.ts, not this module, is responsible
    // for never rendering this verbatim to a customer.
    expect(email?.lastError).toBe("Resend API returned 401")
    expect(email?.sentAt).toBeNull()
  })
})

describe("listAllOutbox", () => {
  /**
   * Issue #55's reader: every `outbox` row, every customer, on one screen for
   * `GET /deliveries` (`src/routes/deliveries.ts`). Unlike `listOutboxForCustomer`
   * above, the real query binds nothing at all — no `to_email`, no filter — so
   * this fake answers `.all()` straight off `.prepare()` with no `.bind()` in
   * between. `e2e/deliveries.spec.ts` drives the same function through the real
   * route against real D1; what a fake DB earns its keep on here is the same
   * thing it earns above: `fromRow`'s skip-on-corruption backstop and the raw,
   * unredacted mapping of `last_error` — the one field the two readers treat
   * identically (redaction is `src/routes/outbox.ts`'s job on the way OUT, not
   * this module's, for either reader).
   */
  function row(overrides: Record<string, unknown> = {}) {
    return {
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
      queued_at: "2026-01-04T00:00:00Z",
      status: "queued",
      provider_message_id: null,
      attempts: 0,
      last_error: null,
      sent_at: null,
      ...overrides,
    }
  }

  function dbWithRows(results: unknown[]): Env {
    return {
      DB: {
        prepare(_sql: string) {
          return {
            async all() {
              return { results }
            },
          }
        },
      },
    } as unknown as Env
  }

  it("is unscoped — rows from every customer come back, not filtered by any one recipient", async () => {
    const env = dbWithRows([
      row({ id: "ntf_1", to_email: "alice@example.test" }),
      row({ id: "ntf_2", to_email: "bob@example.test" }),
    ])
    const emails = await listAllOutbox(env)
    expect(emails.map((email) => email.to).sort()).toEqual([
      "alice@example.test",
      "bob@example.test",
    ])
  })

  it("skips a row whose status is not one of the pinned delivery states — same CHECK backstop as listOutboxForCustomer", async () => {
    const env = dbWithRows([row({ status: "a-hand-edited-value" })])
    expect(await listAllOutbox(env)).toHaveLength(0)
  })

  it("skips a row whose email_type is not one of the pinned sending types", async () => {
    const env = dbWithRows([row({ email_type: "a-hand-edited-value" })])
    expect(await listAllOutbox(env)).toHaveLength(0)
  })

  it("maps a sent row's delivery fields straight through", async () => {
    const env = dbWithRows([
      row({
        to_email: "sent-customer@example.test",
        status: "sent",
        provider_message_id: "prov_abc123",
        sent_at: "2026-01-04T00:05:00Z",
      }),
    ])
    const [email] = await listAllOutbox(env)
    expect(email?.to).toBe("sent-customer@example.test")
    expect(email?.status).toBe("sent")
    expect(email?.providerMessageId).toBe("prov_abc123")
    expect(email?.sentAt).toBe("2026-01-04T00:05:00Z")
  })

  it("maps a failed row's attempts and raw last_error straight through, unredacted", async () => {
    const env = dbWithRows([
      row({
        to_email: "failed-customer@example.test",
        status: "failed",
        attempts: 3,
        last_error: "Resend API returned 401",
      }),
    ])
    const [email] = await listAllOutbox(env)
    expect(email?.status).toBe("failed")
    expect(email?.attempts).toBe(3)
    // The whole point of issue #55: `src/routes/deliveries.ts` renders this
    // verbatim, unlike `src/routes/outbox.ts`'s customer-safe substitution —
    // and that separation only means something if this module hands back the
    // raw value to both readers alike.
    expect(email?.lastError).toBe("Resend API returned 401")
  })
})
