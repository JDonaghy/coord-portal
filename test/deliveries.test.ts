import { describe, expect, it } from "vitest"

import { deliveries } from "../src/routes/deliveries"
import { DEV_OPERATOR_EMAIL } from "../src/operators"
import type { Env } from "../src/types"

/**
 * Unit coverage for `GET /deliveries` (issue #55, `src/routes/deliveries.ts`)
 * — the operator's counterpart to `/outbox`, gated by `readOperator` rather
 * than by row ownership.
 *
 * `e2e/deliveries.spec.ts` drives this route black-box against a real running
 * Worker and real D1 (per CLAUDE.md's testing tiers, that is the acceptance
 * bar, not this file) — it seeds rows for two real customers across all three
 * delivery states, reads the operator gate's 404 back over real HTTP, and
 * checks the raw-vs-customer-safe `last_error` split on the same row through
 * `/outbox` too.
 *
 * What that file structurally CANNOT cover is the empty-list branch
 * (`deliveries-list-empty`, contract § "The operator delivery view": "present
 * instead, if and only if there are zero `outbox` rows across every
 * customer"). `serve:test` never wipes `.wrangler/state` between runs (see
 * `e2e/notifications.spec.ts`'s own note) and this suite's other specs seed
 * outbox rows freely, so there is no point in a real e2e run — local or
 * CI — at which the table is guaranteed globally empty. The sealed acceptance
 * suite records exactly the same gap for this route
 * (`tests/acceptance/ms-3/55-operator-deliveries.spec.ts`'s own TODO) and for
 * `/leads`' identical `leads-list-empty` before it
 * (`tests/acceptance/ms-2/33-lead-triage-promotion.spec.ts`). A fake `DB` that
 * simply answers zero rows is the one place this branch is reachable at all,
 * so it is pinned here rather than left with no coverage anywhere.
 *
 * The operator gate itself (`readOperator`) already has its own exhaustive
 * unit coverage in `test/operators.test.ts` — allowlist parsing, the
 * behind-the-edge fail-closed case, the dev-operator fallback, case
 * insensitivity. This file does not re-litigate any of that; it only checks
 * that this route actually calls it and does the right thing with `null` vs
 * an `Operator`, the same way `e2e/leads.spec.ts` checks `src/routes/leads.ts`
 * does.
 *
 * Every address and string below is invented — CLAUDE.md rule 1.
 */

function outboxRow(overrides: Record<string, unknown> = {}) {
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

/** A fake D1 answering `listAllOutbox`'s unscoped `SELECT * FROM outbox …` with fixed rows. */
function envWithRows(results: unknown[]): Env {
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

function requestAs(email: string | null, headers: Record<string, string> = {}): Request {
  return new Request("https://portal.test/deliveries", {
    headers: email ? { "Cf-Access-Authenticated-User-Email": email, ...headers } : headers,
  })
}

describe("GET /deliveries", () => {
  it("is the same indistinguishable 404 leadsNotFound() returns, for an anonymous caller and for an ordinary customer alike", async () => {
    const env = envWithRows([
      outboxRow({ to_email: "customer@example.test", subject: "Should never render for a non-operator" }),
    ])

    for (const request of [requestAs(null), requestAs("customer@example.test")]) {
      const response = await deliveries(request, env)
      expect(response.status).toBe(404)
      const body = await response.text()
      // leadsNotFound()'s own copy — deliberately customer-facing, not
      // operator-shaped, so a stranger who guesses the URL learns nothing.
      expect(body).toContain("We can't find that")
      expect(body).not.toContain("Should never render for a non-operator")
      expect(body).not.toContain("customer@example.test")
    }
  })

  it("renders every row, unscoped across customers, for the dev operator identity", async () => {
    const env = envWithRows([
      outboxRow({ id: "ntf_1", to_email: "alice@example.test", subject: "Alice's send" }),
      outboxRow({ id: "ntf_2", to_email: "bob@example.test", subject: "Bob's send" }),
    ])

    const response = await deliveries(requestAs(DEV_OPERATOR_EMAIL), env)
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('data-testid="deliveries-list"')
    expect(body).not.toContain('data-testid="deliveries-list-empty"')
    expect(body).toContain("alice@example.test")
    expect(body).toContain("bob@example.test")
    // The operator topbar (issue #55's own "reuse the /leads precedent"), not
    // the customer topbar — and marked as the current screen.
    expect(body).toContain(`signed in as ${DEV_OPERATOR_EMAIL}`)
    expect(body).toContain('data-testid="nav-deliveries" aria-current="page"')
  })

  it("renders deliveries-list-empty — and never deliveries-list — when the outbox has zero rows across every customer", async () => {
    // The branch e2e/acceptance both record as structurally unreachable
    // end-to-end: see this file's module comment. Pinned here so a typo'd
    // data-testid or a broken `rows.length > 0` conditional does not ship
    // silently.
    const env = envWithRows([])

    const response = await deliveries(requestAs(DEV_OPERATOR_EMAIL), env)
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('data-testid="deliveries-list-empty"')
    expect(body).not.toContain('data-testid="deliveries-list"')
  })

  it("shows a failed row's raw provider error verbatim — the one thing /outbox may not render", async () => {
    const env = envWithRows([
      outboxRow({
        status: "failed",
        attempts: 3,
        last_error: "Resend API returned 401",
      }),
    ])

    const response = await deliveries(requestAs(DEV_OPERATOR_EMAIL), env)
    const body = await response.text()
    expect(body).toContain("Resend API returned 401")
  })

  it("404s behind Cloudflare's edge when no OPERATOR_EMAILS is configured, same fail-closed default readOperator always takes", async () => {
    const env = envWithRows([outboxRow()])
    const request = requestAs(DEV_OPERATOR_EMAIL, { "CF-Ray": "8f0000000000abcd-LHR" })

    const response = await deliveries(request, env)
    expect(response.status).toBe(404)
  })
})
