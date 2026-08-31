import { describe, expect, it } from "vitest"
import {
  decideRoute,
  extractPlusAddressReference,
  findQuotedReference,
  routeInboundMessage,
  type InboundRoutingMessage,
  type RoutingCandidate,
  type RoutingLookup,
} from "../src/inboundRouter"
import type { Env } from "../src/types"

/**
 * Unit coverage for issue #163 (EM-3): the inbound router.
 *
 * Two layers, tested two different ways, per `src/inboundRouter.ts`'s own
 * top comment:
 *
 *  - `decideRoute` is pure — every rung of the ladder, exhaustively, with
 *    hand-built `RoutingLookup` fixtures and no database at all. This is
 *    almost all of this file, and it is what #163 means by "unit-tested
 *    exhaustively with no database."
 *  - `routeInboundMessage` is the async shell that actually reads
 *    `clients`/`projects`/`submissions` — covered by a small number of
 *    integration-style cases against a minimal in-memory D1 fake, just
 *    enough to prove the wiring (a plus-address, a `cc_emails` match) is
 *    correct. This module reads nothing else; there is no write path to
 *    verify.
 *
 * Every address, subject, body and name below is invented on the reserved
 * `example.test` TLD (RFC 6761) — CLAUDE.md rule 1: no customer material in
 * git, ever, in this public repo.
 */

// ── Fixtures for the pure core ──────────────────────────────────────────────

function message(overrides: Partial<InboundRoutingMessage> = {}): InboundRoutingMessage {
  return {
    fromEmail: "customer@example.test",
    toEmail: "intake@mail.example.test",
    subject: "A question about my project",
    bodyText: "Just checking in on this.",
    authResult: "pass",
    ...overrides,
  }
}

function candidate(overrides: Partial<RoutingCandidate> = {}): RoutingCandidate {
  return {
    projectId: "proj_aaaaaaaaaaaa",
    projectName: "Website refresh",
    submissionId: "sub_aaaaaaaaaaaa",
    submissionReference: "SUB-AAAAAA",
    status: "in-progress",
    createdAt: "2026-01-01T00:00:00.000Z",
    clientId: "client_aaaaaaaaaaaa",
    ...overrides,
  }
}

function lookup(overrides: Partial<RoutingLookup> = {}): RoutingLookup {
  return {
    plusAddressSubmission: null,
    quotedReference: null,
    matchedClientId: null,
    matchedClientVia: null,
    clientProjectCount: 0,
    clientProjectCandidates: [],
    historyCandidates: [],
    ...overrides,
  }
}

// ── Rung 1 — the address it was delivered to ────────────────────────────────

describe("decideRoute — rung 1 (plus-address)", () => {
  it("matches on the plus-address alone, beating a contradictory sender identity", () => {
    const target = candidate({ submissionReference: "SUB-C467AA", clientId: "client_real" })
    const decision = decideRoute(
      message({ fromEmail: "someone-else@unrelated.test", authResult: "fail" }),
      lookup({
        plusAddressSubmission: target,
        // Even a client match that would otherwise win at rung 3/4 must lose to rung 1.
        matchedClientId: "client_wrong",
        matchedClientVia: "email",
        clientProjectCount: 1,
        clientProjectCandidates: [candidate({ clientId: "client_wrong" })],
      }),
    )
    expect(decision.kind).toBe("message")
    expect(decision.rung).toBe(1)
    expect(decision.target?.submissionReference).toBe("SUB-C467AA")
    expect(decision.target?.clientId).toBe("client_real")
    expect(decision.runnerUp).toBeNull()
  })
})

// ── Rung 2 — a reference quoted in the subject or body ──────────────────────

describe("decideRoute — rung 2 (quoted reference)", () => {
  it("matches a quoted SUB- reference that resolves to a real submission", () => {
    const target = candidate({ submissionReference: "SUB-BBBBBB" })
    const decision = decideRoute(
      message(),
      lookup({ quotedReference: { kind: "SUB", token: "SUB-BBBBBB", submission: target } }),
    )
    expect(decision.kind).toBe("message")
    expect(decision.rung).toBe(2)
    expect(decision.target?.submissionReference).toBe("SUB-BBBBBB")
  })

  it("treats a quoted LEAD- reference as a lead, without resolving it", () => {
    const decision = decideRoute(message(), lookup({ quotedReference: { kind: "LEAD", token: "LEAD-C467AA" } }))
    expect(decision.kind).toBe("lead")
    expect(decision.rung).toBe(2)
    expect(decision.reason).toContain("LEAD-C467AA")
    expect(decision.target).toBeNull()
  })

  it("falls through when the quoted SUB- reference names nothing real, to a clean lead when nothing else matches either", () => {
    // Issue #164 (EM-4): with no client match and no history, there is no
    // identity here for a spoofed `From:` to steal, so an unresolvable
    // reference and a failed DMARC check both fall straight through to rung
    // 6's `lead` outcome, not `unrouted` — DMARC only ever parks a message as
    // `unrouted` when there is an actual client/history match it could be
    // spoofing.
    const decision = decideRoute(
      message({ authResult: "fail" }),
      lookup({ quotedReference: { kind: "SUB", token: "SUB-DEADBE", submission: null } }),
    )
    expect(decision.kind).toBe("lead")
    expect(decision.rung).toBe(6)
  })

  it("does not require a DMARC pass — the reference is its own proof", () => {
    const target = candidate({ submissionReference: "SUB-CCCCCC" })
    const decision = decideRoute(
      message({ authResult: "fail" }),
      lookup({ quotedReference: { kind: "SUB", token: "SUB-CCCCCC", submission: target } }),
    )
    expect(decision.kind).toBe("message")
    expect(decision.rung).toBe(2)
  })
})

// ── The DMARC gate on rungs 3–5 ─────────────────────────────────────────────

describe("decideRoute — the DMARC gate", () => {
  it("falls to rung 6 as unrouted for a DMARC-fail message from a known client's own address, rather than matching them", () => {
    const decision = decideRoute(
      message({ fromEmail: "known@example.test", authResult: "fail" }),
      lookup({
        matchedClientId: "client_known",
        matchedClientVia: "email",
        clientProjectCount: 1,
        clientProjectCandidates: [candidate({ clientId: "client_known" })],
      }),
    )
    expect(decision.kind).toBe("unrouted")
    expect(decision.rung).toBe(6)
    expect(decision.target).toBeNull()
  })

  it("also gates on a DMARC verdict of 'none', not only 'fail'", () => {
    const decision = decideRoute(
      message({ authResult: "none" }),
      lookup({
        matchedClientId: "client_known",
        matchedClientVia: "email",
        clientProjectCount: 1,
        clientProjectCandidates: [candidate()],
      }),
    )
    expect(decision.kind).toBe("unrouted")
    expect(decision.rung).toBe(6)
  })
})

// ── Rung 3 — a known client with one project ────────────────────────────────

describe("decideRoute — rung 3 (one-project client)", () => {
  it("matches the client's only project", () => {
    const target = candidate({ submissionReference: "SUB-ONLYME" })
    const decision = decideRoute(
      message(),
      lookup({
        matchedClientId: "client_x",
        matchedClientVia: "email",
        clientProjectCount: 1,
        clientProjectCandidates: [target],
      }),
    )
    expect(decision.kind).toBe("message")
    expect(decision.rung).toBe(3)
    expect(decision.target?.submissionReference).toBe("SUB-ONLYME")
    expect(decision.runnerUp).toBeNull()
  })

  it("records a cc_emails match in the reason text", () => {
    const decision = decideRoute(
      message(),
      lookup({
        matchedClientId: "client_x",
        matchedClientVia: "cc",
        clientProjectCount: 1,
        clientProjectCandidates: [candidate()],
      }),
    )
    expect(decision.reason).toContain("cc_emails")
  })

  it("falls to rung 6 unrouted when the client's only project has no submission yet", () => {
    const decision = decideRoute(
      message(),
      lookup({ matchedClientId: "client_x", matchedClientVia: "email", clientProjectCount: 1, clientProjectCandidates: [] }),
    )
    expect(decision.kind).toBe("unrouted")
    expect(decision.rung).toBe(6)
  })

  it("falls to rung 6 unrouted when the known client has no project at all", () => {
    const decision = decideRoute(
      message(),
      lookup({ matchedClientId: "client_x", matchedClientVia: "email", clientProjectCount: 0 }),
    )
    expect(decision.kind).toBe("unrouted")
    expect(decision.rung).toBe(6)
  })
})

// ── Rung 4 — a known client with several projects ───────────────────────────

describe("decideRoute — rung 4 (several-project client scoring)", () => {
  it("a project awaiting sign-off beats one that is not, regardless of recency", () => {
    const waiting = candidate({
      projectId: "proj_waiting",
      submissionReference: "SUB-WAITING",
      status: "awaiting-signoff",
      createdAt: "2020-01-01T00:00:00.000Z",
    })
    const busy = candidate({
      projectId: "proj_busy",
      submissionReference: "SUB-BUSY",
      status: "in-progress",
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    const decision = decideRoute(
      message(),
      lookup({
        matchedClientId: "client_x",
        matchedClientVia: "email",
        clientProjectCount: 2,
        clientProjectCandidates: [busy, waiting],
      }),
    )
    expect(decision.kind).toBe("message")
    expect(decision.rung).toBe(4)
    expect(decision.target?.submissionReference).toBe("SUB-WAITING")
    expect(decision.runnerUp?.submissionReference).toBe("SUB-BUSY")
  })

  it("does not repeat the reference in the runner-up reason when the runner-up has no project name", () => {
    const waiting = candidate({
      projectId: "proj_waiting",
      projectName: "Website refresh",
      submissionReference: "SUB-WAITING",
      status: "awaiting-signoff",
      createdAt: "2020-01-01T00:00:00.000Z",
    })
    // A one-off request with no project (`projectId`/`projectName` both
    // `null`) — `describeCandidate` renders this as `submission SUB-XXXXXX`,
    // which already IS the reference; the runner-up reason must not append
    // `(SUB-XXXXXX)` a second time.
    const busy = candidate({
      projectId: null,
      projectName: null,
      submissionReference: "SUB-BUSY",
      status: "in-progress",
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    const decision = decideRoute(
      message(),
      lookup({
        matchedClientId: "client_x",
        matchedClientVia: "email",
        clientProjectCount: 2,
        clientProjectCandidates: [busy, waiting],
      }),
    )
    expect(decision.runnerUp?.reason).toBe("Also scored, but not picked: submission SUB-BUSY.")
    expect(decision.runnerUp?.reason).not.toContain("(SUB-BUSY)")
  })

  it("falls back to most recent activity when both are equally waiting on the customer", () => {
    const older = candidate({ submissionReference: "SUB-OLDER", status: "needs-input", createdAt: "2020-01-01T00:00:00.000Z" })
    const newer = candidate({ submissionReference: "SUB-NEWER", status: "quality-check", createdAt: "2026-01-01T00:00:00.000Z" })
    const decision = decideRoute(
      message(),
      lookup({
        matchedClientId: "client_x",
        matchedClientVia: "email",
        clientProjectCount: 2,
        clientProjectCandidates: [older, newer],
      }),
    )
    expect(decision.target?.submissionReference).toBe("SUB-NEWER")
  })

  it("falls back to subject/name word overlap as the last criterion", () => {
    const sameTime = "2026-01-01T00:00:00.000Z"
    const unrelated = candidate({
      projectId: "proj_unrelated",
      projectName: "Marketing site",
      submissionReference: "SUB-UNRELATED",
      status: "in-progress",
      createdAt: sameTime,
    })
    const matching = candidate({
      projectId: "proj_matching",
      projectName: "Checkout redesign",
      submissionReference: "SUB-MATCHING",
      status: "in-progress",
      createdAt: sameTime,
    })
    const decision = decideRoute(
      message({ subject: "Update on the checkout redesign" }),
      lookup({
        matchedClientId: "client_x",
        matchedClientVia: "email",
        clientProjectCount: 2,
        clientProjectCandidates: [unrelated, matching],
      }),
    )
    expect(decision.target?.submissionReference).toBe("SUB-MATCHING")
  })

  it("an exact tie falls to rung 6 as unrouted, not to a coin-flip winner", () => {
    const a = candidate({ projectId: "proj_a", submissionReference: "SUB-TIEA" })
    const b = candidate({ projectId: "proj_b", submissionReference: "SUB-TIEB" })
    const decision = decideRoute(
      message(),
      lookup({
        matchedClientId: "client_x",
        matchedClientVia: "email",
        clientProjectCount: 2,
        clientProjectCandidates: [a, b],
      }),
    )
    expect(decision.kind).toBe("unrouted")
    expect(decision.rung).toBe(6)
    expect(decision.target).toBeNull()
  })

  it("falls to rung 6 unrouted when none of several projects has a submission yet", () => {
    const decision = decideRoute(
      message(),
      lookup({ matchedClientId: "client_x", matchedClientVia: "email", clientProjectCount: 2, clientProjectCandidates: [] }),
    )
    expect(decision.kind).toBe("unrouted")
    expect(decision.rung).toBe(6)
  })
})

// ── Rung 5 — a returning sender with no clients row ─────────────────────────

describe("decideRoute — rung 5 (no clients row yet)", () => {
  it("matches a lone historical candidate", () => {
    const target = candidate({ submissionReference: "SUB-HISTORY", clientId: null })
    const decision = decideRoute(message(), lookup({ historyCandidates: [target] }))
    expect(decision.kind).toBe("message")
    expect(decision.rung).toBe(5)
    expect(decision.target?.submissionReference).toBe("SUB-HISTORY")
    expect(decision.target?.clientId).toBeNull()
  })

  it("applies rung 4's own scoring across several historical candidates", () => {
    const waiting = candidate({
      submissionReference: "SUB-HWAIT",
      status: "awaiting-signoff",
      createdAt: "2020-01-01T00:00:00.000Z",
      clientId: null,
    })
    const busy = candidate({ submissionReference: "SUB-HBUSY", status: "in-progress", createdAt: "2026-01-01T00:00:00.000Z", clientId: null })
    const decision = decideRoute(message(), lookup({ historyCandidates: [busy, waiting] }))
    expect(decision.rung).toBe(5)
    expect(decision.target?.submissionReference).toBe("SUB-HWAIT")
    expect(decision.runnerUp?.submissionReference).toBe("SUB-HBUSY")
  })

  it("an exact tie among historical candidates falls to rung 6 as unrouted", () => {
    const a = candidate({ submissionReference: "SUB-HTIEA", clientId: null })
    const b = candidate({ submissionReference: "SUB-HTIEB", clientId: null })
    const decision = decideRoute(message(), lookup({ historyCandidates: [a, b] }))
    expect(decision.kind).toBe("unrouted")
    expect(decision.rung).toBe(6)
  })
})

// ── Rung 6 — the safe default ───────────────────────────────────────────────

describe("decideRoute — rung 6 (default)", () => {
  it("is a clean lead when nobody we know sent it", () => {
    const decision = decideRoute(message(), lookup())
    expect(decision.kind).toBe("lead")
    expect(decision.rung).toBe(6)
    expect(decision.target).toBeNull()
    expect(decision.runnerUp).toBeNull()
  })

  /**
   * Issue #164 (EM-4): the DMARC gate on rungs 3–5 must not reach a genuine
   * stranger at all. `decideRoute — the DMARC gate` above already covers the
   * case where DMARC fails *and* there is a client/history match (parks as
   * `unrouted`); these two cover the case this contract's own amendment adds
   * — no match of any kind, so there is no identity for a spoofed `From:` to
   * steal, and "auth_result is irrelevant to which rung a genuine stranger's
   * message reaches."
   */
  it("is still a clean lead when DMARC fails outright and nobody matches", () => {
    const decision = decideRoute(message({ authResult: "fail" }), lookup())
    expect(decision.kind).toBe("lead")
    expect(decision.rung).toBe(6)
  })

  it("is still a clean lead when there is no DMARC evidence at all and nobody matches", () => {
    const decision = decideRoute(message({ authResult: "none" }), lookup())
    expect(decision.kind).toBe("lead")
    expect(decision.rung).toBe(6)
  })
})

// ── Extraction helpers — pure, no database ──────────────────────────────────

describe("extractPlusAddressReference", () => {
  it("reads a SUB- token out of the plus-address", () => {
    expect(extractPlusAddressReference("intake+SUB-C467AA@mail.example.test")).toEqual({
      kind: "SUB",
      token: "SUB-C467AA",
    })
  })

  it("normalises a lower-case token to upper-case", () => {
    expect(extractPlusAddressReference("intake+sub-c467aa@mail.example.test")).toEqual({
      kind: "SUB",
      token: "SUB-C467AA",
    })
  })

  it("is null with no plus-address at all", () => {
    expect(extractPlusAddressReference("intake@mail.example.test")).toBeNull()
  })

  it("is null when the address does not deliver a submission's own address", () => {
    expect(extractPlusAddressReference("intake+LEAD-C467AA@mail.example.test")).toBeNull()
  })

  it("is null when the plus-address is garbled", () => {
    expect(extractPlusAddressReference("intake+not-a-reference@mail.example.test")).toBeNull()
    expect(extractPlusAddressReference("intake+SUB-C467AAX@mail.example.test")).toBeNull()
  })
})

describe("findQuotedReference", () => {
  it("prefers the subject over the body", () => {
    expect(findQuotedReference("Re: SUB-111111", "Quoting LEAD-222222 below")).toEqual({
      kind: "SUB",
      token: "SUB-111111",
    })
  })

  it("finds a reference in the quoted original further down the body", () => {
    const body = [
      "Thanks, that works for me!",
      "",
      "On Mon, a customer wrote:",
      "> Re: your submission LEAD-C467AA",
      "> looking forward to hearing back",
    ].join("\n")
    expect(findQuotedReference("Re: my question", body)).toEqual({ kind: "LEAD", token: "LEAD-C467AA" })
  })

  it("is null when neither text carries a reference", () => {
    expect(findQuotedReference("Just checking in", "No reference here either")).toBeNull()
  })

  it("normalises a lower-case quoted reference to upper-case", () => {
    expect(findQuotedReference("re: sub-abcdef", "")).toEqual({ kind: "SUB", token: "SUB-ABCDEF" })
  })
})

// ── The async shell — a minimal in-memory D1 fake, just enough to prove the wiring ──

interface FakeClientRow {
  id: string
  email: string
  cc_emails: string | null
  created_at: string
}

interface FakeProjectRow {
  id: string
  customer_email: string | null
  client_id: string | null
  created_at: string
  name: string | null
}

interface FakeSubmissionRow {
  id: string
  reference: string
  status: string
  customer_email: string | null
  outcome: string
  audience: string
  done_definition: string
  constraints: string | null
  project_scope: string | null
  project_id: string | null
  created_at: string
  coord_revision: number | null
  preview_url: string | null
}

function submissionRow(overrides: Partial<FakeSubmissionRow> = {}): FakeSubmissionRow {
  return {
    id: "sub_zzzzzzzzzzzz",
    reference: "SUB-ZZZZZZ",
    status: "in-progress",
    customer_email: "customer@example.test",
    outcome: "A synthetic outcome for testing.",
    audience: "Internal testers.",
    done_definition: "The test passes.",
    constraints: null,
    project_scope: null,
    project_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    coord_revision: null,
    preview_url: null,
    ...overrides,
  }
}

/**
 * A fake `Env["DB"]` recognising exactly the read-only statements
 * `src/inboundRouter.ts` can issue via `clients.ts`/`projects.ts`/
 * `submissions.ts` — an unrecognised statement throws rather than silently
 * returning nothing, the same convention `test/inboundEmail.test.ts`'s own
 * fake uses.
 */
function fakeRouterEnv(data: { clients?: FakeClientRow[]; projects?: FakeProjectRow[]; submissions?: FakeSubmissionRow[] }): Env {
  const clients = data.clients ?? []
  const projects = data.projects ?? []
  const submissions = data.submissions ?? []
  const norm = (sql: string) => sql.replace(/\s+/g, " ").trim()
  const byCreatedAtDesc = <T extends { created_at: string }>(rows: T[]) =>
    [...rows].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))

  const DB = {
    prepare(sql: string) {
      const statement = norm(sql)
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>(): Promise<T | null> {
              if (statement.startsWith("SELECT * FROM submissions WHERE reference = ?")) {
                return (submissions.find((s) => s.reference === args[0]) as T | undefined) ?? null
              }
              if (statement.startsWith("SELECT id, email, created_at FROM clients WHERE lower(email) = lower(?)")) {
                const email = String(args[0]).toLowerCase()
                const row = clients.find((c) => c.email.toLowerCase() === email)
                return (row ? { id: row.id, email: row.email, created_at: row.created_at } : null) as T | null
              }
              if (statement.includes("cc_emails IS NOT NULL")) {
                const email = String(args[0]).toLowerCase()
                const row = clients.find((c) => {
                  if (!c.cc_emails) return false
                  const list = c.cc_emails.toLowerCase().replace(/\s+/g, "").split(",")
                  return list.includes(email)
                })
                return (row ? { id: row.id, email: row.email, created_at: row.created_at } : null) as T | null
              }
              if (statement.startsWith("SELECT * FROM submissions WHERE project_id = ?") && statement.includes("LIMIT 1")) {
                const rows = byCreatedAtDesc(submissions.filter((s) => s.project_id === args[0]))
                return (rows[0] as T | undefined) ?? null
              }
              if (statement.startsWith("SELECT * FROM projects WHERE id = ?")) {
                return (projects.find((p) => p.id === args[0]) as T | undefined) ?? null
              }
              throw new Error(`fakeRouterEnv: unrecognized first() statement: ${statement}`)
            },
            async all<T>(): Promise<{ results: T[] }> {
              if (statement.startsWith("SELECT * FROM projects WHERE client_id = ?")) {
                return { results: byCreatedAtDesc(projects.filter((p) => p.client_id === args[0])) as T[] }
              }
              if (statement.startsWith("SELECT * FROM submissions WHERE customer_email = ?")) {
                return { results: byCreatedAtDesc(submissions.filter((s) => s.customer_email === args[0])) as T[] }
              }
              if (statement.startsWith("SELECT * FROM projects WHERE id IN")) {
                return { results: projects.filter((p) => args.includes(p.id)) as T[] }
              }
              throw new Error(`fakeRouterEnv: unrecognized all() statement: ${statement}`)
            },
          }
        },
      }
    },
  }

  return { DB } as unknown as Env
}

describe("routeInboundMessage — the async shell", () => {
  it("resolves rung 1 through a real getSubmissionByReference lookup", async () => {
    const env = fakeRouterEnv({
      submissions: [submissionRow({ id: "sub_1", reference: "SUB-C467AA", project_id: null })],
    })
    const decision = await routeInboundMessage(env, message({ toEmail: "intake+SUB-C467AA@mail.example.test" }))
    expect(decision.kind).toBe("message")
    expect(decision.rung).toBe(1)
    expect(decision.target?.submissionReference).toBe("SUB-C467AA")
  })

  it("resolves rung 3 through a real cc_emails match", async () => {
    const env = fakeRouterEnv({
      clients: [{ id: "client_1", email: "primary@example.test", cc_emails: "assistant@example.test", created_at: "2025-01-01T00:00:00.000Z" }],
      projects: [{ id: "proj_1", customer_email: "primary@example.test", client_id: "client_1", created_at: "2025-01-01T00:00:00.000Z", name: "Storefront" }],
      submissions: [submissionRow({ id: "sub_1", reference: "SUB-CCMATCH", project_id: "proj_1", customer_email: "primary@example.test" })],
    })
    const decision = await routeInboundMessage(env, message({ fromEmail: "assistant@example.test" }))
    expect(decision.kind).toBe("message")
    expect(decision.rung).toBe(3)
    expect(decision.target?.submissionReference).toBe("SUB-CCMATCH")
    expect(decision.target?.clientId).toBe("client_1")
  })

  it("is a clean lead for a first-time, unauthenticated-but-passing sender with no history", async () => {
    const env = fakeRouterEnv({})
    const decision = await routeInboundMessage(env, message({ fromEmail: "stranger@example.test" }))
    expect(decision.kind).toBe("lead")
    expect(decision.rung).toBe(6)
  })
})
